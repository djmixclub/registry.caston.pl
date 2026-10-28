/**
 * The only module that talks to R2 for package data: key layout, version manifests, generated
 * index files, `_meta/packages.json` and the staging area of uploads (see "Data layout" and
 * "Publishing" in docs/spec.md).
 */

import type { Eco, IndexFile, Manifest, ManifestFile } from "../adapters/types";
import { isEco, isManifestFile } from "../adapters/types";
import type { Env } from "../env";
import { ValidationError } from "./errors";
import { compareVersions, parseVersion } from "./semver";

export type StorageEnv = Pick<Env, "R2_BUCKET">;

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

const NAME_SEPARATOR = "__";
const STAGING_PREFIX = "_staging/";
const MANIFEST_FILE = "manifest.json";
const JSON_TYPE = "application/json";

/** Key of the list of all packages per ecosystem. */
export const PACKAGES_META_KEY = "_meta/packages.json";

/**
 * Encodes a package name for use as one key segment: `/` becomes `__`, `@` is kept
 * (`acme/sdk` → `acme__sdk`, `@acme/sdk` → `@acme__sdk`).
 */
export function encodePackageName(name: string): string {
  return name.replaceAll("/", NAME_SEPARATOR);
}

/**
 * Reverses {@link encodePackageName}. Composer and npm names contain exactly one `/`, so only
 * the first `__` is turned back into `/`; cargo names never contain `/` and are returned as
 * they are (a crate may be called `foo__bar`).
 */
export function decodePackageName(encoded: string, eco?: Eco): string {
  return eco === "cargo" ? encoded : encoded.replace(NAME_SEPARATOR, "/");
}

/** `<eco>/pkg/<name>/`: everything stored for one package. */
export function packagePrefix(eco: Eco, name: string): string {
  return `${eco}/pkg/${encodePackageName(name)}/`;
}

function versionPrefix(eco: Eco, name: string, version: string): string {
  if (version === "" || version.includes("/")) throw new TypeError("Invalid version.");
  return `${packagePrefix(eco, name)}${version}/`;
}

/** `<eco>/pkg/<name>/<version>/manifest.json`. */
export function manifestKey(eco: Eco, name: string, version: string): string {
  return versionPrefix(eco, name, version) + MANIFEST_FILE;
}

/** `<eco>/pkg/<name>/<version>/<file>`: one file (archive, binary, …) of a version. */
export function fileKey(eco: Eco, name: string, version: string, fileName: string): string {
  if (fileName === "" || fileName.includes("/") || fileName === MANIFEST_FILE) {
    throw new TypeError("Invalid file name.");
  }
  return versionPrefix(eco, name, version) + fileName;
}

/** `<eco>/index/<parts…>`, the parts joined with `/` as given (the adapter's layout). */
export function indexKey(eco: Eco, ...parts: string[]): string {
  return `${eco}/index/${parts.join("/")}`;
}

/** `_staging/<upload-id>/<file>`. */
export function stagingKey(uploadId: string, file: string): string {
  return `${stagingPrefix(uploadId)}${file}`;
}

/** `_staging/<upload-id>/meta.json`: the `init` declaration. */
export function stagingMetaKey(uploadId: string): string {
  return stagingKey(uploadId, "meta.json");
}

/** `_staging/<upload-id>/result.json`: the `commit` response, kept for idempotent retries. */
export function stagingResultKey(uploadId: string): string {
  return stagingKey(uploadId, "result.json");
}

function stagingPrefix(uploadId: string): string {
  if (uploadId === "" || uploadId.includes("/")) throw new TypeError("Invalid upload id.");
  return `${STAGING_PREFIX}${uploadId}/`;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(env: StorageEnv, key: string): Promise<unknown> {
  const object = await env.R2_BUCKET.get(key);
  if (object === null) return null;
  try {
    return JSON.parse(await object.text()) as unknown;
  } catch {
    return null;
  }
}

/** Every object under a prefix, following list cursors. */
async function listAll(env: StorageEnv, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.R2_BUCKET.list({ prefix, cursor });
    objects.push(...page.objects);
    if (!page.truncated) return objects;
    cursor = page.cursor;
  }
}

/** Deletes keys in batches of 1000 (the R2 limit); returns how many were deleted. */
async function deleteKeys(env: StorageEnv, keys: string[]): Promise<number> {
  for (let i = 0; i < keys.length; i += 1000) {
    await env.R2_BUCKET.delete(keys.slice(i, i + 1000));
  }
  return keys.length;
}

/**
 * Orders version strings by semver precedence; strings that are not valid semver sort before
 * valid ones, in byte order.
 */
function compareVersionStrings(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va && vb) return compareVersions(va, vb) || (a < b ? -1 : a > b ? 1 : 0);
  if (va) return 1;
  if (vb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------------------------

/** A non-empty list of well-formed files with unique names. */
function hasValidFiles(files: unknown): files is ManifestFile[] {
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every(isManifestFile) &&
    new Set(files.map((f) => f.name)).size === files.length
  );
}

function isManifest(value: unknown): value is Manifest {
  return (
    isRecord(value) &&
    isEco(value.eco) &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    hasValidFiles(value.files) &&
    typeof value.published === "string" &&
    typeof value.publishedBy === "string" &&
    typeof value.yanked === "boolean" &&
    isRecord(value.native)
  );
}

/** Reads a version manifest; `null` when missing or not a manifest. */
export async function readManifest(
  env: StorageEnv,
  eco: Eco,
  name: string,
  version: string,
): Promise<Manifest | null> {
  const value = await readJson(env, manifestKey(eco, name, version));
  return isManifest(value) ? value : null;
}

/** Whether the manifest of a version exists. */
export async function manifestExists(
  env: StorageEnv,
  eco: Eco,
  name: string,
  version: string,
): Promise<boolean> {
  return (await env.R2_BUCKET.head(manifestKey(eco, name, version))) !== null;
}

/**
 * Writes a version manifest under its own key. Versions are immutable: unless `overwrite` is
 * set (yank), the write is conditional on the key not existing, so of two concurrent commits
 * of one version exactly one succeeds and the other gets `409 version_exists`.
 */
export async function writeManifest(
  env: StorageEnv,
  manifest: Manifest,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const key = manifestKey(manifest.eco, manifest.name, manifest.version);
  const body = JSON.stringify(manifest);
  const httpMetadata = { contentType: JSON_TYPE };
  if (options.overwrite) {
    await env.R2_BUCKET.put(key, body, { httpMetadata });
    return;
  }
  if ((await env.R2_BUCKET.head(key)) !== null) throw new ValidationError("version_exists");
  const written = await env.R2_BUCKET.put(key, body, {
    httpMetadata,
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written === null) throw new ValidationError("version_exists");
}

/**
 * Deletes every object under the version prefix (manifest and all files); returns whether
 * anything was there.
 */
export async function deleteVersion(
  env: StorageEnv,
  eco: Eco,
  name: string,
  version: string,
): Promise<boolean> {
  const objects = await listAll(env, versionPrefix(eco, name, version));
  return (
    (await deleteKeys(
      env,
      objects.map((o) => o.key),
    )) > 0
  );
}

/** Every manifest of a package (yanked included), lowest version first. */
export async function listManifests(env: StorageEnv, eco: Eco, name: string): Promise<Manifest[]> {
  const prefix = packagePrefix(eco, name);
  const keys = (await listAll(env, prefix))
    .map((o) => o.key)
    .filter((key) => {
      const rest = key.slice(prefix.length).split("/");
      return rest.length === 2 && rest[1] === MANIFEST_FILE;
    });
  const values = await Promise.all(keys.map((key) => readJson(env, key)));
  return values.filter(isManifest).sort((a, b) => compareVersionStrings(a.version, b.version));
}

/** Decoded names of every package of an ecosystem that has anything stored, sorted. */
export async function listPackageNames(env: StorageEnv, eco: Eco): Promise<string[]> {
  const prefix = `${eco}/pkg/`;
  const names = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await env.R2_BUCKET.list({ prefix, delimiter: "/", cursor });
    for (const p of page.delimitedPrefixes) {
      names.add(decodePackageName(p.slice(prefix.length, -1), eco));
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------------------------
// Index files
// ---------------------------------------------------------------------------------------------

/** An index file as read from R2, with the etag for a conditional rewrite. */
export interface StoredIndex {
  body: string;
  etag: string;
}

/** Reads a generated index file; `null` when missing. */
export async function readIndex(env: StorageEnv, key: string): Promise<StoredIndex | null> {
  const object = await env.R2_BUCKET.get(key);
  if (object === null) return null;
  return { body: await object.text(), etag: object.etag };
}

/** Writes generated index files (unconditionally; they are always derived from manifests). */
export async function writeIndexFiles(env: StorageEnv, files: readonly IndexFile[]): Promise<void> {
  await Promise.all(
    files.map((f) =>
      env.R2_BUCKET.put(f.key, f.body, { httpMetadata: { contentType: f.contentType } }),
    ),
  );
}

/**
 * Deletes every index file whose key starts with `<eco>/index/<prefix>`; returns how many were
 * deleted. The prefix is matched literally, so callers end it with `/` or a full file name.
 */
export async function deleteIndexPrefix(
  env: StorageEnv,
  eco: Eco,
  prefix: string,
): Promise<number> {
  const objects = await listAll(env, indexKey(eco, prefix));
  return deleteKeys(
    env,
    objects.map((o) => o.key),
  );
}
