import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { AppError } from "./errors.js";

export interface OAuthAppConfig {
  clientId: string | null;
  clientSecret: string | null;
}

export interface AppConfig {
  port: number;
  host: string;
  baseUrl: string;
  google: OAuthAppConfig;
  microsoft: OAuthAppConfig & { tenant: string };
  sessionTtlMs: number;
  planTtlMs: number;
  limits: {
    maxScanMessages: number;
    pageSize: number;
    executorBatchSize: number;
    executorConcurrency: number;
    previewSampleSize: number;
    resultsSampleSize: number;
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function envValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function parsePort(value: string | null): number {
  if (!value) return 4310;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new AppError("VALIDATION", "PORT must be an integer between 1 and 65535.", 500);
  }
  return port;
}

/**
 * Load `.env` from the project directory when present. Values already present
 * in the process environment take precedence (Node's loadEnvFile behavior).
 * Returns the loaded path, or null when no file exists.
 */
export function loadDotEnv(rootDir = process.cwd()): string | null {
  const path = resolve(rootDir, ".env");
  if (!existsSync(path)) return null;
  try {
    loadEnvFile(path);
    return path;
  } catch (error) {
    throw new AppError(
      "VALIDATION",
      `.env could not be loaded: ${error instanceof Error ? error.message : "unknown error"}`,
      500,
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = parsePort(envValue(env, "PORT"));
  const host = envValue(env, "MAILSENTRY_HOST") ?? "127.0.0.1";
  const configuredBase = envValue(env, "MAILSENTRY_BASE_URL");
  const baseUrl = (configuredBase ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AppError("VALIDATION", "MAILSENTRY_BASE_URL is not a valid URL.", 500);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError("VALIDATION", "MAILSENTRY_BASE_URL must use http or https.", 500);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new AppError(
      "VALIDATION",
      "MAILSENTRY_BASE_URL must be an origin only (no path, query, or fragment).",
      500,
    );
  }
  const parsedPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  if (parsed.protocol === "http:" && !LOOPBACK.has(parsed.hostname)) {
    throw new AppError(
      "VALIDATION",
      "Refusing a non-loopback plain-HTTP base URL. Use HTTPS or bind to 127.0.0.1.",
      500,
    );
  }
  if (parsedPort !== String(port)) {
    throw new AppError(
      "VALIDATION",
      `MAILSENTRY_BASE_URL port (${parsedPort}) must match PORT (${port}) for the local OAuth redirect.`,
      500,
    );
  }
  if (envValue(env, "MAILSENTRY_ALLOW_NONLOCAL") !== "true" && !LOOPBACK.has(host)) {
    throw new AppError(
      "VALIDATION",
      "MailSentry binds to loopback by default. Set MAILSENTRY_ALLOW_NONLOCAL=true only if you have reviewed the security implications.",
      500,
    );
  }

  return {
    port,
    host,
    baseUrl,
    google: {
      clientId: envValue(env, "GOOGLE_CLIENT_ID"),
      clientSecret: envValue(env, "GOOGLE_CLIENT_SECRET"),
    },
    microsoft: {
      clientId: envValue(env, "MICROSOFT_CLIENT_ID"),
      clientSecret: envValue(env, "MICROSOFT_CLIENT_SECRET"),
      tenant: envValue(env, "MICROSOFT_TENANT_ID") ?? "common",
    },
    sessionTtlMs: 8 * 60 * 60 * 1000,
    planTtlMs: 20 * 60 * 1000,
    limits: {
      maxScanMessages: 50_000,
      pageSize: 50,
      executorBatchSize: 25,
      executorConcurrency: 3,
      previewSampleSize: 100,
      resultsSampleSize: 100,
    },
  };
}
