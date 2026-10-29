export type ErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "NOT_CONFIGURED"
  | "NOT_CONNECTED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "CANCELLED"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new AppError("CANCELLED", "The operation was cancelled.", 409);
  }
  return new AppError("INTERNAL", "An unexpected internal error occurred.", 500);
}
