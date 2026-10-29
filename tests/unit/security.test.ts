import { describe, expect, it, vi } from "vitest";
import { RateLimiter, chunk, mapConcurrent, sleep } from "../../src/core/batch.js";
import { redactString, redactValue, safeErrorMessage } from "../../src/security/redact.js";
import { createLogger } from "../../src/security/logger.js";
import { parseRoadmap } from "../../src/server/roadmap.js";

describe("bounded processing primitives", () => {
  it("chunks without losing items and rejects invalid sizes", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunk([1], 0)).toThrow();
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapConcurrent(
      Array.from({ length: 30 }, (_v, i) => i),
      3,
      async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(2);
        active -= 1;
        return value * 2;
      },
    );
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(30);
    expect(results[29]).toBe(58);
  });

  it("stops starting new work after cancellation", async () => {
    const controller = new AbortController();
    let started = 0;
    await mapConcurrent(
      Array.from({ length: 30 }, (_v, i) => i),
      2,
      async () => {
        started += 1;
        await sleep(2);
        if (started === 4) controller.abort();
        return null;
      },
      controller.signal,
    );
    expect(started).toBeLessThan(30);
  });

  it("paces token-bucket acquires and rejects on an aborted wait", async () => {
    const limiter = new RateLimiter(100, 1);
    await limiter.acquire();
    const started = Date.now();
    await limiter.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);

    const tight = new RateLimiter(1, 1);
    await tight.acquire();
    const controller = new AbortController();
    const waiting = tight.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeTruthy();
  });
});

describe("credential redaction", () => {
  it("redacts bearer tokens, token parameters, Google tokens, and JWTs", () => {
    const input =
      "Authorization: Bearer abcdefghijklmnop access_token=secretvalue ya29.abcdefghijklmnopqrstuvwxyz eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature1234";
    const redacted = redactString(input);
    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(redacted).not.toContain("secretvalue");
    expect(redacted).not.toContain("ya29.");
    expect(redacted).not.toContain("eyJhbGci");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts sensitive object keys recursively", () => {
    const value = redactValue({
      accessToken: "abc",
      nested: { refresh_token: "def", clientSecret: "ghi", safe: "visible" },
      headers: { Authorization: "Bearer xyz" },
    }) as Record<string, unknown>;
    expect(value["accessToken"]).toBe("[REDACTED]");
    const nested = value["nested"] as Record<string, unknown>;
    expect(nested["refresh_token"]).toBe("[REDACTED]");
    expect(nested["clientSecret"]).toBe("[REDACTED]");
    expect(nested["safe"]).toBe("visible");
    const headers = value["headers"] as Record<string, unknown>;
    expect(headers["Authorization"]).toBe("[REDACTED]");
  });

  it("redacts OAuth state and PKCE verifier values in strings and objects", () => {
    const stringValue = redactString("state=secret-state&code_verifier=secret-verifier");
    expect(stringValue).not.toContain("secret-state");
    expect(stringValue).not.toContain("secret-verifier");
    expect(stringValue).toContain("[REDACTED]");

    const value = redactValue({
      state: "object-state",
      code_verifier: "object-verifier",
      nested: { codeVerifier: "nested-verifier" },
    }) as Record<string, unknown>;
    expect(value["state"]).toBe("[REDACTED]");
    expect(value["code_verifier"]).toBe("[REDACTED]");
    expect((value["nested"] as Record<string, unknown>)["codeVerifier"]).toBe("[REDACTED]");
  });

  it("redacts error messages", () => {
    expect(safeErrorMessage(new Error("failed with access_token=leaked"))).toContain("[REDACTED]");
    expect(safeErrorMessage(new Error("state=leaked-state&code_verifier=leaked-verifier"))).not.toContain(
      "leaked-state",
    );
  });

  it("never writes raw credentials to structured logs", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const log = createLogger("test");
      log.error("auth event", {
        accessToken: "secret-access-token",
        refreshToken: "secret-refresh-token",
        state: "secret-state",
        code_verifier: "secret-verifier",
        note: "Bearer abcdefghijklmnop",
      });
    } finally {
      spy.mockRestore();
    }
    const output = writes.join("");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("secret-access-token");
    expect(output).not.toContain("secret-refresh-token");
    expect(output).not.toContain("secret-state");
    expect(output).not.toContain("secret-verifier");
    expect(output).not.toContain("abcdefghijklmnop");
  });
});

describe("roadmap parsing", () => {
  it("parses sections and statuses from markdown", () => {
    const sections = parseRoadmap(`# Roadmap
## Phase 1
- [x] Done thing
- [~] Active thing
- [!] Blocked thing
- [ ] Later thing
## Empty
- plain bullet
`);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.items.map((item) => item.status)).toEqual([
      "complete",
      "in-progress",
      "blocked",
      "planned",
    ]);
  });
});
