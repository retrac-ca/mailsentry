const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|cookie|credential|api[-_]?key|code$)/i;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const TOKEN_PARAM = /\b(access_token|refresh_token|id_token|client_secret|code)=([^&\s"']+)/gi;
const GOOGLE_TOKEN = /\bya29\.[A-Za-z0-9._-]{10,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;

/** Redact credential-like substrings from arbitrary text before logging or display. */
export function redactString(input: string): string {
  return input
    .replace(BEARER, "$1 [REDACTED]")
    .replace(TOKEN_PARAM, "$1=[REDACTED]")
    .replace(GOOGLE_TOKEN, "[REDACTED_GOOGLE_TOKEN]")
    .replace(JWT, "[REDACTED_JWT]");
}

const MAX_DEPTH = 6;
const MAX_ARRAY = 20;
const MAX_STRING = 500;

/**
 * Recursively redact objects for safe logging. Unknown errors are converted to
 * their name/message only — stack traces can contain tokens and are not logged.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string") {
    const redacted = redactString(value);
    return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}…` : redacted;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return undefined;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((entry) => redactValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(entry, depth + 1);
    }
    return result;
  }
  return "[UNKNOWN]";
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message);
}
