import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AppConfig } from "../core/config.js";

export interface DesktopPaths {
  userDataDir: string;
  logDir: string;
  logFile: string;
  windowStateFile: string;
  configExampleFile: string;
}

export interface WindowState {
  width: number;
  height: number;
  maximized: boolean;
}

const DEFAULT_WINDOW_STATE: WindowState = { width: 1180, height: 820, maximized: false };
const MIN_WIDTH = 900;
const MIN_HEIGHT = 620;
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2400;

export function resolveDesktopPaths(userDataDir: string): DesktopPaths {
  const dir = resolve(userDataDir);
  const logDir = join(dir, "logs");
  return {
    userDataDir: dir,
    logDir,
    logFile: join(logDir, "mailsentry.log"),
    windowStateFile: join(dir, "window-state.json"),
    configExampleFile: join(dir, ".env.example"),
  };
}

export function ensureDesktopDirectories(paths: DesktopPaths): void {
  mkdirSync(paths.userDataDir, { recursive: true });
  mkdirSync(paths.logDir, { recursive: true });
}

/**
 * The desktop shell loads the local HTTP server directly, so it must use a
 * plain loopback origin. Custom HTTPS/reverse-proxy setups remain available to
 * the CLI/server, but are outside the desktop shell's supported model.
 */
export function assertDesktopConfig(config: AppConfig): void {
  const expected = `http://127.0.0.1:${config.port}`;
  if (config.host !== "127.0.0.1" || config.baseUrl !== expected) {
    throw new Error(
      `The desktop app requires MAILSENTRY_HOST=127.0.0.1 and MAILSENTRY_BASE_URL=${expected}. ` +
        "Update the desktop .env file and restart.",
    );
  }
}

export function readWindowState(file: string): WindowState {
  if (!existsSync(file)) return { ...DEFAULT_WINDOW_STATE };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<WindowState>;
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < MIN_WIDTH ||
      width > MAX_WIDTH ||
      height < MIN_HEIGHT ||
      height > MAX_HEIGHT
    ) {
      return { ...DEFAULT_WINDOW_STATE };
    }
    return { width, height, maximized: parsed.maximized === true };
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

export function writeWindowState(file: string, state: WindowState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(state.width)));
    const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(state.height)));
    writeFileSync(
      file,
      `${JSON.stringify({ width, height, maximized: state.maximized === true }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Window geometry is a convenience; failure must not block shutdown.
  }
}

export const OAUTH_NAVIGATION_HOSTS = new Set([
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "account.live.com",
  "login.microsoft.com",
]);

/** Navigation required for the in-app OAuth redirect flow. */
export function isAllowedNavigation(rawUrl: string, appOrigin: string): boolean {
  try {
    const target = new URL(rawUrl);
    if (target.origin === appOrigin) return true;
    const host = target.hostname.toLowerCase();
    return (
      target.protocol === "https:" &&
      (OAUTH_NAVIGATION_HOSTS.has(host) ||
        host.endsWith(".microsoftonline.com") ||
        host.endsWith(".live.com"))
    );
  } catch {
    return false;
  }
}

export function deriveWindowState(
  bounds: { width: number; height: number },
  maximized: boolean,
): WindowState {
  return {
    width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(bounds.width))),
    height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(bounds.height))),
    maximized,
  };
}

export function parseSmokePath(argv: readonly string[], env: NodeJS.ProcessEnv): string | null {
  const arg = argv.find((value) => value.startsWith("--smoke-test="));
  if (arg) return resolve(arg.slice("--smoke-test=".length));
  if (argv.includes("--smoke-test")) {
    return resolve(env["MAILSENTRY_SMOKE_FILE"] ?? "desktop-smoke.json");
  }
  const fromEnv = env["MAILSENTRY_SMOKE_FILE"];
  return fromEnv ? resolve(fromEnv) : null;
}
