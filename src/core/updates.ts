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

/** What is cached: a release, or a failed check. */
export type CachedRelease = LatestRelease | { failed: true; checkedAt: string };

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
    if (value.failed === true) return { failed: true, checkedAt: value.checkedAt };
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

const REQUEST_HEADERS = { "user-agent": `serverless-registry/${VERSION}` };

/** `releases/latest` of the web UI redirects to the tag page; it has no per-IP API rate limit. */
async function fetchFromRedirect(fetcher: typeof fetch): Promise<Found | null> {
  const response = await fetcher(LATEST_RELEASE_PAGE_URL, {
    headers: REQUEST_HEADERS,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const location = response.headers.get("location") ?? "";
  if (!location.startsWith(RELEASE_TAG_PREFIX)) {
    throw new Error(`no tag redirect (HTTP ${response.status})`);
  }
  const tag = decodeURIComponent(location.slice(RELEASE_TAG_PREFIX.length));
  if (tag === "" || /[/?#]/.test(tag)) throw new Error("unexpected redirect target");
  return { tag, url: location };
}

async function fetchFromApi(fetcher: typeof fetch): Promise<Found | null> {
  const response = await fetcher(LATEST_RELEASE_URL, {
    headers: { ...REQUEST_HEADERS, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub API answered HTTP ${response.status}`);
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

/** Tries the release page redirect, then the API; logs why each failed. */
async function fetchLatest(fetcher: typeof fetch): Promise<Found | null> {
  for (const [name, attempt] of [
    ["release page", fetchFromRedirect],
    ["API", fetchFromApi],
  ] as const) {
    try {
      return await attempt(fetcher);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`update check via ${name} failed: ${reason}`);
    }
  }
  return null;
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
  if (!updatesEnabled(env)) return null;
  const cached = await readCache(cache);
  if (cached !== null && isFresh(cached, now)) return "failed" in cached ? null : cached;
  const found = await fetchLatest(fetcher);
  const checkedAt = rfc3339(now);
  if (found === null) {
    await storeLatestRelease({ failed: true, checkedAt }, cache);
    return null;
  }
  const release = { ...found, checkedAt };
  await storeLatestRelease(release, cache);
  return release;
}

/** How the running version compares with the latest release. */
export type UpdateStatus = "current" | "available" | "unknown";

/** Compares a release tag (an optional leading `v`) with the running version by semver. */
export function updateStatus(tag: string, current: string = VERSION): UpdateStatus {
  const version = tag.replace(/^v/i, "");
  if (parseVersion(version) === null || parseVersion(current) === null) return "unknown";
  return compareVersions(version, current) > 0 ? "available" : "current";
}
