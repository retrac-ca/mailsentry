import { sleep } from "../core/batch.js";
import type { RateLimiter } from "../core/batch.js";
import { redactString } from "../security/redact.js";
import { ProviderError } from "./errors.js";

export interface ProviderRequestOptions {
  provider: string;
  method?: "GET" | "POST" | "DELETE" | "PUT";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  limiter: RateLimiter;
  /** Reads and naturally-idempotent operations may be retried on 5xx. */
  idempotent?: boolean;
  maxAttempts?: number;
}

export interface ProviderResponse {
  status: number;
  headers: Headers;
  text: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
  return undefined;
}

function errorForResponse(provider: string, response: ProviderResponse): ProviderError {
  const status = response.status;
  const snippet = redactString(response.text.slice(0, 300)).trim();
  const suffix = snippet ? `: ${snippet}` : "";
  if (status === 401) {
    return new ProviderError(`${provider} authorization expired or was rejected. Reconnect the account.`, {
      code: "UNAUTHORIZED",
      status,
    });
  }
  if (status === 403) {
    if (/rate ?limit|quota ?exceeded|userratelimitexceeded/i.test(response.text)) {
      return new ProviderError(`${provider} rate limit or quota exceeded.`, {
        code: "RATE_LIMITED",
        status,
        retryable: true,
        retryAfterMs: parseRetryAfter(response.headers),
      });
    }
    return new ProviderError(
      `${provider} denied the request. The grant may lack the required scope, or the account may be restricted.${suffix}`,
      { code: "FORBIDDEN", status },
    );
  }
  if (status === 404) {
    return new ProviderError(`${provider} reports the item no longer exists.`, {
      code: "NOT_FOUND",
      status,
      notFound: true,
    });
  }
  if (status === 429) {
    return new ProviderError(`${provider} rate limit reached.`, {
      code: "RATE_LIMITED",
      status,
      retryable: true,
      retryAfterMs: parseRetryAfter(response.headers),
    });
  }
  if (status >= 500) {
    return new ProviderError(`${provider} service error (HTTP ${status}).${suffix}`, {
      code: "HTTP_ERROR",
      status,
      retryable: true,
    });
  }
  return new ProviderError(`${provider} request failed (HTTP ${status}).${suffix}`, {
    code: "HTTP_ERROR",
    status,
  });
}

/**
 * Perform a provider API request with a timeout, pacing, bounded retries, and
 * credential-safe errors. Mutating requests are never retried on ambiguous
 * network/5xx errors; only explicit 429 responses are retried.
 */
export async function providerRequest(options: ProviderRequestOptions): Promise<ProviderResponse> {
  const {
    provider,
    method = "GET",
    url,
    headers = {},
    body,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    limiter,
    idempotent = method === "GET",
    maxAttempts = 3,
  } = options;

  let lastError: ProviderError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      throw new ProviderError("The request was cancelled.", {
        code: "CANCELLED",
        ambiguous: false,
      });
    }
    await limiter.acquire(signal);

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: combined,
        redirect: "error",
      });
    } catch (error) {
      const abortedByCaller = signal?.aborted === true;
      if (abortedByCaller) {
        throw new ProviderError("The request was cancelled.", {
          code: "CANCELLED",
          ambiguous: !idempotent,
        });
      }
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      const providerError = new ProviderError(
        timedOut
          ? `${provider} request timed out after ${timeoutMs} ms.`
          : `${provider} network request failed.`,
        {
          code: timedOut ? "TIMEOUT" : "NETWORK",
          // A timeout/network failure on a mutation has an uncertain outcome.
          ambiguous: !idempotent,
          retryable: idempotent,
        },
      );
      lastError = providerError;
      if (!idempotent || attempt >= maxAttempts) throw providerError;
      await sleep(backoffMs(attempt), signal);
      continue;
    }

    const text = await response.text();
    const result: ProviderResponse = { status: response.status, headers: response.headers, text };
    if (response.ok) return result;

    const error = errorForResponse(provider, result);
    lastError = error;
    const rateLimited = error.code === "RATE_LIMITED";
    const retryableServer = response.status >= 500 && idempotent;
    if ((rateLimited || retryableServer) && attempt < maxAttempts) {
      const wait = rateLimited ? (error.retryAfterMs ?? backoffMs(attempt)) : backoffMs(attempt);
      await sleep(wait, signal);
      continue;
    }
    throw error;
  }

  throw lastError ?? new ProviderError(`${provider} request failed.`, { code: "HTTP_ERROR" });
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
  return base + Math.floor(Math.random() * 250);
}

export function parseJson<T>(provider: string, response: ProviderResponse): T {
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new ProviderError(`${provider} returned an unreadable response.`, {
      code: "INVALID_RESPONSE",
    });
  }
}
