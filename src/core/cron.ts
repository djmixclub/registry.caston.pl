/**
 * The hourly `scheduled` cleanup (see "Publishing" in docs/spec.md): uncommitted uploads older
 * than 24 hours and auth entries whose `expires` has passed. Nothing else is touched; a
 * credential record is never deleted, even when its last entry expires.
 */

import { ADAPTERS } from "../adapters/index";
import { ECOS } from "../adapters/types";
import type { Env } from "../env";
import { getCredential, listCredentials, putCredential, type AuthRecordEntry } from "./auth";
import { syncGhRepoIndex } from "./ghindex";
import {
  deleteStaging,
  listManifests,
  listStaleStaging,
  packageMetaEntry,
  readPackagesMeta,
  upgradePackagesMeta,
} from "./storage";

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
  /** Packages whose entry in `_meta/packages.json` got the description of its versions. */
  upgradedPackages: number;
}

/**
 * The packages given the description of their versions in one run. Each costs a listing and a
 * read of every manifest, so a run stays well inside the limits of a Worker invocation; an
 * old registry is caught up over several runs.
 */
export const META_UPGRADES_PER_RUN = 20;

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
    const record = await getCredential(env, listed.project, { fresh: true });
    if (record === null) continue;
    const auth = record.auth.filter((e) => !isExpired(e, time));
    if (auth.length === record.auth.length) continue;
    const next = { ...record, auth };
    await putCredential(env, next);
    await syncGhRepoIndex(env, record, next);
    secrets += record.auth.length - auth.length;
    credentials += 1;
  }
  return { secrets, credentials };
}

/**
 * Gives the packages whose entry in `_meta/packages.json` was written by an older release (no
 * version numbers) the full description, up to {@link META_UPGRADES_PER_RUN} of them, so that
 * the package lists can do without listing and reading the bucket for them. A package changed
 * meanwhile is left to the next run.
 */
export async function upgradePackageEntries(
  env: CronEnv,
  limit: number = META_UPGRADES_PER_RUN,
): Promise<number> {
  const meta = await readPackagesMeta(env);
  const old = ECOS.flatMap((eco) =>
    Object.entries(meta[eco])
      .filter(([, entry]) => entry.names === undefined)
      .map(([name, entry]) => ({ eco, name, updated: entry.updated })),
  ).slice(0, limit);
  const upgrades = [];
  for (const { eco, name, updated } of old) {
    const adapter = ADAPTERS[eco];
    const manifests = await listManifests(env, eco, name, adapter.compareVersions);
    if (manifests.length === 0) continue;
    upgrades.push({
      eco,
      name,
      expectedUpdated: updated,
      entry: packageMetaEntry(adapter, manifests, updated),
    });
  }
  return upgradePackagesMeta(env, upgrades);
}

/** Runs the hourly cleanup at `now`. */
export async function cleanup(env: CronEnv, now: Date = new Date()): Promise<CleanupResult> {
  const [staging, auth, upgraded] = await Promise.all([
    cleanupStaging(env, now),
    cleanupSecrets(env, now),
    upgradePackageEntries(env),
  ]);
  return {
    upgradedPackages: upgraded,
    staleUploads: staging.uploads,
    stagingObjects: staging.objects,
    expiredSecrets: auth.secrets,
    updatedCredentials: auth.credentials,
  };
}
