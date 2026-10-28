/**
 * Signed, typed payloads: `<base64url JSON>.<base64url HMAC-SHA256>`. Panel session cookies,
 * login tokens and browser login sessions all use this format, each with its own `typ` and its
 * own signing key derived from `SESSION_SECRET`, so a value made for one purpose never verifies
 * as another. Nothing is stored on the server.
 */

import type { Env } from "../env";

/** Bindings signing needs. */
export type SigningEnv = Pick<Env, "SESSION_SECRET">;

/** Base64url (no padding) of bytes. */
export function base64UrlEncode(bytes: Uint8Array | ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Bytes of a base64url segment, or `null` when it is not base64url. */
export function base64UrlDecode(segment: string): Uint8Array<ArrayBuffer> | null {
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The configured `SESSION_SECRET` as bytes, or `null` when it is not set. */
function masterKey(env: SigningEnv): Promise<CryptoKey> | null {
  const secret = env.SESSION_SECRET?.trim() ?? "";
  if (secret === "") return null;
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * 32 bytes derived from `SESSION_SECRET` for one purpose (HMAC-SHA256 of the label), or `null`
 * when the secret is not set. Different labels give unrelated keys.
 */
export async function deriveBytes(env: SigningEnv, label: string): Promise<ArrayBuffer | null> {
  const master = masterKey(env);
  if (master === null) return null;
  return crypto.subtle.sign("HMAC", await master, new TextEncoder().encode(label));
}

async function signingKey(env: SigningEnv, typ: string): Promise<CryptoKey | null> {
  const bytes = await deriveBytes(env, `sreg-signing-v1:${typ}`);
  if (bytes === null) return null;
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/**
 * Signs a payload as `typ`: the payload gets a `typ` field, which {@link verifyPayload} checks.
 * `null` when `SESSION_SECRET` is not set.
 */
export async function signPayload(
  env: SigningEnv,
  typ: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const key = await signingKey(env, typ);
  if (key === null) return null;
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ ...payload, typ })));
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64UrlEncode(signature)}`;
}

/**
 * The payload of a value signed as `typ`: the HMAC is verified with `crypto.subtle.verify`
 * (constant time) and the payload's `typ` must equal `typ`. `null` for anything else, including
 * a missing `SESSION_SECRET`. Expiry is the caller's business.
 */
export async function verifyPayload(
  env: SigningEnv,
  typ: string,
  value: string,
): Promise<Record<string, unknown> | null> {
  const key = await signingKey(env, typ);
  if (key === null) return null;
  const [body = "", signaturePart = "", ...rest] = value.split(".");
  if (rest.length > 0) return null;
  const signature = base64UrlDecode(signaturePart);
  if (signature === null) return null;
  if (!(await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(body)))) {
    return null;
  }
  const bytes = base64UrlDecode(body);
  if (bytes === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  return record.typ === typ ? record : null;
}

/**
 * A keyed digest of `data` for one purpose: base64url of HMAC-SHA256 under a key derived from
 * `SESSION_SECRET` and `label`. `null` when the secret is not set.
 */
export async function keyedDigest(
  env: SigningEnv,
  label: string,
  data: string,
): Promise<string | null> {
  const bytes = await deriveBytes(env, label);
  if (bytes === null) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64UrlEncode(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}
