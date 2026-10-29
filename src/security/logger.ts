import { redactValue } from "./redact.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): Level {
  const value = (process.env["MAILSENTRY_LOG_LEVEL"] ?? "info").toLowerCase();
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
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
  process.stderr.write(`${JSON.stringify(line)}\n`);
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
