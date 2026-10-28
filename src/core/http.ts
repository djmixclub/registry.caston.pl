import { ValidationError } from "./errors";

/** `WWW-Authenticate` value sent with every `401` (docs/api.md 2.4). */
export const WWW_AUTHENTICATE = 'Bearer realm="serverless-registry"';

/** A JSON response with `Cache-Control: no-store`; `headers` are added last. */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/**
 * Turns a thrown value into the error body `{ error, message }`, followed by the error's
 * `details` when it has any (they cannot replace `error` or `message`). Anything that is not
 * a {@link ValidationError} becomes a generic `500 internal_error`, so internal details never
 * leak to the client.
 */
export function errorResponse(err: unknown, headers: Record<string, string> = {}): Response {
  const error = err instanceof ValidationError ? err : new ValidationError("internal_error");
  const extra: Record<string, string> =
    error.code === "unauthorized" ? { "www-authenticate": WWW_AUTHENTICATE } : {};
  const head = { error: error.code, message: error.message };
  const body = { ...head, ...error.details, ...head };
  return jsonResponse(body, error.status, {
    ...extra,
    ...headers,
  });
}
