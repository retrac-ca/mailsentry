import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { redactValue } from "./redact.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function configuredLevel(): Level {
  const value = (process.env["MAILSENTRY_LOG_LEVEL"] ?? "info").toLowerCase();
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

function writeLogLine(line: string): void {
  try {
    process.stderr.write(line);
  } catch {
    // A GUI process may not have a usable stderr. The optional file sink follows.
  }

  const file = process.env["MAILSENTRY_LOG_FILE"];
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size >= MAX_LOG_BYTES) {
      const rotated = `${file}.1`;
      rmSync(rotated, { force: true });
      renameSync(file, rotated);
    }
    appendFileSync(file, line, { encoding: "utf8" });
  } catch {
    // Logging must never take down the application or leak a path into responses.
  }
}

function emit(level: Level, scope: string, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;
  const line = {
    time: new Date().toISOString(),
    level,
    scope,
    message,
    ...(context ? { context: redactValue(context) } : {}),
  };
  // Logs go to stderr; stdout is reserved for CLI results.
  writeLogLine(`${JSON.stringify(line)}\n`);
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, context) => emit("debug", scope, message, context),
    info: (message, context) => emit("info", scope, message, context),
    warn: (message, context) => emit("warn", scope, message, context),
    error: (message, context) => emit("error", scope, message, context),
  };
}

export const logger = createLogger("mailsentry");
