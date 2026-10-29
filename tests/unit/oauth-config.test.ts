import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountFromIdToken,
  GoogleOAuthClient,
  MicrosoftOAuthClient,
  pkcePair,
} from "../../src/providers/oauth.js";
import { ProviderManager } from "../../src/providers/manager.js";
import { ConnectionStore } from "../../src/providers/token-store.js";
import { assessScopes, hasScope, parseGrantedScopes } from "../../src/providers/scopes.js";
import { loadConfig, loadDotEnv } from "../../src/core/config.js";
import { AppError } from "../../src/core/errors.js";
import { testConfig } from "../helpers/fixtures.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OAuth URL construction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

describe("Google token exchange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the exact redirect URI and PKCE verifier with the client secret when configured", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
      jsonResponse({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { verifier } = pkcePair();
    const redirectUri = "http://127.0.0.1:4310/auth/gmail/callback";
    const tokens = await new GoogleOAuthClient().exchangeCode({
      credentials: { clientId: "desktop-client", clientSecret: "desktop-secret" },
      redirectUri,
      code: "authorization-code",
      codeVerifier: verifier,
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
    });

    expect(tokens.accessToken).toBe("access-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://oauth2.googleapis.com/token");
    expect(init?.method).toBe("POST");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("redirect_uri")).toBe(redirectUri);
    expect(body.get("client_id")).toBe("desktop-client");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("authorization-code");
    expect(body.get("code_verifier")).toBe(verifier);
    expect(body.get("client_secret")).toBe("desktop-secret");
  });

  it("omits client_secret when no secret is configured", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
      jsonResponse({ access_token: "access-token", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { verifier } = pkcePair();
    await new GoogleOAuthClient().exchangeCode({
      credentials: { clientId: "desktop-client" },
      redirectUri: "http://127.0.0.1:4310/auth/gmail/callback",
      code: "authorization-code",
      codeVerifier: verifier,
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
    });

    const body = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.get("client_id")).toBe("desktop-client");
    expect(body.has("client_secret")).toBe(false);
  });
});

describe("Google redirect URI round trip", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the authorization redirect URI unchanged for the token exchange", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly",
        });
      }
      if (url.includes("gmail.googleapis.com/gmail/v1/users/me/profile")) {
        return jsonResponse({ emailAddress: "user@example.com" });
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const manager = new ProviderManager(
      testConfig({ google: { clientId: "google-client", clientSecret: "desktop-secret" } }),
      new ConnectionStore(),
    );
    const started = manager.beginAuth("session", "gmail", "readonly");
    const authorizeUrl = new URL(started.authorizeUrl);
    const authorizeRedirect = authorizeUrl.searchParams.get("redirect_uri");
    const challenge = authorizeUrl.searchParams.get("code_challenge");
    expect(authorizeRedirect).toBe("http://127.0.0.1:4310/auth/gmail/callback");

    const result = await manager.completeAuth("gmail", "authorization-code", started.state);
    expect(result.account).toBe("user@example.com");

    const tokenCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === "https://oauth2.googleapis.com/token",
    );
    expect(tokenCall).toBeDefined();
    const body = new URLSearchParams(String(tokenCall?.[1]?.body));
    expect(body.get("redirect_uri")).toBe(authorizeRedirect);
    expect(body.get("client_id")).toBe("google-client");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_secret")).toBe("desktop-secret");
    const verifier = body.get("code_verifier") ?? "";
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
  });
});

describe("provider setup guidance", () => {
  it("does not ask Google Desktop users to register a redirect URI", () => {
    const manager = new ProviderManager(testConfig(), new ConnectionStore());
    const gmail = manager.setupHint("gmail");
    expect(gmail).toContain("Desktop app");
    expect(gmail).toMatch(/no redirect URI registration/i);
    expect(gmail).not.toMatch(/register \/auth\/gmail\/callback/i);
    expect(manager.setupHint("microsoft")).toContain("add the redirect URI /auth/microsoft/callback");
  });
});

describe("granted scope reporting", () => {
  it("parses token scope strings and compares provider URL and short forms", () => {
    const scopes = parseGrantedScopes("openid profile email https://graph.microsoft.com/Mail.ReadWrite");
    expect(scopes).toEqual(["openid", "profile", "email", "https://graph.microsoft.com/Mail.ReadWrite"]);
    expect(hasScope(scopes, "Mail.ReadWrite")).toBe(true);
    expect(hasScope(scopes, "https://graph.microsoft.com/Mail.Read")).toBe(false);
    expect(parseGrantedScopes("")).toEqual([]);
  });

  it("warns only when the provider reports scopes but the required one is missing", () => {
    const missing = assessScopes("gmail", "cleanup", "https://www.googleapis.com/auth/gmail.readonly");
    expect(missing.grantedScopes).toHaveLength(1);
    expect(missing.scopeWarning).toMatch(/gmail\.modify/);

    const unknown = assessScopes("gmail", "cleanup", "");
    expect(unknown.scopeWarning).toBeNull();

    const ok = assessScopes("microsoft", "cleanup", "profile Mail.ReadWrite");
    expect(ok.scopeWarning).toBeNull();
  });

  it("exposes granted scopes in provider status without tokens", () => {
    const store = new ConnectionStore();
    const tokens = {
      accessToken: "SECRET_ACCESS_TOKEN",
      refreshToken: "SECRET_REFRESH_TOKEN",
      expiresAt: Date.now() + 60_000,
      scope: "https://www.googleapis.com/auth/gmail.modify",
      idToken: null,
    };
    store.set("s1", "gmail", {
      provider: "gmail",
      mode: "cleanup",
      account: "user@example.com",
      connectedAt: Date.now(),
      connectionId: "conn",
      tokens,
    });
    const manager = new ProviderManager(testConfig(), store);
    const gmail = manager.status("s1").find((status) => status.provider === "gmail");
    expect(gmail?.grantedScopes).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);
    expect(gmail?.scopeWarning).toBeNull();
    expect(JSON.stringify(gmail)).not.toContain("SECRET_ACCESS_TOKEN");
    expect(JSON.stringify(gmail)).not.toContain("SECRET_REFRESH_TOKEN");
  });

  it("warns when a cleanup connection reports only read scopes", () => {
    const store = new ConnectionStore();
    store.set("s1", "microsoft", {
      provider: "microsoft",
      mode: "cleanup",
      account: "user@example.com",
      connectedAt: Date.now(),
      connectionId: "conn",
      tokens: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000,
        scope: "openid profile Mail.Read",
        idToken: null,
      },
    });
    const manager = new ProviderManager(testConfig(), store);
    const microsoft = manager.status("s1").find((status) => status.provider === "microsoft");
    expect(microsoft?.scopeWarning).toMatch(/Mail\.ReadWrite/);
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
    await expect(manager.completeAuth("gmail", "code", "unknown-state")).rejects.toThrow(
      /unknown or expired/i,
    );
  });
});

describe("OAuth state and PKCE", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function configuredManager() {
    return new ProviderManager(
      testConfig({ google: { clientId: "google-client", clientSecret: null } }),
      new ConnectionStore(),
    );
  }

  function startState(manager: ProviderManager): string {
    const url = new URL(manager.beginAuth("session", "gmail", "readonly").authorizeUrl);
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();
    return state as string;
  }

  it("generates a valid S256 PKCE challenge", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(challenge).not.toBe(verifier);
  });

  it("creates unique, URL-safe state values and a PKCE authorization URL", () => {
    const manager = configuredManager();
    const first = new URL(manager.beginAuth("session", "gmail", "readonly").authorizeUrl);
    const second = new URL(manager.beginAuth("session", "gmail", "readonly").authorizeUrl);
    const firstState = first.searchParams.get("state");
    const secondState = second.searchParams.get("state");
    expect(firstState).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(secondState).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(firstState).not.toBe(secondState);
    expect(first.searchParams.get("code_challenge_method")).toBe("S256");
    expect(first.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4310/auth/gmail/callback");
  });

  it("rejects missing and unknown state values", async () => {
    const manager = configuredManager();
    await expect(manager.completeAuth("gmail", "code", "")).rejects.toThrow(/unknown or expired/i);
    await expect(manager.completeAuth("gmail", "code", "not-a-real-state")).rejects.toThrow(
      /unknown or expired/i,
    );
  });

  it("rejects expired state values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
    const manager = configuredManager();
    const state = startState(manager);
    vi.setSystemTime(new Date("2026-10-29T12:11:00.000Z"));
    await expect(manager.completeAuth("gmail", "code", state)).rejects.toThrow(/unknown or expired/i);
  });

  it("consumes state before exchange and rejects replay", async () => {
    const manager = configuredManager();
    const state = startState(manager);
    await expect(manager.completeAuth("gmail", "", state)).rejects.toThrow(/code is missing/i);
    await expect(manager.completeAuth("gmail", "code", state)).rejects.toThrow(/unknown or expired/i);
  });

  it("consumes state on provider mismatch", async () => {
    const manager = configuredManager();
    const state = startState(manager);
    await expect(manager.completeAuth("microsoft", "code", state)).rejects.toThrow(/provider/i);
    await expect(manager.completeAuth("gmail", "code", state)).rejects.toThrow(/unknown or expired/i);
  });

  it("consumes state on a provider error callback", () => {
    const manager = configuredManager();
    const state = startState(manager);
    expect(manager.cancelAuth("gmail", state)).toBe(true);
    expect(manager.cancelAuth("gmail", state)).toBe(false);
    expect(manager.cancelAuth("gmail", "unknown-state")).toBe(false);
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
  it("loads .env from the project directory when present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mailsentry-env-"));
    const key = "MAILSENTRY_TEST_DOTENV_VALUE";
    const second = "MAILSENTRY_TEST_DOTENV_SECOND";
    const previous = process.env[key];
    const previousSecond = process.env[second];
    delete process.env[key];
    delete process.env[second];
    try {
      expect(loadDotEnv(dir)).toBeNull();
      await writeFile(join(dir, ".env"), `\uFEFF${key}=loaded-from-dotenv\n${second}=second-value\n`, "utf8");
      expect(loadDotEnv(dir)).toBe(join(dir, ".env"));
      expect(process.env[key]).toBe("loaded-from-dotenv");
      expect(process.env[second]).toBe("second-value");
    } finally {
      delete process.env[key];
      delete process.env[second];
      if (previous !== undefined) process.env[key] = previous;
      if (previousSecond !== undefined) process.env[second] = previousSecond;
      await rm(dir, { recursive: true, force: true });
    }
  });

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
