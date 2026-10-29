import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MailSentryApp } from "../../src/server/app.js";
import { testConfig } from "../helpers/fixtures.js";

let app: MailSentryApp;
let base = "";
let port = 0;
let openedUrl = "";

async function freePort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const value = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}

async function status(): Promise<{ csrf: string; cookie: string }> {
  const response = await fetch(`${base}/api/status`);
  const body = (await response.json()) as { csrfToken: string };
  const cookie = response.headers.get("set-cookie") ?? "";
  return { csrf: body.csrfToken, cookie: cookie.split(";")[0] ?? "" };
}

beforeAll(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = new MailSentryApp(
    testConfig({
      port,
      baseUrl: base,
      host: "127.0.0.1",
      google: { clientId: "desktop-test-client", clientSecret: null },
    }),
    process.cwd(),
    {
      desktopMode: true,
      openExternal: async (url) => {
        openedUrl = url;
      },
    },
  );
  await app.start();
});

afterAll(async () => {
  await app.stop();
});

describe("desktop OAuth start and callback", () => {
  it("opens the authorization URL externally without returning it to the renderer", async () => {
    const { csrf, cookie } = await status();
    const response = await fetch(`${base}/api/auth/gmail/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({ mode: "readonly" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      openedExternally?: boolean;
      authorizeUrl?: string;
      error?: unknown;
    };
    expect(body.openedExternally).toBe(true);
    expect(body.authorizeUrl).toBeUndefined();
    expect(body.error).toBeUndefined();

    const url = new URL(openedUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(url.searchParams.get("redirect_uri")).toBe(`${base}/auth/gmail/callback`);
  });

  it("handles callbacks without a session cookie and rejects replay", async () => {
    const opened = new URL(openedUrl);
    const state = opened.searchParams.get("state");
    expect(state).toBeTruthy();

    const missingCode = await fetch(`${base}/auth/gmail/callback?state=${encodeURIComponent(state ?? "")}`);
    expect(missingCode.status).toBe(400);
    expect(await missingCode.text()).toMatch(/code is missing/i);

    const replay = await fetch(
      `${base}/auth/gmail/callback?code=fake-code&state=${encodeURIComponent(state ?? "")}`,
    );
    expect(replay.status).toBe(400);
    expect(await replay.text()).toMatch(/unknown or expired/i);
  });

  it("rejects missing and unknown callback state without a cookie", async () => {
    const missing = await fetch(`${base}/auth/gmail/callback?code=fake-code`);
    expect(missing.status).toBe(400);
    expect(await missing.text()).toMatch(/unknown or expired/i);

    const unknown = await fetch(`${base}/auth/gmail/callback?code=fake-code&state=unknown-state`);
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toMatch(/unknown or expired/i);
  });

  it("consumes state on a provider error callback", async () => {
    const { csrf, cookie } = await status();
    const start = await fetch(`${base}/api/auth/gmail/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({ mode: "readonly" }),
    });
    expect(start.status).toBe(200);
    const started = new URL(openedUrl);
    const state = started.searchParams.get("state");
    expect(state).toBeTruthy();

    const denied = await fetch(
      `${base}/auth/gmail/callback?error=access_denied&error_description=cancelled&state=${encodeURIComponent(state ?? "")}`,
    );
    expect(denied.status).toBe(400);
    expect(await denied.text()).toMatch(/not completed/i);

    const replay = await fetch(
      `${base}/auth/gmail/callback?code=fake-code&state=${encodeURIComponent(state ?? "")}`,
    );
    expect(replay.status).toBe(400);
    expect(replay.headers.get("content-type")).toContain("text/html");
  });

  it("clears pending state when the system browser fails to open", async () => {
    let attemptedUrl = "";
    const failurePort = await freePort();
    const failureBase = `http://127.0.0.1:${failurePort}`;
    const failureApp = new MailSentryApp(
      testConfig({
        port: failurePort,
        baseUrl: failureBase,
        host: "127.0.0.1",
        google: { clientId: "desktop-test-client", clientSecret: null },
      }),
      process.cwd(),
      {
        desktopMode: true,
        openExternal: async (url) => {
          attemptedUrl = url;
          throw new Error("No default browser available.");
        },
      },
    );
    await failureApp.start();
    try {
      const statusResponse = await fetch(`${failureBase}/api/status`);
      const statusBody = (await statusResponse.json()) as { csrfToken: string };
      const cookie = (statusResponse.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const start = await fetch(`${failureBase}/api/auth/gmail/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          "x-csrf-token": statusBody.csrfToken,
        },
        body: JSON.stringify({ mode: "readonly" }),
      });
      expect(start.status).toBe(502);
      const errorBody = (await start.json()) as { error: { code: string; message: string } };
      expect(errorBody.error.code).toBe("PROVIDER_ERROR");
      expect(errorBody.error.message).toMatch(/system browser/i);

      const state = new URL(attemptedUrl).searchParams.get("state");
      expect(state).toBeTruthy();
      const callback = await fetch(
        `${failureBase}/auth/gmail/callback?state=${encodeURIComponent(state ?? "")}`,
      );
      expect(callback.status).toBe(400);
      expect(await callback.text()).toMatch(/unknown or expired/i);
    } finally {
      await failureApp.stop();
    }
  });
});
