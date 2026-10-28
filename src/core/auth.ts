/**
 * Credentials: token parsing, `Authorization` header normalisation, credential records in KV,
 * secret verification (`key` and GitHub OIDC `gh`) and panel sessions. See "Credentials" in
 * docs/spec.md and section 2 of docs/api.md.
 */

/** Secret types a token can carry. */
export type SecretType = "key" | "gh";

const SECRET_TYPES: readonly string[] = ["key", "gh"];

/** A local project or source slug. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** A `key` secret: 32 base62 characters. */
const KEY_SECRET_RE = /^[A-Za-z0-9]{32}$/;

/** A compact JWS: three base64url segments. */
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** A token split into its parts. Nothing but `secret` is secret. */
export interface ParsedToken {
  /** External credential provider, `null` for credentials stored in KV. */
  source: string | null;
  project: string;
  type: SecretType;
  secret: string;
  /** `[<source>.]<project>`, the left side of the token's colon. */
  login: string;
}

/** Whether a string is a valid project (or source) slug. */
export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

function stripPrefix(value: string, prefix: string): string {
  return prefix !== "" && value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/**
 * Parses `[<TOKEN_PREFIX>][<source>.]<project>:[<type>.]<secret>` (docs/api.md 2.1). The
 * prefix is optional even when configured. Returns `null` for anything malformed.
 */
export function parseToken(token: string, prefix = ""): ParsedToken | null {
  const value = stripPrefix(token, prefix);
  const colon = value.indexOf(":");
  if (colon === -1) return null;
  const login = value.slice(0, colon);
  const password = value.slice(colon + 1);

  const segments = login.split(".");
  let source: string | null = null;
  let project: string;
  if (segments.length === 1) {
    project = segments[0] ?? "";
  } else if (segments.length === 2) {
    source = segments[0] ?? "";
    project = segments[1] ?? "";
    if (!isSlug(source)) return null;
  } else {
    return null;
  }
  if (!isSlug(project)) return null;

  const dot = password.indexOf(".");
  const type = dot === -1 ? "key" : password.slice(0, dot);
  const secret = dot === -1 ? password : password.slice(dot + 1);
  if (!SECRET_TYPES.includes(type)) return null;
  if (type === "key" ? !KEY_SECRET_RE.test(secret) : !JWT_RE.test(secret)) return null;

  return { source, project, type: type as SecretType, secret, login };
}

function decodeBase64Utf8(value: string): string | null {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Normalises an `Authorization` header to a token (docs/api.md 2.2):
 *
 * - `Bearer <token>`;
 * - `Basic base64(<token>)`, where the Basic login and password are the two sides of the
 *   token's colon;
 * - `Basic base64(<login>:<token>)`, where the password itself contains a colon and is the
 *   whole token; the Basic login must equal the token's login;
 * - `<token>` (raw, as cargo sends it).
 *
 * Scheme names are case-insensitive. Returns `null` when no valid token can be extracted.
 */
export function parseAuthorization(header: string | null, prefix = ""): ParsedToken | null {
  const value = header?.trim() ?? "";
  if (value === "") return null;

  const bearer = /^bearer\s+(\S+)$/i.exec(value);
  if (bearer) return parseToken(bearer[1] ?? "", prefix);

  const basic = /^basic\s+(\S+)$/i.exec(value);
  if (basic) {
    const decoded = decodeBase64Utf8(basic[1] ?? "");
    if (decoded === null) return null;
    const colon = decoded.indexOf(":");
    const password = colon === -1 ? "" : decoded.slice(colon + 1);
    if (!password.includes(":")) return parseToken(decoded, prefix);
    const parsed = parseToken(password, prefix);
    const login = stripPrefix(decoded.slice(0, colon), prefix);
    return parsed !== null && parsed.login === login ? parsed : null;
  }

  return parseToken(value, prefix);
}
