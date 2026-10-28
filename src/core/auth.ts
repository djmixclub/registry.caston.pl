/**
 * Credentials: token parsing, `Authorization` header normalisation, credential records in KV,
 * secret verification (`key` and GitHub OIDC `gh`) and panel sessions. See "Credentials" in
 * docs/spec.md and section 2 of docs/api.md.
 */

import type { Env } from "../env";
import { ValidationError } from "./errors";
import { normalizeGrant, type Grant } from "./grants";

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

// ---------------------------------------------------------------------------------------------
// Credential records in KV
// ---------------------------------------------------------------------------------------------

/** The single role of a credential. */
export type Kind = "read" | "publish" | "admin";

export const KINDS: readonly Kind[] = ["read", "publish", "admin"];

/** A static secret, stored as its SHA-256. */
export interface KeyAuthRecord {
  type: "key";
  /** `sha256:<64 hex>` of the secret. */
  hash: string;
  /** RFC 3339 (or `YYYY-MM-DD`). */
  created: string;
  /** RFC 3339 (or `YYYY-MM-DD`); `null` = never. */
  expires: string | null;
}

/** A GitHub Actions OIDC identity. */
export interface GhAuthRecord {
  type: "gh";
  /** `owner/repo`, compared exactly with the JWT `repository` claim. */
  repository: string;
  /** Compared exactly with the JWT `ref` claim; `null` = any ref. */
  ref: string | null;
  /** Compared exactly with the JWT `workflow` claim; `null` = any workflow. */
  workflow: string | null;
  created: string;
  expires: string | null;
}

/** An auth entry as stored in KV. */
export type AuthRecordEntry = KeyAuthRecord | GhAuthRecord;

/** The record stored at `cred:<project>`. */
export interface CredentialRecord {
  project: string;
  kind: Kind;
  auth: AuthRecordEntry[];
  /** Ignored (and always empty) for `admin`. */
  grants: Grant[];
}

/** An auth entry as the API exposes it: the hash is replaced by `id` (docs/api.md 6.1). */
export type AuthEntry = (Omit<KeyAuthRecord, "hash"> | GhAuthRecord) & { id: string };

/** A credential as the API exposes it (docs/api.md 5). */
export interface Credential {
  project: string;
  kind: Kind;
  auth: AuthEntry[];
  grants: Grant[];
}

const CRED_PREFIX = "cred:";

const SHA256_PREFIX = "sha256:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCredentialRecord(value: unknown): value is CredentialRecord {
  return (
    isRecord(value) &&
    typeof value.project === "string" &&
    (KINDS as readonly unknown[]).includes(value.kind) &&
    Array.isArray(value.auth) &&
    value.auth.every((e) => isRecord(e) && (e.type === "key" || e.type === "gh")) &&
    Array.isArray(value.grants)
  );
}

/** Reads `cred:<project>`; `null` when missing, not JSON or not a credential record. */
export async function getCredential(
  env: Pick<Env, "AUTH">,
  project: string,
): Promise<CredentialRecord | null> {
  const text = await env.AUTH.get(CRED_PREFIX + project, "text");
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isCredentialRecord(value) || value.project !== project) return null;
  // Records written before grants carried `transitive` read as `transitive: true`.
  const grants = value.grants.map((g) => (isRecord(g) ? normalizeGrant(g) : g));
  return { ...value, grants };
}

/** Writes `cred:<project>` (no TTL). */
export async function putCredential(
  env: Pick<Env, "AUTH">,
  record: CredentialRecord,
): Promise<void> {
  await env.AUTH.put(CRED_PREFIX + record.project, JSON.stringify(record));
}

/** Deletes `cred:<project>`. */
export async function deleteCredential(env: Pick<Env, "AUTH">, project: string): Promise<void> {
  await env.AUTH.delete(CRED_PREFIX + project);
}

/** Every credential record in KV, sorted by project. */
export async function listCredentials(env: Pick<Env, "AUTH">): Promise<CredentialRecord[]> {
  const projects: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.AUTH.list({ prefix: CRED_PREFIX, cursor });
    for (const key of page.keys) projects.push(key.name.slice(CRED_PREFIX.length));
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  const records = await Promise.all(projects.map((project) => getCredential(env, project)));
  return records
    .filter((r): r is CredentialRecord => r !== null)
    .sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
}

/**
 * Whether an auth entry is active at `now` (ms since the epoch): `expires` is `null` or in the
 * future. An unparsable `expires` counts as expired.
 */
export function isActive(entry: AuthRecordEntry, now: number): boolean {
  if (entry.expires === null || entry.expires === undefined) return true;
  const expires = Date.parse(entry.expires);
  return !Number.isNaN(expires) && expires > now;
}

/**
 * The stable 12-hex `id` of an auth entry (docs/api.md 6.1):
 *
 * - `key`: the first 12 hex characters of the secret's SHA-256, i.e. of the digest stored in
 *   `hash` (`sha256:<hex>`);
 * - `gh`: the first 12 hex characters of the SHA-256 of the JSON array
 *   `[repository, ref, workflow, created]`. `created` is included so that an entry re-added
 *   with the same claims never shares an id with an expired one still awaiting cleanup.
 */
export async function authEntryId(entry: AuthRecordEntry): Promise<string> {
  if (entry.type === "key")
    return entry.hash.slice(SHA256_PREFIX.length, SHA256_PREFIX.length + 12);
  const material = JSON.stringify([entry.repository, entry.ref, entry.workflow, entry.created]);
  return (await sha256Hex(material)).slice(0, 12);
}

/** The API view of a stored auth entry (without the secret hash). */
export async function toAuthEntry(entry: AuthRecordEntry): Promise<AuthEntry> {
  const id = await authEntryId(entry);
  if (entry.type === "key") {
    return { id, type: "key", created: entry.created, expires: entry.expires ?? null };
  }
  return {
    id,
    type: "gh",
    repository: entry.repository,
    ref: entry.ref ?? null,
    workflow: entry.workflow ?? null,
    created: entry.created,
    expires: entry.expires ?? null,
  };
}

/** The API view of a stored credential record. */
export async function toCredential(record: CredentialRecord): Promise<Credential> {
  return {
    project: record.project,
    kind: record.kind,
    auth: await Promise.all(record.auth.map(toAuthEntry)),
    grants: record.kind === "admin" ? [] : record.grants,
  };
}

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Random base62 string from `crypto.getRandomValues`, without modulo bias. */
export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      // 248 = 4 * 62: bytes above it are rejected so every character is equally likely.
      if (byte < 248 && out.length < length) out += BASE62[byte % 62];
    }
  }
  return out;
}

/** A new `key` secret: 32 base62 characters (~190 bits). */
export function generateSecret(): string {
  return randomBase62(32);
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lower-case hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** The stored form of a `key` secret: `sha256:<hex>`. */
export async function hashSecret(secret: string): Promise<string> {
  return SHA256_PREFIX + (await sha256Hex(secret));
}

/** The token handed to the user once: `[<prefix>]<project>:<secret>`. */
export function formatToken(project: string, secret: string, prefix = ""): string {
  return `${prefix}${project}:${secret}`;
}

/**
 * Constant-time string equality. Uses the Workers-specific `crypto.subtle.timingSafeEqual`
 * when present and falls back to an XOR loop elsewhere. Only the length leaks, which is fixed
 * for the values compared here.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.byteLength !== y.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown };
  if (typeof subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(x, y);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Verifies a `key` secret against every active `key` entry of a record, comparing digests in
 * constant time. Returns the matching entry.
 */
export async function verifyKey(
  record: CredentialRecord,
  secret: string,
  now: number,
): Promise<KeyAuthRecord | null> {
  const hash = await hashSecret(secret);
  let match: KeyAuthRecord | null = null;
  for (const entry of record.auth) {
    if (entry.type !== "key" || !isActive(entry, now)) continue;
    if (timingSafeEqual(entry.hash, hash) && match === null) match = entry;
  }
  return match;
}

// ---------------------------------------------------------------------------------------------
// GitHub Actions OIDC
// ---------------------------------------------------------------------------------------------

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;

/** KV key and TTL of the cached GitHub JWKS. */
const JWKS_KEY = "jwks:github";
const JWKS_TTL = 24 * 60 * 60;
/** An unknown `kid` refetches the JWKS at most this often (key rotation). */
const JWKS_REFRESH_MS = 5 * 60 * 1000;
/** KV key prefix of positive JWT verifications. */
const GH_OK_PREFIX = "ghok:";
/** Allowed clock skew for `nbf`, in seconds. */
const CLOCK_SKEW = 60;
/** KV rejects TTLs below 60 seconds. */
const KV_MIN_TTL = 60;

/** Injectable I/O for tests. */
export interface AuthDeps {
  fetch?: typeof fetch;
  /** Current time in ms since the epoch. */
  now?: () => number;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface CachedJwks {
  keys: Jwk[];
  fetchedAt: number;
}

/** The claims of a verified GitHub Actions OIDC token that the registry uses. */
export interface GithubClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  repository: string;
  ref?: string;
  workflow?: string;
}

interface CachedGhVerification {
  project: string;
  entryId: string;
  exp: number;
}

function base64UrlDecode(segment: string): Uint8Array<ArrayBuffer> | null {
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlDecode(segment);
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function loadJwks(
  env: Pick<Env, "AUTH">,
  fetcher: typeof fetch,
  now: number,
): Promise<CachedJwks | null> {
  let response: Response;
  try {
    response = await fetcher(GITHUB_JWKS_URL, { headers: { accept: "application/json" } });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(body) || !Array.isArray(body.keys)) return null;
  const jwks: CachedJwks = {
    keys: body.keys.filter((k): k is Jwk => isRecord(k) && typeof k.kty === "string"),
    fetchedAt: now,
  };
  await env.AUTH.put(JWKS_KEY, JSON.stringify(jwks), { expirationTtl: JWKS_TTL });
  return jwks;
}

async function findSigningKey(
  env: Pick<Env, "AUTH">,
  kid: string,
  fetcher: typeof fetch,
  now: number,
): Promise<Jwk | null> {
  let jwks = await env.AUTH.get<CachedJwks>(JWKS_KEY, "json");
  const find = (set: CachedJwks | null) =>
    set?.keys.find((k) => k.kid === kid && k.kty === "RSA") ?? null;
  if (jwks === null || (find(jwks) === null && now - jwks.fetchedAt > JWKS_REFRESH_MS)) {
    jwks = await loadJwks(env, fetcher, now);
  }
  return find(jwks);
}

/**
 * Verifies a GitHub Actions OIDC JWT: RS256 signature against GitHub's JWKS (cached in KV for
 * 24 h), `iss`, `aud` = `PUBLIC_URL`, `exp` and `nbf`. Returns the claims or `null`.
 */
export async function verifyGithubJwt(
  env: Pick<Env, "AUTH" | "PUBLIC_URL">,
  jwt: string,
  deps: AuthDeps = {},
): Promise<GithubClaims | null> {
  const now = deps.now?.() ?? Date.now();
  const nowSec = Math.floor(now / 1000);
  const audience = env.PUBLIC_URL?.replace(/\/+$/, "");
  if (!audience) return null;

  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [headerPart = "", payloadPart = "", signaturePart = ""] = parts;
  const header = decodeJsonSegment(headerPart);
  const claims = decodeJsonSegment(payloadPart);
  const signature = base64UrlDecode(signaturePart);
  if (header === null || claims === null || signature === null) return null;
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const { iss, aud, exp, nbf, repository, ref, workflow } = claims;
  if (iss !== GITHUB_ISSUER) return null;
  if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) return null;
  if (typeof exp !== "number" || exp <= nowSec) return null;
  if (nbf !== undefined && (typeof nbf !== "number" || nbf > nowSec + CLOCK_SKEW)) return null;
  if (typeof repository !== "string") return null;
  if (ref !== undefined && typeof ref !== "string") return null;
  if (workflow !== undefined && typeof workflow !== "string") return null;

  const jwk = await findSigningKey(env, header.kid, deps.fetch ?? fetch, now);
  if (jwk === null || typeof jwk.n !== "string" || typeof jwk.e !== "string") return null;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data))) return null;
  } catch {
    return null;
  }
  return claims as unknown as GithubClaims;
}

function matchesGhEntry(entry: GhAuthRecord, claims: GithubClaims): boolean {
  return (
    entry.repository === claims.repository &&
    (entry.ref === null || entry.ref === undefined || entry.ref === claims.ref) &&
    (entry.workflow === null || entry.workflow === undefined || entry.workflow === claims.workflow)
  );
}

async function findActiveEntry(
  record: CredentialRecord,
  id: string,
  now: number,
): Promise<GhAuthRecord | null> {
  for (const entry of record.auth) {
    if (entry.type === "gh" && isActive(entry, now) && (await authEntryId(entry)) === id) {
      return entry;
    }
  }
  return null;
}

/**
 * Verifies a `gh` secret (a GitHub Actions OIDC JWT) against the active `gh` entries of a
 * record. A positive result is cached in KV under `ghok:<sha256 of the JWT>` until the JWT
 * expires, so later requests skip the signature check; the cached entry must still be active.
 */
export async function verifyGh(
  env: Pick<Env, "AUTH" | "PUBLIC_URL">,
  record: CredentialRecord,
  jwt: string,
  deps: AuthDeps = {},
): Promise<GhAuthRecord | null> {
  const now = deps.now?.() ?? Date.now();
  const cacheKey = GH_OK_PREFIX + (await sha256Hex(jwt));

  const cached = await env.AUTH.get<CachedGhVerification>(cacheKey, "json");
  if (cached !== null && cached.project === record.project && cached.exp * 1000 > now) {
    const entry = await findActiveEntry(record, cached.entryId, now);
    if (entry !== null) return entry;
  }

  const claims = await verifyGithubJwt(env, jwt, deps);
  if (claims === null) return null;
  const match =
    record.auth.find(
      (e): e is GhAuthRecord => e.type === "gh" && isActive(e, now) && matchesGhEntry(e, claims),
    ) ?? null;
  if (match === null) return null;

  const ttl = claims.exp - Math.floor(now / 1000);
  if (ttl >= KV_MIN_TTL) {
    const value: CachedGhVerification = {
      project: record.project,
      entryId: await authEntryId(match),
      exp: claims.exp,
    };
    await env.AUTH.put(cacheKey, JSON.stringify(value), { expirationTtl: ttl });
  }
  return match;
}

// ---------------------------------------------------------------------------------------------
// Credential sources and authentication
// ---------------------------------------------------------------------------------------------

/** A credential record together with the auth entry that verified the secret. */
export interface ResolvedCredential {
  record: CredentialRecord;
  entryId: string;
}

/**
 * Where credential records come from. `KvSource` serves tokens without a source. `HttpSource`
 * (a provider from `AUTH_PROVIDERS`, see docs/spec.md "Record sources") is reserved: until it
 * exists, tokens naming a source are rejected with `401`; once it does, an unreachable
 * provider must throw `ValidationError("provider_unavailable")`.
 */
export interface CredentialSource {
  resolve(project: string, type: SecretType, secret: string): Promise<ResolvedCredential | null>;
}

/** Bindings and variables authentication needs. */
export type AuthEnv = Pick<Env, "AUTH" | "PUBLIC_URL" | "TOKEN_PREFIX">;

/** Credentials stored in KV under `cred:<project>`. */
export class KvSource implements CredentialSource {
  constructor(
    private readonly env: Pick<Env, "AUTH" | "PUBLIC_URL">,
    private readonly deps: AuthDeps = {},
  ) {}

  async resolve(
    project: string,
    type: SecretType,
    secret: string,
  ): Promise<ResolvedCredential | null> {
    const record = await getCredential(this.env, project);
    if (record === null) return null;
    const now = this.deps.now?.() ?? Date.now();
    const entry =
      type === "key"
        ? await verifyKey(record, secret, now)
        : await verifyGh(this.env, record, secret, this.deps);
    return entry === null ? null : { record, entryId: await authEntryId(entry) };
  }
}

/** The authenticated caller. */
export interface Identity {
  /** `[<source>.]<project>`, as recorded in `whoami` and `publishedBy`. */
  project: string;
  kind: Kind;
  /** Always `[]` for `admin`. */
  grants: Grant[];
  record: CredentialRecord;
  /** `id` of the auth entry that verified the secret. */
  entryId: string;
}

export interface Authentication {
  identity: Identity;
  via: SecretType;
}

/**
 * Authenticates a request by its `Authorization` header. Returns `null` when the header is
 * missing, malformed, or the credential cannot be verified (the caller answers `401`).
 */
export async function authenticate(
  request: Request,
  env: AuthEnv,
  deps: AuthDeps = {},
): Promise<Authentication | null> {
  const parsed = parseAuthorization(request.headers.get("authorization"), env.TOKEN_PREFIX ?? "");
  if (parsed === null) return null;
  // HttpSource is reserved: no provider is configured in v1, so a source is unknown (401).
  if (parsed.source !== null) return null;

  const resolved = await new KvSource(env, deps).resolve(
    parsed.project,
    parsed.type,
    parsed.secret,
  );
  if (resolved === null) return null;
  const { record, entryId } = resolved;
  return {
    identity: {
      project: parsed.login,
      kind: record.kind,
      grants: record.kind === "admin" ? [] : record.grants,
      record,
      entryId,
    },
    via: parsed.type,
  };
}

/** Throws `403 forbidden` unless the identity has one of the kinds. */
export function requireKind(identity: Pick<Identity, "kind">, ...kinds: Kind[]): void {
  if (!kinds.includes(identity.kind)) {
    throw new ValidationError("forbidden", "This credential may not perform this operation.");
  }
}

// ---------------------------------------------------------------------------------------------
// Panel sessions
// ---------------------------------------------------------------------------------------------

/** Name of the panel session cookie. */
export const SESSION_COOKIE = "sreg_session";
/** Session lifetime: 12 hours. */
export const SESSION_TTL = 12 * 60 * 60;

const SESSION_PREFIX = "session:";
const SESSION_ID_RE = /^[A-Za-z0-9]{32}$/;

/** The value stored at `session:<id>`. */
export interface Session {
  project: string;
  /** RFC 3339. */
  createdAt: string;
}

/** Creates a session for a local project and returns its id (32 base62 characters). */
export async function createSession(
  env: Pick<Env, "AUTH">,
  project: string,
  deps: Pick<AuthDeps, "now"> = {},
): Promise<string> {
  const id = randomBase62(32);
  const now = deps.now?.() ?? Date.now();
  const session: Session = {
    project,
    createdAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  await env.AUTH.put(SESSION_PREFIX + id, JSON.stringify(session), {
    expirationTtl: SESSION_TTL,
  });
  return id;
}

/** The session id from the request's `Cookie` header, if well formed. */
export function sessionIdFrom(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return SESSION_ID_RE.test(value) ? value : null;
  }
  return null;
}

/** Reads the session named by the request's `sreg_session` cookie. */
export async function readSession(
  request: Request,
  env: Pick<Env, "AUTH">,
): Promise<(Session & { id: string }) | null> {
  const id = sessionIdFrom(request);
  if (id === null) return null;
  const text = await env.AUTH.get(SESSION_PREFIX + id, "text");
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || typeof value.project !== "string") return null;
    const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
    return { id, project: value.project, createdAt };
  } catch {
    return null;
  }
}

/** Deletes a session (logout). */
export async function deleteSession(env: Pick<Env, "AUTH">, id: string): Promise<void> {
  await env.AUTH.delete(SESSION_PREFIX + id);
}

/** `Set-Cookie` value that stores a session id for 12 hours. */
export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}

/** `Set-Cookie` value that removes the session cookie. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** The identity behind a panel session, with the session's id. */
export interface SessionIdentity {
  identity: Identity;
  sessionId: string;
}

/**
 * Resolves the request's session cookie to the identity of its credential. Returns `null` when
 * there is no valid session, the credential no longer exists, or none of its auth entries is
 * still active (expiring every secret of a project also ends its panel sessions).
 */
export async function sessionIdentity(
  request: Request,
  env: Pick<Env, "AUTH">,
  deps: Pick<AuthDeps, "now"> = {},
): Promise<SessionIdentity | null> {
  const session = await readSession(request, env);
  if (session === null) return null;
  const record = await getCredential(env, session.project);
  if (record === null) return null;
  const now = deps.now?.() ?? Date.now();
  if (!record.auth.some((entry) => isActive(entry, now))) return null;
  return {
    identity: {
      project: record.project,
      kind: record.kind,
      grants: record.kind === "admin" ? [] : record.grants,
      record,
      entryId: "",
    },
    sessionId: session.id,
  };
}
