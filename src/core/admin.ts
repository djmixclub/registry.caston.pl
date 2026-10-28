/**
 * Administration (docs/api.md 6.8–6.18): yanking, deleting and reindexing packages, managing
 * credentials and their secrets, and the first-run creation of an admin credential. Callers
 * check that the identity is an `admin`; these functions only validate input and act.
 */

import { getAdapter, validateRange } from "../adapters/index";
import type { Adapter, Eco, Manifest, ManifestFile } from "../adapters/types";
import type { Env } from "../env";
import {
  GH_EXTRA_FIELDS,
  KINDS,
  authEntryId,
  deleteCredential,
  formatToken,
  generateSecret,
  getCredential,
  hashPassword,
  hashSecret,
  isActive,
  isSlug,
  listCredentials,
  toAuthEntry,
  toCredential,
  writeCredential,
  type AuthEntry,
  type AuthRecordEntry,
  type Credential,
  type CredentialRecord,
  type GhAuthRecord,
  type Kind,
} from "./auth";
import { ValidationError } from "./errors";
import { syncGhRepoIndex } from "./ghindex";
import { validateGrants } from "./grants";
import { rebuildIndex } from "./publish";
import {
  addPackageToMeta,
  deleteIndexFiles,
  deleteVersion as deleteVersionObjects,
  isManifest,
  listManifests,
  manifestKey,
  readManifest,
  readPackagesMeta,
  removePackageFromMeta,
  removeVersionDeps,
  replacePackageDeps,
  setVersionDeps,
  updateJson,
} from "./storage";
import { parseTimestamp, rfc3339 } from "./time";

export type PackageAdminEnv = Pick<Env, "R2_BUCKET" | "AUTH" | "ECOSYSTEMS">;
export type CredentialAdminEnv = Pick<Env, "AUTH" | "TOKEN_PREFIX">;

/** One version as the API lists it (docs/api.md 6.6). */
export interface PackageVersion {
  version: string;
  published: string;
  yanked: boolean;
  files: ManifestFile[];
}

/** The API view of a version manifest. */
export function toPackageVersion(m: Manifest): PackageVersion {
  return { version: m.version, published: m.published, yanked: m.yanked, files: m.files };
}

function notFound(message = "Not found."): ValidationError {
  return new ValidationError("not_found", message);
}

function invalid(message: string): never {
  throw new ValidationError("invalid_request", message);
}

/** The enabled adapter of `eco`; `404` for an unknown or disabled ecosystem. */
export function requireAdapter(env: Pick<Env, "ECOSYSTEMS">, eco: string): Adapter {
  const adapter = getAdapter(env, eco);
  if (adapter === null) throw notFound("Unknown ecosystem.");
  return adapter;
}

/**
 * The stored form of a version from a path (NuGet: normalised, docs/api.md 1.3); `404` for a
 * version the ecosystem cannot have.
 */
function requireVersion(adapter: Adapter, version: string): string {
  if (version.includes("/") || !adapter.validateVersion(version)) {
    throw notFound("Version not found.");
  }
  return adapter.storedVersion?.(version) ?? version;
}

/** The stored form of a package name from a path (NuGet, Swift: lower case, docs/api.md 1.3). */
function storedName(adapter: Adapter, name: string): string {
  return adapter.storedName?.(name) ?? name;
}

/** Updates (or, without versions, removes) the package's meta entry. */
async function refreshMeta(
  env: PackageAdminEnv,
  eco: Eco,
  name: string,
  versions: number,
  now: Date,
): Promise<void> {
  if (versions === 0) await removePackageFromMeta(env, eco, name);
  else await addPackageToMeta(env, eco, name, { versions, updated: rfc3339(now) });
}

// ---------------------------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------------------------

/** `POST /api/v1/packages/<eco>/<name>/<version>/yank` (idempotent). */
export async function yank(
  env: PackageAdminEnv,
  eco: string,
  rawName: string,
  rawVersion: string,
  now: Date,
  publicUrl: string,
): Promise<{ eco: Eco; name: string } & PackageVersion> {
  const adapter = requireAdapter(env, eco);
  const version = requireVersion(adapter, rawVersion);
  const name = storedName(adapter, rawName);
  const manifest = await updateJson<Manifest>(
    env,
    manifestKey(adapter.eco, name, version),
    (current) => {
      if (current === null) throw notFound("Version not found.");
      return current.yanked ? current : { ...current, yanked: true };
    },
    { isValid: isManifest },
  );
  const manifests = await rebuildIndex(env, adapter, name, { publicUrl });
  // Yanked versions stay in the graph unmarked (they keep taking part in transitive access);
  // setting the entry again only repairs a graph that missed the version.
  await setVersionDeps(env, adapter.eco, name, version, adapter.dependencies(manifest));
  await refreshMeta(env, adapter.eco, name, manifests.length, now);
  return { eco: adapter.eco, name, ...toPackageVersion(manifest) };
}

/** `DELETE /api/v1/packages/<eco>/<name>/<version>`: the version can be published again. */
export async function deleteVersion(
  env: PackageAdminEnv,
  eco: string,
  rawName: string,
  rawVersion: string,
  now: Date,
  publicUrl: string,
): Promise<{ eco: Eco; name: string; version: string; deleted: true }> {
  const adapter = requireAdapter(env, eco);
  const version = requireVersion(adapter, rawVersion);
  const name = storedName(adapter, rawName);
  const manifest = await readManifest(env, adapter.eco, name, version);
  if (manifest === null) throw notFound("Version not found.");
  await deleteVersionObjects(env, adapter.eco, name, version);
  const ctx = { publicUrl };
  const manifests = await rebuildIndex(env, adapter, name, ctx);
  if (manifests.length === 0) {
    await deleteIndexFiles(
      env,
      adapter.buildIndex(name, [manifest], ctx).map((f) => f.key),
    );
  }
  await removeVersionDeps(env, adapter.eco, name, version);
  await refreshMeta(env, adapter.eco, name, manifests.length, now);
  return { eco: adapter.eco, name, version, deleted: true };
}

/** `DELETE /api/v1/packages/<eco>/<name>`: every version, the indexes and the meta entry. */
export async function deletePackage(
  env: PackageAdminEnv,
  eco: string,
  rawName: string,
  publicUrl: string,
): Promise<{ eco: Eco; name: string; deletedVersions: string[] }> {
  const adapter = requireAdapter(env, eco);
  const name = storedName(adapter, rawName);
  const manifests = await listManifests(env, adapter.eco, name, adapter.compareVersions);
  const listed = Object.hasOwn((await readPackagesMeta(env))[adapter.eco], name);
  if (manifests.length === 0 && !listed) throw notFound("Package not found.");
  for (const m of manifests) await deleteVersionObjects(env, adapter.eco, name, m.version);
  if (manifests.length > 0) {
    await deleteIndexFiles(
      env,
      adapter.buildIndex(name, manifests, { publicUrl }).map((f) => f.key),
    );
  }
  await removePackageFromMeta(env, adapter.eco, name);
  await replacePackageDeps(env, adapter.eco, name, new Map());
  return {
    eco: adapter.eco,
    name,
    deletedVersions: manifests.map((m) => m.version).reverse(),
  };
}

/**
 * `POST /api/v1/packages/<eco>/<name>/reindex`: rebuilds the index and the package's entries
 * of the dependency graph from the manifests.
 */
export async function reindex(
  env: PackageAdminEnv,
  eco: string,
  rawName: string,
  now: Date,
  publicUrl: string,
): Promise<{ eco: Eco; name: string; manifests: number }> {
  const adapter = requireAdapter(env, eco);
  const name = storedName(adapter, rawName);
  const manifests = await rebuildIndex(env, adapter, name, { publicUrl });
  if (manifests.length === 0) throw notFound("Package not found.");
  await replacePackageDeps(
    env,
    adapter.eco,
    name,
    new Map(manifests.map((m) => [m.version, adapter.dependencies(m)])),
  );
  await refreshMeta(env, adapter.eco, name, manifests.length, now);
  return { eco: adapter.eco, name, manifests: manifests.length };
}

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

/** `owner/repo`, or `owner/*` for every repository of an owner. */
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)$/;
const ENTRY_ID_PREFIX_RE = /^[0-9a-f]{8,12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks a `<project>` path parameter: a provider-backed name (with `.`) is
 * `400 invalid_request`, anything else that is not a slug cannot exist (`404`).
 */
export function checkProjectParam(project: string): void {
  if (project.includes(".")) invalid("Provider-backed projects are not managed here.");
  if (!isSlug(project)) throw notFound("Credential not found.");
}

async function requireCredential(
  env: CredentialAdminEnv,
  project: string,
): Promise<CredentialRecord> {
  checkProjectParam(project);
  const record = await getCredential(env, project, { fresh: true });
  if (record === null) throw notFound("Credential not found.");
  return record;
}

function parseExpires(value: unknown, field = "expires"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalid(`\`${field}\` must be a timestamp or null.`);
  const date = parseTimestamp(value);
  if (date === null) invalid(`\`${field}\` must be RFC 3339 or YYYY-MM-DD.`);
  return rfc3339(date);
}

function optionalClaim(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value === "") {
    invalid(`\`${field}\` must be a non-empty string or null.`);
  }
  return value;
}

/** An optional numeric GitHub id: a string of digits, or `null`. */
function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) {
    invalid(`\`${field}\` must be a string of digits or null.`);
  }
  return value;
}

/** Bounds of a user-chosen admin password, in characters (code points). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Checks a user-chosen password: 12 to 128 printable characters, any script, without `:`
 * (it separates the login from the password in a token) and without whitespace or control
 * characters (a token travels in an HTTP header, where `Bearer` ends at whitespace).
 */
function checkPassword(value: unknown): string {
  if (typeof value !== "string") invalid("`password` must be a string.");
  const length = [...value].length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    invalid(
      `\`password\` must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters long.`,
    );
  }
  if (/[:\s\p{Cc}\p{Cs}\p{Co}\p{Cn}]/u.test(value)) {
    invalid("`password` must be printable and contain no `:` and no whitespace.");
  }
  return value;
}

/** A new auth entry from a request body (docs/api.md 6.17) and, for `key`, its secret. */
async function newAuthEntry(
  spec: unknown,
  kind: Kind,
  existing: readonly AuthRecordEntry[],
  now: Date,
): Promise<{ entry: AuthRecordEntry; secret: string | null }> {
  if (!isRecord(spec)) invalid("The secret must be an object.");
  const { type, repository, ref, workflow, repository_id, repository_owner_id, environment } = spec;
  const { password } = spec;
  if (password !== undefined && type !== "key") {
    invalid("`password` only applies to `key` secrets.");
  }
  const pin = spec.pin_on_first_use;
  const expires = parseExpires(spec.expires);
  const created = rfc3339(now);
  if (type === "key") {
    const claims = [repository, ref, workflow, repository_id, repository_owner_id, environment];
    if (claims.some((value) => value !== undefined) || pin !== undefined) {
      invalid(
        "`repository`, `repository_id`, `repository_owner_id`, `ref`, `workflow`, " +
          "`environment` and `pin_on_first_use` only apply to `gh` secrets.",
      );
    }
    if (password !== undefined) {
      if (kind !== "admin") invalid("only admin credentials may use a password");
      const chosen = checkPassword(password);
      const hash = await hashPassword(chosen);
      return { entry: { type: "key", hash, created, expires }, secret: chosen };
    }
    const secret = generateSecret();
    return { entry: { type: "key", hash: await hashSecret(secret), created, expires }, secret };
  }
  if (type !== "gh") invalid("`type` must be `key` or `gh`.");
  if (typeof repository !== "string" || !REPOSITORY_RE.test(repository)) {
    invalid("`repository` must be `owner/repo` or `owner/*`.");
  }
  const entry: GhAuthRecord = {
    type: "gh",
    repository,
    ref: optionalClaim(ref, "ref"),
    workflow: optionalClaim(workflow, "workflow"),
    repository_id: optionalId(repository_id, "repository_id"),
    repository_owner_id: optionalId(repository_owner_id, "repository_owner_id"),
    environment: optionalClaim(environment, "environment"),
    pin_on_first_use: pinOnFirstUse(pin),
    created,
    expires,
  };
  const same = (e: GhAuthRecord) =>
    e.repository === entry.repository &&
    (e.ref ?? null) === entry.ref &&
    (e.workflow ?? null) === entry.workflow &&
    GH_EXTRA_FIELDS.every((field) => (e[field] ?? null) === entry[field]);
  const duplicate = existing.some((e) => e.type === "gh" && isActive(e, now.getTime()) && same(e));
  if (duplicate) invalid("An identical active `gh` entry already exists.");
  return { entry, secret: null };
}

/** `pin_on_first_use` of a new `gh` entry: a boolean, `true` when absent or `null`. */
function pinOnFirstUse(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "boolean") invalid("`pin_on_first_use` must be a boolean.");
  return value;
}

function isKind(value: unknown): value is Kind {
  return (KINDS as readonly unknown[]).includes(value);
}

function parseGrantsFor(kind: Kind, value: unknown) {
  if (value === undefined) return [];
  const grants = validateGrants(value, validateRange);
  if (kind === "admin" && grants.length > 0) invalid("Admin credentials have no grants.");
  return grants;
}

/** `GET /api/v1/credentials`: every KV credential, sorted by project. */
export async function listCredentialViews(
  env: CredentialAdminEnv,
): Promise<{ credentials: Credential[] }> {
  return { credentials: await Promise.all((await listCredentials(env)).map(toCredential)) };
}

/** `GET /api/v1/credentials/<project>`. */
export async function readCredentialView(
  env: CredentialAdminEnv,
  project: string,
): Promise<Credential> {
  return toCredential(await requireCredential(env, project));
}

async function storeNewCredential(
  env: CredentialAdminEnv,
  project: string,
  kind: Kind,
  grants: CredentialRecord["grants"],
  secretSpec: unknown,
  now: Date,
): Promise<{ credential: Credential; token?: string }> {
  if ((await getCredential(env, project, { fresh: true })) !== null)
    throw new ValidationError("credential_exists");
  const { entry, secret } = await newAuthEntry(secretSpec, kind, [], now);
  const record: CredentialRecord = { project, kind, auth: [entry], grants };
  await writeCredential(env, null, record);
  const credential = await toCredential(record);
  return secret === null
    ? { credential }
    : { credential, token: formatToken(project, secret, env.TOKEN_PREFIX ?? "") };
}

/** `POST /api/v1/credentials`: a credential with its first secret (default `key`). */
export async function createCredential(
  env: CredentialAdminEnv,
  body: Record<string, unknown>,
  now: Date,
): Promise<{ credential: Credential; token?: string }> {
  const { project, kind, grants, secret } = body;
  if (typeof project !== "string" || !isSlug(project)) {
    invalid("`project` must match [a-z0-9][a-z0-9-]{1,62}.");
  }
  if (!isKind(kind)) invalid("`kind` must be read, publish or admin.");
  const checked = parseGrantsFor(kind, grants);
  return storeNewCredential(env, project, kind, checked, secret ?? { type: "key" }, now);
}

/** `PATCH /api/v1/credentials/<project>`: replaces the grants and nothing else. */
export async function updateGrants(
  env: CredentialAdminEnv,
  project: string,
  body: Record<string, unknown>,
): Promise<Credential> {
  const record = await requireCredential(env, project);
  for (const field of ["project", "kind", "auth"]) {
    if (field in body) invalid(`\`${field}\` cannot be changed.`);
  }
  if (!("grants" in body)) invalid("`grants` is required.");
  const grants = parseGrantsFor(record.kind, body.grants);
  const updated = { ...record, grants };
  await writeCredential(env, record, updated);
  return toCredential(updated);
}

/** `DELETE /api/v1/credentials/<project>`; the last admin cannot be deleted (`403`). */
export async function removeCredential(
  env: CredentialAdminEnv,
  project: string,
): Promise<{ project: string; deleted: true }> {
  const record = await requireCredential(env, project);
  if (record.kind === "admin") {
    const admins = (await listCredentials(env)).filter((r) => r.kind === "admin");
    if (admins.length <= 1) {
      throw new ValidationError("forbidden", "The last admin credential cannot be deleted.");
    }
  }
  await deleteCredential(env, project);
  await syncGhRepoIndex(env, record, null);
  return { project, deleted: true };
}

/** `POST /api/v1/credentials/<project>/secrets`: adds an auth entry. */
export async function addSecret(
  env: CredentialAdminEnv,
  project: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<{ secret: AuthEntry; token?: string }> {
  const record = await requireCredential(env, project);
  const { entry, secret } = await newAuthEntry(body, record.kind, record.auth, now);
  await writeCredential(env, record, { ...record, auth: [...record.auth, entry] });
  const view = await toAuthEntry(entry);
  return secret === null
    ? { secret: view }
    : { secret: view, token: formatToken(project, secret, env.TOKEN_PREFIX ?? "") };
}

/**
 * `DELETE /api/v1/credentials/<project>/secrets/<hash-prefix>`: sets `expires` (default now; a
 * past value means now). An entry is never extended: an earlier existing `expires` is kept.
 */
export async function expireSecret(
  env: CredentialAdminEnv,
  project: string,
  idPrefix: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<{ secret: AuthEntry }> {
  const record = await requireCredential(env, project);
  if (!ENTRY_ID_PREFIX_RE.test(idPrefix)) {
    invalid("The secret id must be 8 to 12 lower-case hexadecimal characters.");
  }
  const ids = await Promise.all(record.auth.map(authEntryId));
  const matches = ids.flatMap((id, i) => (id.startsWith(idPrefix) ? [i] : []));
  if (matches.length === 0) throw notFound("Secret not found.");
  if (matches.length > 1) invalid("The secret id prefix is ambiguous.");
  const index = matches[0] ?? 0;
  const entry = record.auth[index];
  if (entry === undefined) throw notFound("Secret not found.");

  const requested = parseExpires(body.expires);
  let expires = Math.max(now.getTime(), requested === null ? 0 : Date.parse(requested));
  const current = entry.expires === null ? NaN : Date.parse(entry.expires);
  if (!Number.isNaN(current)) expires = Math.min(expires, current);
  const updated: AuthRecordEntry = { ...entry, expires: rfc3339(new Date(expires)) };
  const auth = record.auth.map((e, i) => (i === index ? updated : e));
  await writeCredential(env, record, { ...record, auth });
  return { secret: await toAuthEntry(updated) };
}

// ---------------------------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------------------------

/** Whether KV holds any credential at all. */
export async function hasAnyCredential(env: Pick<Env, "AUTH">): Promise<boolean> {
  const page = await env.AUTH.list({ prefix: "cred:", limit: 1 });
  return page.keys.length > 0;
}

/**
 * Creates the first `admin` credential with a `key` secret, generated or, with `password`, the
 * user-chosen password; only while no credential exists (`403 forbidden` afterwards).
 */
export async function createFirstAdmin(
  env: CredentialAdminEnv,
  project: string,
  now: Date,
  password?: string,
): Promise<{ credential: Credential; token: string }> {
  if (await hasAnyCredential(env)) {
    throw new ValidationError("forbidden", "The registry has already been set up.");
  }
  if (!isSlug(project)) invalid("The project must match [a-z0-9][a-z0-9-]{1,62}.");
  const { credential, token } = await storeNewCredential(
    env,
    project,
    "admin",
    [],
    password === undefined ? { type: "key" } : { type: "key", password },
    now,
  );
  if (token === undefined) throw new ValidationError("internal_error");
  return { credential, token };
}
