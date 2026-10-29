import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertDesktopConfig,
  deriveWindowState,
  ensureDesktopDirectories,
  isAllowedNavigation,
  parseSmokePath,
  readWindowState,
  resolveDesktopPaths,
  writeWindowState,
} from "../../src/desktop/runtime.js";
import { createLogger } from "../../src/security/logger.js";
import { testConfig } from "../helpers/fixtures.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mailsentry-desktop-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["MAILSENTRY_LOG_FILE"];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("desktop runtime configuration", () => {
  it("accepts only the supported loopback desktop origin", () => {
    expect(() =>
      assertDesktopConfig(testConfig({ port: 4310, baseUrl: "http://127.0.0.1:4310", host: "127.0.0.1" })),
    ).not.toThrow();
    expect(() =>
      assertDesktopConfig(testConfig({ port: 4310, baseUrl: "http://localhost:4310", host: "127.0.0.1" })),
    ).toThrow(/127\.0\.0\.1/);
    expect(() =>
      assertDesktopConfig(testConfig({ port: 4310, baseUrl: "https://127.0.0.1:4310", host: "127.0.0.1" })),
    ).toThrow(/127\.0\.0\.1/);
    expect(() =>
      assertDesktopConfig(testConfig({ port: 4310, baseUrl: "http://127.0.0.1:4310", host: "0.0.0.0" })),
    ).toThrow(/127\.0\.0\.1/);
  });

  it("resolves userData paths for config, logs, and window state", () => {
    const paths = resolveDesktopPaths(join(tempDir(), "user-data"));
    expect(paths.logFile.endsWith(join("logs", "mailsentry.log"))).toBe(true);
    expect(paths.windowStateFile.endsWith("window-state.json")).toBe(true);
    expect(paths.configExampleFile.endsWith(".env.example")).toBe(true);
    ensureDesktopDirectories(paths);
  });

  it("allows the app origin and OAuth providers, but blocks everything else", () => {
    const origin = "http://127.0.0.1:4310";
    expect(isAllowedNavigation("http://127.0.0.1:4310/#/settings", origin)).toBe(true);
    expect(isAllowedNavigation("https://accounts.google.com/o/oauth2/v2/auth", origin)).toBe(true);
    expect(
      isAllowedNavigation("https://login.microsoftonline.com/common/oauth2/v2.0/authorize", origin),
    ).toBe(true);
    expect(isAllowedNavigation("https://login.live.com/oauth20_authorize.srf", origin)).toBe(true);
    expect(isAllowedNavigation("https://evil.example/", origin)).toBe(false);
    expect(isAllowedNavigation("http://127.0.0.1:9999/", origin)).toBe(false);
    expect(isAllowedNavigation("javascript:alert(1)", origin)).toBe(false);
  });

  it("parses smoke-test paths from arguments and environment", () => {
    const smoke = join(tempDir(), "smoke.json");
    const envSmoke = join(tempDir(), "smoke.json");
    expect(parseSmokePath([`--smoke-test=${smoke}`], {})).toBe(smoke);
    expect(parseSmokePath(["--smoke-test"], { MAILSENTRY_SMOKE_FILE: envSmoke })).toBe(envSmoke);
    expect(parseSmokePath(["--smoke-test"], {})).toBe(join(process.cwd(), "desktop-smoke.json"));
    expect(parseSmokePath([], { MAILSENTRY_SMOKE_FILE: envSmoke })).toBe(envSmoke);
    expect(parseSmokePath([], {})).toBeNull();
  });
});

describe("desktop window state", () => {
  it("round-trips valid dimensions and rejects corrupt state", () => {
    const file = join(tempDir(), "window-state.json");
    writeWindowState(file, deriveWindowState({ width: 1200, height: 800 }, true));
    expect(readWindowState(file)).toEqual({ width: 1200, height: 800, maximized: true });

    writeFileSync(file, "{not json", "utf8");
    expect(readWindowState(file)).toEqual({ width: 1180, height: 820, maximized: false });
  });

  it("clamps absurd dimensions", () => {
    expect(deriveWindowState({ width: 100, height: 99999 }, false)).toEqual({
      width: 900,
      height: 2400,
      maximized: false,
    });
  });
});

describe("desktop log file", () => {
  it("writes redacted JSON lines without credentials", () => {
    const file = join(tempDir(), "logs", "mailsentry.log");
    process.env["MAILSENTRY_LOG_FILE"] = file;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    createLogger("desktop-test").error("startup", {
      accessToken: "SECRET_DESKTOP_TOKEN",
      note: "Bearer abcdefghijklmnop",
    });
    const contents = readFileSync(file, "utf8");
    expect(contents).toContain("desktop-test");
    expect(contents).toContain("[REDACTED]");
    expect(contents).not.toContain("SECRET_DESKTOP_TOKEN");
    expect(contents).not.toContain("abcdefghijklmnop");
  });
});
