import { describe, expect, it } from "vitest";
import {
  accountFromIdToken,
  GoogleOAuthClient,
  MicrosoftOAuthClient,
  pkcePair,
} from "../../src/providers/oauth.js";
import { ProviderManager } from "../../src/providers/manager.js";
import { ConnectionStore } from "../../src/providers/token-store.js";
import { loadConfig } from "../../src/core/config.js";
import { AppError } from "../../src/core/errors.js";
import { testConfig } from "../helpers/fixtures.js";

describe("OAuth URL construction", () => {
  it("builds a Google authorization URL with PKCE, state, offline access, and exact redirect", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThan(40);
    expect(challenge).not.toBe(verifier);
    const url = new URL(
      new GoogleOAuthClient().buildAuthorizeUrl({
        credentials: { clientId: "client-id" },
        redirectUri: "http://127.0.0.1:4310/auth/gmail/callback",
        scopes: "https://www.googleapis.com/auth/gmail.readonly",
        state: "state-value",
        codeChallenge: challenge,
      }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4310/auth/gmail/callback");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("builds a Microsoft authorization URL for the configured tenant", () => {
    const url = new URL(
      new MicrosoftOAuthClient("contoso.example").buildAuthorizeUrl({
        credentials: { clientId: "client-id" },
        redirectUri: "http://127.0.0.1:4310/auth/microsoft/callback",
        scopes: "offline_access openid profile email Mail.Read",
        state: "state-value",
        codeChallenge: "challenge",
      }),
    );
    expect(url.hostname).toBe("login.microsoftonline.com");
    expect(url.pathname).toBe("/contoso.example/oauth2/v2.0/authorize");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("Mail.Read");
  });

  it("extracts a display identity from an id_token without trusting extra fields", () => {
    const payload = Buffer.from(
      JSON.stringify({ preferred_username: "user@example.com", upn: "other@example.com" }),
    ).toString("base64url");
    expect(accountFromIdToken(`header.${payload}.signature`)).toBe("user@example.com");
    expect(accountFromIdToken("not-a-token")).toBeNull();
    expect(accountFromIdToken(null)).toBeNull();
  });
});

describe("provider manager without live credentials", () => {
  it("reports both providers as unconfigured and does not expose tokens", () => {
    const manager = new ProviderManager(testConfig(), new ConnectionStore());
    const statuses = manager.status("session");
    expect(statuses.map((status) => status.provider)).toEqual(["gmail", "microsoft"]);
    expect(statuses.every((status) => status.configured === false)).toBe(true);
    expect(JSON.stringify(statuses)).not.toMatch(/accessToken|refreshToken|clientSecret/);
  });

  it("refuses to begin authorization when the client is unconfigured", () => {
    const manager = new ProviderManager(testConfig(), new ConnectionStore());
    expect(() => manager.beginAuth("session", "gmail", "readonly")).toThrow(AppError);
  });

  it("uses read-only and cleanup scopes appropriately when configured", () => {
    const config = testConfig({
      google: { clientId: "google-client", clientSecret: null },
      microsoft: { clientId: "ms-client", clientSecret: null, tenant: "common" },
    });
    const manager = new ProviderManager(config, new ConnectionStore());
    const readonly = new URL(manager.beginAuth("session", "gmail", "readonly").authorizeUrl);
    expect(readonly.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    const cleanup = new URL(manager.beginAuth("session", "gmail", "cleanup").authorizeUrl);
    expect(cleanup.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify");
    const microsoft = new URL(manager.beginAuth("session", "microsoft", "cleanup").authorizeUrl);
    expect(microsoft.searchParams.get("scope")).toContain("Mail.ReadWrite");
    expect(microsoft.searchParams.get("scope")).toContain("offline_access");
  });

  it("does not return an authorize URL for an invalid callback completion", async () => {
    const config = testConfig({ google: { clientId: "google-client", clientSecret: null } });
    const manager = new ProviderManager(config, new ConnectionStore());
    await expect(manager.completeAuth("session", "gmail", "code", "unknown-state")).rejects.toThrow(
      /unknown or expired/i,
    );
  });
});

describe("connection store bounds and deletion", () => {
  it("deletes by provider and session without touching other sessions", () => {
    const store = new ConnectionStore(10);
    const tokens = { accessToken: "a", refreshToken: "r", expiresAt: 0, scope: "", idToken: null };
    store.set("s1", "gmail", {
      provider: "gmail",
      mode: "readonly",
      account: "a@example.com",
      connectedAt: 1,
      connectionId: "conn-a",
      tokens,
    });
    store.set("s1", "microsoft", {
      provider: "microsoft",
      mode: "cleanup",
      account: "b@example.com",
      connectedAt: 1,
      connectionId: "conn-b",
      tokens,
    });
    store.set("s2", "gmail", {
      provider: "gmail",
      mode: "readonly",
      account: "c@example.com",
      connectedAt: 1,
      connectionId: "conn-c",
      tokens,
    });
    expect(store.size()).toBe(3);
    store.delete("s1", "gmail");
    expect(store.get("s1", "gmail")).toBeUndefined();
    expect(store.get("s1", "microsoft")).toBeDefined();
    expect(store.get("s2", "gmail")).toBeDefined();
    store.deleteSession("s1");
    expect(store.get("s1", "microsoft")).toBeUndefined();
    expect(store.get("s2", "gmail")).toBeDefined();
  });
});

describe("configuration validation", () => {
  it("uses loopback-safe defaults", () => {
    const config = loadConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.baseUrl).toBe("http://127.0.0.1:4310");
    expect(config.planTtlMs).toBe(20 * 60 * 1000);
  });

  it("rejects a non-loopback plain-HTTP base URL", () => {
    expect(() => loadConfig({ MAILSENTRY_BASE_URL: "http://mail.example.com" })).toThrow(/loopback/i);
  });

  it("rejects a non-loopback bind without explicit opt-in", () => {
    expect(() => loadConfig({ MAILSENTRY_HOST: "0.0.0.0" })).toThrow(/loopback|nonlocal/i);
    expect(loadConfig({ MAILSENTRY_HOST: "0.0.0.0", MAILSENTRY_ALLOW_NONLOCAL: "true" }).host).toBe(
      "0.0.0.0",
    );
  });

  it("rejects invalid ports and schemes", () => {
    expect(() => loadConfig({ PORT: "99999" })).toThrow(AppError);
    expect(() => loadConfig({ MAILSENTRY_BASE_URL: "ftp://127.0.0.1:4310" })).toThrow(/http or https/i);
    expect(() => loadConfig({ MAILSENTRY_BASE_URL: "http://127.0.0.1:4310/app" })).toThrow(/origin only/i);
    expect(() => loadConfig({ MAILSENTRY_BASE_URL: "http://127.0.0.1:4000" })).toThrow(/must match PORT/i);
  });

  it("reads provider configuration without exposing secret values in errors", () => {
    const config = loadConfig({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      MICROSOFT_CLIENT_ID: "ms-id",
      MICROSOFT_TENANT_ID: "contoso",
    });
    expect(config.google.clientId).toBe("id");
    expect(config.microsoft.tenant).toBe("contoso");
    expect(config.baseUrl).not.toContain("secret");
  });
});
