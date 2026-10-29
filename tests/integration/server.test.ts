import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MailSentryApp } from "../../src/server/app.js";
import { testConfig } from "../helpers/fixtures.js";

let app: MailSentryApp;
let base = "";
let port = 0;

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
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const cookie = response.headers.get("set-cookie") ?? "";
  return { csrf: body.csrfToken, cookie: cookie.split(";")[0] ?? "" };
}

beforeAll(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = new MailSentryApp(testConfig({ port, baseUrl: base, host: "127.0.0.1" }), process.cwd());
  await app.start();
});

afterAll(async () => {
  await app.stop();
});

describe("local HTTP server safety", () => {
  it("creates a session with a CSRF token and no credentials", async () => {
    const response = await fetch(`${base}/api/status`);
    const text = await response.text();
    expect(response.status).toBe(200);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(typeof body["csrfToken"]).toBe("string");
    expect((body["csrfToken"] as string).length).toBeGreaterThan(30);
    expect(body["privacy"]).toMatchObject({ telemetry: false });
    expect(text).not.toMatch(/accessToken|refreshToken|clientSecret/);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Secure/);
  });

  it("rejects POSTs without a CSRF token", async () => {
    const { cookie } = await status();
    const response = await fetch(`${base}/api/diagnostics`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ domain: "example.com" }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("rejects cross-origin POSTs even with a valid token", async () => {
    const { csrf, cookie } = await status();
    const response = await fetch(`${base}/api/diagnostics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "x-csrf-token": csrf,
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ domain: "example.com" }),
    });
    expect(response.status).toBe(403);
  });

  it("validates domains before any DNS lookup", async () => {
    const { csrf, cookie } = await status();
    const response = await fetch(`${base}/api/diagnostics`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "x-csrf-token": csrf },
      body: JSON.stringify({ domain: "127.0.0.1" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("rejects oversized or non-JSON bodies", async () => {
    const { csrf, cookie } = await status();
    const response = await fetch(`${base}/api/diagnostics`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Cookie: cookie, "x-csrf-token": csrf },
      body: "domain=example.com",
    });
    expect(response.status).toBe(415);
  });

  it("rejects an unexpected Host header (DNS rebinding)", async () => {
    const statusCode = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/status",
          method: "GET",
          headers: { Host: "attacker.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(statusCode).toBe(421);
  });

  it("does not expose unconfigured provider OAuth and does not contact providers", async () => {
    const { csrf, cookie } = await status();
    const response = await fetch(`${base}/api/auth/gmail/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "x-csrf-token": csrf },
      body: JSON.stringify({ mode: "readonly" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_CONFIGURED");
  });

  it("requires a reviewed plan before execution", async () => {
    const { csrf, cookie } = await status();
    const response = await fetch(`${base}/api/cleanup/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "x-csrf-token": csrf },
      body: JSON.stringify({
        planId: "missing",
        planHash: "0".repeat(64),
        reviewToken: "x",
        mode: "execute",
      }),
    });
    expect(response.status).toBe(404);
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const response = await fetch(`${base}/api/does-not-exist`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("serves a helpful message instead of a directory listing for static paths", async () => {
    const response = await fetch(`${base}/nope`);
    expect([404, 503]).toContain(response.status);
    const text = await response.text();
    expect(text).not.toMatch(/index of|directory listing/i);
  });
});
