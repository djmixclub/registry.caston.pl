/** Error codes of the `/api/v1` error body (docs/api.md section 4). */
export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "version_exists"
  | "upload_mismatch"
  | "credential_exists"
  | "payload_too_large"
  | "client_too_old"
  | "rate_limited"
  | "internal_error"
  | "provider_unavailable";

/** HTTP status of every error code. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  version_exists: 409,
  upload_mismatch: 409,
  credential_exists: 409,
  payload_too_large: 413,
  client_too_old: 426,
  rate_limited: 429,
  internal_error: 500,
  provider_unavailable: 503,
};

const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  invalid_request: "Invalid request.",
  unauthorized: "Authentication required.",
  forbidden: "Forbidden.",
  not_found: "Not found.",
  version_exists: "This version is already published.",
  upload_mismatch: "The uploaded object does not match the declaration.",
  credential_exists: "This credential already exists.",
  payload_too_large: "Payload too large.",
  client_too_old: "This client is too old for the registry.",
  rate_limited: "Too many requests.",
  internal_error: "Internal error.",
  provider_unavailable: "The credential provider is unavailable.",
};

/**
 * An expected failure that maps to an `/api/v1` error response. The message is shown to
 * clients, so it must never contain secrets (tokens, hashes, presigned URLs).
 */
export class ValidationError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string = DEFAULT_MESSAGES[code]) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}
