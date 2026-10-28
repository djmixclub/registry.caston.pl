/**
 * Guards against a Worker that was deployed against another R2 bucket than its data lives in
 * (a binding that was repointed or recreated). The installation has an id, kept in KV
 * (`installation_id`) and in the bucket (`_meta/installation.json`); while the two agree the
 * bucket is the one the installation has always used. When they do not, everything that reads
 * or writes packages answers `503 bucket_mismatch` instead of working on the wrong bucket, and
 * an admin confirms the bucket in the panel or with `POST /api/v1/bucket/accept`.
 *
 * Installations that predate the id adopt the bucket they find on the first request, unless
 * KV says they were initialised before (`schema_version`) while the bucket never was.
 */

import type { Env } from "../env";
import { ValidationError } from "./errors";
import { readSchemaVersion } from "./migrate";
import {
  hasPackagesMeta,
  rebuildPackagesMeta,
  readInstallationMarker,
  writeInstallationMarker,
} from "./storage";

export type BucketEnv = Pick<Env, "AUTH" | "R2_BUCKET">;

/** KV key of the installation id. */
export const INSTALLATION_ID_KEY = "installation_id";

/**
 * Why the bucket is not the installation's own: `empty` (it holds nothing of this installation:
 * no marker, or never initialised) or `other` (it carries another installation's marker).
 */
export type BucketProblem = "empty" | "other";

/** How long an isolate trusts a good answer, in milliseconds. */
export const BUCKET_OK_TTL_MS = 60_000;

let okUntil = 0;

/** Forgets that the bucket was found to be the right one (for tests and after a change). */
export function clearBucketCache(): void {
  okUntil = 0;
}

async function readInstallationId(env: Pick<Env, "AUTH">): Promise<string | null> {
  const raw = (await env.AUTH.get(INSTALLATION_ID_KEY, "text"))?.trim() ?? "";
  return raw === "" ? null : raw;
}

/** Stores a new id in the bucket (the first writer wins) and returns the id that is there. */
async function adoptBucket(env: BucketEnv): Promise<string> {
  await writeInstallationMarker(env, crypto.randomUUID());
  const id = await readInstallationMarker(env);
  if (id === null) throw new ValidationError("internal_error", "The bucket marker was not stored.");
  await env.AUTH.put(INSTALLATION_ID_KEY, id);
  return id;
}

async function inspect(env: BucketEnv): Promise<BucketProblem | null> {
  const [kvId, bucketId] = await Promise.all([
    readInstallationId(env),
    readInstallationMarker(env),
  ]);
  if (kvId !== null && bucketId === kvId) return null;
  if (kvId !== null) return bucketId === null ? "empty" : "other";
  if (bucketId !== null) {
    // KV was recreated; the bucket's own id is the installation's.
    await env.AUTH.put(INSTALLATION_ID_KEY, bucketId);
    return null;
  }
  // Neither has an id: a new installation, or one from before ids. KV that was initialised
  // while the bucket never was means the bucket was swapped before the id existed.
  if ((await readSchemaVersion(env)) > 0 && !(await hasPackagesMeta(env))) return "empty";
  await adoptBucket(env);
  return null;
}

/** The problem with the bucket, or `null` when it is the installation's own. */
export async function bucketProblem(env: BucketEnv): Promise<BucketProblem | null> {
  if (Date.now() < okUntil) return null;
  const problem = await inspect(env);
  if (problem === null) okUntil = Date.now() + BUCKET_OK_TTL_MS;
  return problem;
}

/** The `503` a mismatch answers with. */
export function bucketMismatchError(problem: BucketProblem): ValidationError {
  return new ValidationError(
    "bucket_mismatch",
    problem === "empty"
      ? "The R2 bucket is not the one this registry used before: it has no data of this installation. Check the R2_BUCKET binding, or confirm the bucket as an admin."
      : "The R2 bucket belongs to another installation. Check the R2_BUCKET binding, or confirm the bucket as an admin.",
    { reason: problem },
  );
}

/**
 * Makes the bucket this Worker is bound to the installation's own: a new id goes into the
 * bucket and into KV, and a bucket without `_meta/packages.json` gets it rebuilt (from its
 * manifests; an empty bucket gets an empty list).
 */
export async function acceptBucket(env: BucketEnv): Promise<void> {
  const id = crypto.randomUUID();
  await writeInstallationMarker(env, id, { replace: true });
  await env.AUTH.put(INSTALLATION_ID_KEY, id);
  if (!(await hasPackagesMeta(env))) await rebuildPackagesMeta(env);
  clearBucketCache();
}
