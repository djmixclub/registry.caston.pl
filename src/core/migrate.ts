/**
 * Data migrations (see "Deployment, configuration and updates" in docs/spec.md). KV holds the
 * data schema version in `schema_version`; on the first request after a deploy the Worker runs
 * every migration above the stored version, in order. Migrations are small and idempotent, so
 * running one twice (two isolates racing past the best-effort lock) is harmless.
 */

import type { Env } from "../env";
import { SCHEMA_VERSION } from "../version";
import { PACKAGES_META_KEY, rebuildPackagesMeta } from "./storage";

export type MigrateEnv = Pick<Env, "AUTH" | "R2_BUCKET">;

/** KV key of the data schema version (an integer; missing = 0). */
export const SCHEMA_VERSION_KEY = "schema_version";
/** KV key of the best-effort lock held while migrations run. */
export const MIGRATE_LOCK_KEY = "migrate:lock";
/** Lifetime of the lock in seconds, so a crashed run never blocks migrations for long. */
export const MIGRATE_LOCK_TTL = 300;

/** One step that brings the data to schema version `to`. */
export interface Migration {
  to: number;
  run(env: MigrateEnv): Promise<void>;
}

/** Every migration, in ascending `to` order. */
export const MIGRATIONS: readonly Migration[] = [
  {
    // 1: `_meta/packages.json` exists (rebuilt from the manifests when missing).
    to: 1,
    async run(env) {
      if ((await env.R2_BUCKET.head(PACKAGES_META_KEY)) === null) await rebuildPackagesMeta(env);
    },
  },
];

/** The stored schema version; 0 when missing or not a non-negative integer. */
export async function readSchemaVersion(env: Pick<Env, "AUTH">): Promise<number> {
  const raw = (await env.AUTH.get(SCHEMA_VERSION_KEY, "text"))?.trim() ?? "";
  const value = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(value) ? value : 0;
}

export interface MigrationResult {
  /** `current`: nothing to do; `migrated`: migrations ran; `locked`: another run holds the lock. */
  status: "current" | "migrated" | "locked";
  from: number;
  to: number;
  /** The `to` of every migration that ran. */
  ran: number[];
}

/**
 * Runs the migrations above the stored schema version up to `target` (default
 * {@link SCHEMA_VERSION}), storing the version after each step. A stored version above the
 * target (an older Worker deployed over newer data) is left alone.
 */
export async function runMigrations(
  env: MigrateEnv,
  options: { migrations?: readonly Migration[]; target?: number } = {},
): Promise<MigrationResult> {
  const migrations = [...(options.migrations ?? MIGRATIONS)].sort((a, b) => a.to - b.to);
  const target = options.target ?? SCHEMA_VERSION;
  const from = await readSchemaVersion(env);
  if (from >= target) return { status: "current", from, to: from, ran: [] };

  if ((await env.AUTH.get(MIGRATE_LOCK_KEY)) !== null) {
    return { status: "locked", from, to: from, ran: [] };
  }
  const token = crypto.randomUUID();
  await env.AUTH.put(MIGRATE_LOCK_KEY, token, { expirationTtl: MIGRATE_LOCK_TTL });

  const ran: number[] = [];
  try {
    for (const migration of migrations) {
      if (migration.to <= from || migration.to > target) continue;
      await migration.run(env);
      await env.AUTH.put(SCHEMA_VERSION_KEY, String(migration.to));
      ran.push(migration.to);
    }
    if ((ran.at(-1) ?? from) < target) await env.AUTH.put(SCHEMA_VERSION_KEY, String(target));
  } finally {
    if ((await env.AUTH.get(MIGRATE_LOCK_KEY)) === token) await env.AUTH.delete(MIGRATE_LOCK_KEY);
  }
  return { status: "migrated", from, to: target, ran };
}

let migrated = false;
let pending: Promise<void> | null = null;

/**
 * Runs the migrations once per isolate, blocking the first request(s) until they finish;
 * concurrent requests share one run. A failed run, or one skipped because another isolate
 * holds the lock, is retried on the next request.
 */
export async function ensureMigrated(env: MigrateEnv): Promise<void> {
  if (migrated) return;
  pending ??= runMigrations(env).then(
    (result) => {
      migrated = result.status !== "locked";
      pending = null;
    },
    (err: unknown) => {
      pending = null;
      throw err;
    },
  );
  await pending;
}

/** Forgets that this isolate has migrated (for tests). */
export function resetMigrationState(): void {
  migrated = false;
  pending = null;
}
