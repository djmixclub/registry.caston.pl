/**
 * The update check (docs/spec.md "Deployment, configuration and updates"): unless
 * `CHECK_UPDATES` is set to something other than `true`, the panel compares the running version
 * with the latest GitHub release. GitHub is asked at most once a day; the answer is cached in
 * the Cache API under {@link UPDATES_CACHE_URL} (no KV write), and a failure is cached for an
 * hour. The check never throws.
 */

import type { Env } from "../env";
import { VERSION } from "../version";
import { checkUpdates } from "./config";
import { compareVersions, parseVersion } from "./semver";
import { rfc3339 } from "./time";

/** The GitHub API URL of the latest release of the Worker. */
export const LATEST_RELEASE_URL =
  "https://api.github.com/repos/kduma-OSS/serverless-registry-worker/releases/latest";

/** The release page that redirects to the tag page of the latest stable release. */
export const LATEST_RELEASE_PAGE_URL =
  "https://github.com/kduma-OSS/serverless-registry-worker/releases/latest";

const RELEASE_TAG_PREFIX = "https://github.com/kduma-OSS/serverless-registry-worker/releases/tag/";

/**
 * Synthetic URL under which the answer is kept in the Cache API (`caches.default`); it is never
 * fetched. The cache is per data centre, so each one asks GitHub at most once a day.
 */
export const UPDATES_CACHE_URL = "https://cache.internal/updates/latest";

/** The part of the Cache API the release check uses. */
export type UpdatesCache = Pick<Cache, "match" | "put">;

/** How long a release is cached: 24 hours. */
export const RELEASE_TTL = 24 * 60 * 60;

/** How long a failed check is cached: 1 hour. */
export const FAILURE_TTL = 60 * 60;

/** How long GitHub may take to answer. */
const TIMEOUT_MS = 5000;

/** The latest release as the panel shows it. */
export interface LatestRelease {
  /** The release tag, e.g. `v1.2.0`. */
  tag: string;
  /** The release page on GitHub. */
  url: string;
  /** RFC 3339 time of the check. */
  checkedAt: string;
}

/** What is cached: a release, or a failed check with what went wrong in each attempt. */
export type CachedRelease = LatestRelease | { failed: true; checkedAt: string; errors?: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether update checks are enabled: `CHECK_UPDATES` unset, blank or `true` (case-insensitive). */
export function updatesEnabled(env: Pick<Env, "CHECK_UPDATES">): boolean {
  return checkUpdates(env);
}

function isFresh(cached: CachedRelease, now: Date): boolean {
  const checked = Date.parse(cached.checkedAt);
  const ttl = "failed" in cached ? FAILURE_TTL : RELEASE_TTL;
  return !Number.isNaN(checked) && now.getTime() - checked < ttl * 1000;
}

async function readCache(cache: UpdatesCache): Promise<CachedRelease | null> {
  try {
    const response = await cache.match(UPDATES_CACHE_URL);
    if (response === undefined) return null;
    const value: unknown = await response.json();
    if (!isRecord(value) || typeof value.checkedAt !== "string") return null;
    if (value.failed === true) {
      const errors = Array.isArray(value.errors)
        ? value.errors.filter((e): e is string => typeof e === "string")
        : [];
      return { failed: true, checkedAt: value.checkedAt, errors };
    }
    if (typeof value.tag === "string" && typeof value.url === "string") {
      return { tag: value.tag, url: value.url, checkedAt: value.checkedAt };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Caches an answer of the release check: a release for 24 hours, a failure for an hour
 * (`Cache-Control: max-age`). Best-effort: a cache failure is ignored.
 */
export async function storeLatestRelease(
  value: CachedRelease,
  cache: UpdatesCache = caches.default,
): Promise<void> {
  const ttl = "failed" in value ? FAILURE_TTL : RELEASE_TTL;
  try {
    await cache.put(
      UPDATES_CACHE_URL,
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
      }),
    );
  } catch {
    // Caching is best-effort; the next check simply asks GitHub again.
  }
}

interface Found {
  tag: string;
  url: string;
}

/** The outcome of asking GitHub: the release, or one message per failed attempt. */
type Fetched = { found: Found } | { errors: string[] };

const REQUEST_HEADERS = { "user-agent": `serverless-registry/${VERSION}` };

/** `releases/latest` of the web UI redirects to the tag page; it has no per-IP API rate limit. */
async function fetchFromRedirect(fetcher: typeof fetch): Promise<Found> {
  const response = await fetcher(LATEST_RELEASE_PAGE_URL, {
    headers: REQUEST_HEADERS,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const location = response.headers.get("location") ?? "";
  if (!location.startsWith(RELEASE_TAG_PREFIX)) {
    throw new Error(
      `no tag redirect: HTTP ${response.status}, Location ${JSON.stringify(location.slice(0, 200))}`,
    );
  }
  const tag = decodeURIComponent(location.slice(RELEASE_TAG_PREFIX.length));
  if (tag === "" || /[/?#]/.test(tag)) throw new Error("unexpected redirect target");
  return { tag, url: location };
}

async function fetchFromApi(fetcher: typeof fetch): Promise<Found> {
  const response = await fetcher(LATEST_RELEASE_URL, {
    headers: { ...REQUEST_HEADERS, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("unexpected API body");
  const { tag_name: tag, html_url: url } = body;
  if (typeof tag !== "string" || tag === "" || typeof url !== "string") {
    throw new Error("unexpected API body");
  }
  // Only a GitHub page is ever linked from the panel.
  if (!url.startsWith("https://github.com/")) throw new Error("unexpected release URL");
  return { tag, url };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Tries the release page redirect, then the API; logs and reports why each failed. */
async function fetchLatest(fetcher: typeof fetch): Promise<Fetched> {
  const errors: string[] = [];
  for (const [name, attempt] of [
    ["release page", fetchFromRedirect],
    ["API", fetchFromApi],
  ] as const) {
    try {
      return { found: await attempt(fetcher) };
    } catch (error) {
      const message = `${name} (${name === "API" ? LATEST_RELEASE_URL : LATEST_RELEASE_PAGE_URL}): ${describe(error)}`;
      console.warn(`update check failed via ${message}`);
      errors.push(message);
    }
  }
  return { errors };
}

/**
 * The latest release, from the Cache API or from GitHub; `null` when checks are disabled or the
 * check failed (a failure is cached for an hour). Never throws.
 */
export async function latestRelease(
  env: Pick<Env, "CHECK_UPDATES">,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
  cache: UpdatesCache = caches.default,
): Promise<LatestRelease | null> {
  return (await checkLatestRelease(env, fetcher, now, cache, false)).release;
}

/** The answer of an update check, with what went wrong when there is no release. */
export interface UpdateCheck {
  release: LatestRelease | null;
  /** One message per failed attempt; empty on success, or from the cache when it has none. */
  errors: string[];
}

/**
 * Like {@link latestRelease}, but reports the error messages and, with `force`, ignores the
 * cache and asks GitHub now (the answer replaces the cached one). Never throws.
 */
export async function checkLatestRelease(
  env: Pick<Env, "CHECK_UPDATES">,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
  cache: UpdatesCache = caches.default,
  force = false,
): Promise<UpdateCheck> {
  if (!updatesEnabled(env)) return { release: null, errors: [] };
  if (!force) {
    const cached = await readCache(cache);
    if (cached !== null && isFresh(cached, now)) {
      return "failed" in cached
        ? { release: null, errors: cached.errors ?? [] }
        : { release: cached, errors: [] };
    }
  }
  const fetched = await fetchLatest(fetcher);
  const checkedAt = rfc3339(now);
  if ("errors" in fetched) {
    await storeLatestRelease({ failed: true, checkedAt, errors: fetched.errors }, cache);
    return { release: null, errors: fetched.errors };
  }
  const release = { ...fetched.found, checkedAt };
  await storeLatestRelease(release, cache);
  return { release, errors: [] };
}

/**
 * The latest release for a page header, without waiting for GitHub: the cached answer, and
 * while there is no fresh one the check runs in the background (`waitUntil`) for the next page.
 * `null` when checks are disabled or nothing is known. Never throws.
 */
export async function releaseForHeader(
  env: Pick<Env, "CHECK_UPDATES">,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
  waitUntil?: (promise: Promise<unknown>) => void,
  cache: UpdatesCache = caches.default,
): Promise<LatestRelease | null> {
  if (!updatesEnabled(env)) return null;
  const cached = await readCache(cache);
  if ((cached === null || !isFresh(cached, now)) && waitUntil !== undefined) {
    waitUntil(checkLatestRelease(env, fetcher, now, cache));
  }
  return cached === null || "failed" in cached ? null : cached;
}

/** How the running version compares with the latest release. */
export type UpdateStatus = "current" | "available" | "unknown";

/** Compares a release tag (an optional leading `v`) with the running version by semver. */
export function updateStatus(tag: string, current: string = VERSION): UpdateStatus {
  const version = tag.replace(/^v/i, "");
  if (parseVersion(version) === null || parseVersion(current) === null) return "unknown";
  return compareVersions(version, current) > 0 ? "available" : "current";
}
