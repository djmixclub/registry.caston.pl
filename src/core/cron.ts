/**
 * The hourly `scheduled` cleanup (see "Publishing" in docs/spec.md): uncommitted uploads older
 * than 24 hours and auth entries whose `expires` has passed. Nothing else is touched; a
 * credential record is never deleted, even when its last entry expires.
 */

import type { Env } from "../env";
import { getCredential, listCredentials, putCredential, type AuthRecordEntry } from "./auth";
import { deleteStaging, listStaleStaging } from "./storage";

export type CronEnv = Pick<Env, "AUTH" | "R2_BUCKET">;

/** Age after which a staging upload (committed or not) is removed. */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CleanupResult {
  /** Upload ids whose `_staging/<upload-id>/` prefix was removed. */
  staleUploads: number;
  /** Objects deleted under those prefixes. */
  stagingObjects: number;
  /** Auth entries removed because they expired. */
  expiredSecrets: number;
  /** Credential records rewritten. */
  updatedCredentials: number;
}

/** Whether an entry has a parsable `expires` at or before `now`. Unparsable dates are kept. */
function isExpired(entry: AuthRecordEntry, now: number): boolean {
  if (entry.expires === null || entry.expires === undefined) return false;
  const expires = Date.parse(entry.expires);
  return !Number.isNaN(expires) && expires <= now;
}

async function cleanupStaging(
  env: CronEnv,
  now: Date,
): Promise<{ uploads: number; objects: number }> {
  const stale = await listStaleStaging(env, new Date(now.getTime() - STAGING_MAX_AGE_MS));
  let objects = 0;
  for (const uploadId of stale) objects += await deleteStaging(env, uploadId);
  return { uploads: stale.length, objects };
}

async function cleanupSecrets(
  env: CronEnv,
  now: Date,
): Promise<{ secrets: number; credentials: number }> {
  const time = now.getTime();
  let secrets = 0;
  let credentials = 0;
  for (const listed of await listCredentials(env)) {
    if (!listed.auth.some((e) => isExpired(e, time))) continue;
    // Read again right before writing to keep the window for a lost concurrent edit small.
    const record = await getCredential(env, listed.project);
    if (record === null) continue;
    const auth = record.auth.filter((e) => !isExpired(e, time));
    if (auth.length === record.auth.length) continue;
    await putCredential(env, { ...record, auth });
    secrets += record.auth.length - auth.length;
    credentials += 1;
  }
  return { secrets, credentials };
}

/** Runs the hourly cleanup at `now`. */
export async function cleanup(env: CronEnv, now: Date = new Date()): Promise<CleanupResult> {
  const [staging, auth] = await Promise.all([cleanupStaging(env, now), cleanupSecrets(env, now)]);
  return {
    staleUploads: staging.uploads,
    stagingObjects: staging.objects,
    expiredSecrets: auth.secrets,
    updatedCredentials: auth.credentials,
  };
}
