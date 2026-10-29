export interface ProviderErrorOptions {
  code:
    | "HTTP_ERROR"
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "RATE_LIMITED"
    | "TIMEOUT"
    | "NETWORK"
    | "CANCELLED"
    | "INVALID_RESPONSE";
  status?: number;
  retryable?: boolean;
  ambiguous?: boolean;
  notFound?: boolean;
  retryAfterMs?: number;
}

/**
 * Provider failures carry enough information for the executor to distinguish
 * confirmed failures, safe retries, and ambiguous outcomes.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorOptions["code"];
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly notFound: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message);
    this.name = "ProviderError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.ambiguous = options.ambiguous ?? false;
    this.notFound = options.notFound ?? options.status === 404;
    this.retryAfterMs = options.retryAfterMs;
  }
}
