/**
 * The `gh-repo:<owner/repo>` index in KV (docs/api.md 2.5): for every repository named by a
 * `gh` auth entry (`owner/repo`, or `owner/*` for owner globs), the JSON array of the projects
 * whose credential has such an entry. It lets the reserved login `_:gh.<jwt>` find the
 * candidate credentials of a token from its `repository` claim. Keys are lower-cased because
 * GitHub names are case-insensitive. Every credential write keeps it in step
 * ({@link syncGhRepoIndex}); data migration 2 rebuilds it ({@link rebuildGhRepoIndex}).
 */

import type { Env } from "../env";
import type { CredentialRecord } from "./auth";
import { IsolateCache } from "./isolatecache";

/** KV key prefix of the index. */
export const GH_REPO_PREFIX = "gh-repo:";

type IndexEnv = Pick<Env, "AUTH">;

/** Index lists read or written by this isolate, by KV key, served for up to 60 seconds. */
const indexCache = new IsolateCache<string[]>();

/** Forgets every index list cached by this isolate (tests). */
export function clearGhRepoIndexCache(): void {
  indexCache.clear();
}

/** The index key of a `gh` entry's `repository` (`owner/repo` or `owner/*`). */
export function ghRepoKey(repository: string): string {
  return GH_REPO_PREFIX + repository.toLowerCase();
}

/** The index keys a record belongs under: one per distinct `gh` repository. */
export function ghRepoKeys(record: CredentialRecord | null): Set<string> {
  const keys = new Set<string>();
  for (const entry of record?.auth ?? []) {
    if (entry.type === "gh") keys.add(ghRepoKey(entry.repository));
  }
  return keys;
}

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseIndex(text: string | null): string[] {
  if (text === null) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The projects stored under an index key; `[]` when missing or malformed. Served from the
 * isolate cache for up to 60 seconds unless `fresh` (read-modify-write).
 */
export async function readGhRepoIndex(
  env: IndexEnv,
  key: string,
  options: { now?: number; fresh?: boolean } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const cached = options.fresh ? undefined : indexCache.get(key, now);
  if (cached !== undefined) return cached;
  const projects = parseIndex(await env.AUTH.get(key, "text"));
  indexCache.set(key, projects, now);
  return projects;
}

async function writeGhRepoIndex(env: IndexEnv, key: string, projects: string[]): Promise<void> {
  const sorted = [...new Set(projects)].sort(byteOrder);
  if (sorted.length === 0) await env.AUTH.delete(key);
  else await env.AUTH.put(key, JSON.stringify(sorted));
  indexCache.set(key, sorted);
}

/**
 * The candidate projects of a token's `repository` claim: the union of
 * `gh-repo:<owner/repo>` and `gh-repo:<owner>/*`, sorted.
 */
export async function ghRepoCandidates(
  env: IndexEnv,
  repository: string,
  now: number = Date.now(),
): Promise<string[]> {
  const slash = repository.indexOf("/");
  if (slash <= 0) return [];
  const keys = [ghRepoKey(repository), ghRepoKey(`${repository.slice(0, slash)}/*`)];
  const lists = await Promise.all(keys.map((key) => readGhRepoIndex(env, key, { now })));
  return [...new Set(lists.flat())].sort(byteOrder);
}

/**
 * Brings the index in step with one credential write: the project is removed from the keys
 * only `previous` had and added to every key of `next` (so a lost earlier update heals on the
 * next write). `null` stands for a credential that did not exist (create) or no longer exists
 * (delete). Keys whose list does not change are not written.
 */
export async function syncGhRepoIndex(
  env: IndexEnv,
  previous: CredentialRecord | null,
  next: CredentialRecord | null,
): Promise<void> {
  const project = next?.project ?? previous?.project;
  if (project === undefined) return;
  const before = ghRepoKeys(previous);
  const after = ghRepoKeys(next);
  const keys = new Set([...before, ...after]);
  await Promise.all(
    [...keys].map(async (key) => {
      const current = await readGhRepoIndex(env, key, { fresh: true });
      const listed = current.includes(project);
      if (after.has(key) && !listed) {
        await writeGhRepoIndex(env, key, [...current, project]);
      } else if (!after.has(key) && listed) {
        await writeGhRepoIndex(
          env,
          key,
          current.filter((p) => p !== project),
        );
      }
    }),
  );
}

/**
 * Rebuilds the whole index from the given credential records: writes every key the records
 * need and deletes every other `gh-repo:` key. Returns the number of keys written.
 */
export async function rebuildGhRepoIndex(
  env: IndexEnv,
  records: readonly CredentialRecord[],
): Promise<number> {
  const wanted = new Map<string, string[]>();
  for (const record of records) {
    for (const key of ghRepoKeys(record))
      wanted.set(key, [...(wanted.get(key) ?? []), record.project]);
  }
  const existing: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.AUTH.list({ prefix: GH_REPO_PREFIX, cursor });
    existing.push(...page.keys.map((k) => k.name));
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  await Promise.all(
    existing.filter((key) => !wanted.has(key)).map((key) => writeGhRepoIndex(env, key, [])),
  );
  await Promise.all([...wanted].map(([key, projects]) => writeGhRepoIndex(env, key, projects)));
  return wanted.size;
}
