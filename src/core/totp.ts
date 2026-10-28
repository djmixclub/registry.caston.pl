/**
 * Time-based one-time passwords (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits) for `login`
 * secrets, and the encryption of the shared secret at rest. The shared secret has to be
 * recoverable (it keys the HMAC), so it is stored AES-GCM encrypted with a key derived from
 * `SESSION_SECRET`.
 */

import { ValidationError } from "./errors";
import { base64UrlDecode, base64UrlEncode, deriveBytes, type SigningEnv } from "./signing";

/** Length of a time step, in seconds. */
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
/** Steps accepted on either side of the current one (clock drift). */
const WINDOW = 1;
/** Bytes of a new shared secret (160 bits, as authenticator apps expect). */
const SECRET_BYTES = 20;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Bytes of a base32 string (case-insensitive, padding and spaces ignored); `null` if invalid. */
export function base32Decode(value: string): Uint8Array<ArrayBuffer> | null {
  const clean = value.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) return null;
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** A new random shared secret, base32. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/** The time step (counter) containing `nowMs`. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

async function hotp(secret: Uint8Array<ArrayBuffer>, counter: number): Promise<string> {
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const code =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** The code of a base32 secret at a time step; `null` for a malformed secret. */
export async function totpCode(secret: string, step: number): Promise<string | null> {
  const bytes = base32Decode(secret);
  return bytes === null || bytes.length === 0 ? null : hotp(bytes, step);
}

/**
 * The step a code matches within the accepted window, only a step after `lastStep` (a code is
 * never accepted twice); `null` when it matches none. The comparison is constant-time per code.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  nowMs: number,
  lastStep: number,
): Promise<number | null> {
  const given = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    if (step <= lastStep) continue;
    const expected = await totpCode(secret, step);
    if (expected !== null && constantTimeEqual(expected, given) && matched === null) {
      matched = step;
    }
  }
  return matched;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The `otpauth://` URI authenticator apps import (usually shown as a QR code). */
export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

async function encryptionKey(env: SigningEnv): Promise<CryptoKey> {
  const bytes = await deriveBytes(env, "sreg-totp-encryption-v1");
  if (bytes === null) {
    throw new ValidationError(
      "internal_error",
      "One-time codes are not configured: set SESSION_SECRET in the Worker settings.",
    );
  }
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** A shared secret encrypted for storage: `v1.<iv>.<ciphertext>` (base64url). */
export async function encryptTotpSecret(env: SigningEnv, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(secret),
  );
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(data)}`;
}

/** The shared secret of a stored value; `null` when it is malformed or `SESSION_SECRET` changed. */
export async function decryptTotpSecret(env: SigningEnv, stored: string): Promise<string | null> {
  const [version, ivPart = "", dataPart = "", ...rest] = stored.split(".");
  if (version !== "v1" || rest.length > 0) return null;
  const iv = base64UrlDecode(ivPart);
  const data = base64UrlDecode(dataPart);
  if (iv === null || data === null) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      await encryptionKey(env),
      data,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
