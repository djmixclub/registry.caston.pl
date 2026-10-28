/**
 * The update check (docs/spec.md "Deployment, configuration and updates"): unless
 * `CHECK_UPDATES` is set to something other than `true`, the panel compares the running version
 * with the latest GitHub release. GitHub is asked at most once a day; the answer is cached in KV
 * under `updates:latest`, and a failure is cached for an hour. The check never throws.
 */

import type { Env } from "../env";
import { VERSION } from "../version";
import { checkUpdates } from "./config";
import { compareVersions, parseVersion } from "./semver";
import { rfc3339 } from "./time";

/** The GitHub API URL of the latest release of the Worker. */
export const LATEST_RELEASE_URL =
  "https://api.github.com/repos/kduma-OSS/serverless-registry-worker/releases/latest";

/** KV key of the cached answer. */
export const UPDATES_KEY = "updates:latest";

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
type Cached = LatestRelease | { failed: true; checkedAt: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether update checks are enabled: `CHECK_UPDATES` unset, blank or `true` (case-insensitive). */
export function updatesEnabled(env: Pick<Env, "CHECK_UPDATES">): boolean {
  return checkUpdates(env);
}

function isFresh(cached: Cached, now: Date): boolean {
  const checked = Date.parse(cached.checkedAt);
  const ttl = "failed" in cached ? FAILURE_TTL : RELEASE_TTL;
  return !Number.isNaN(checked) && now.getTime() - checked < ttl * 1000;
}

async function readCache(env: Pick<Env, "AUTH">): Promise<Cached | null> {
  try {
    const value = await env.AUTH.get<unknown>(UPDATES_KEY, "json");
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

async function writeCache(env: Pick<Env, "AUTH">, value: Cached): Promise<void> {
  const ttl = "failed" in value ? FAILURE_TTL : RELEASE_TTL;
  try {
    await env.AUTH.put(UPDATES_KEY, JSON.stringify(value), { expirationTtl: ttl });
  } catch {
    // Caching is best-effort; the next check simply asks GitHub again.
  }
}

async function fetchLatest(fetcher: typeof fetch): Promise<{ tag: string; url: string } | null> {
  try {
    const response = await fetcher(LATEST_RELEASE_URL, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `serverless-registry/${VERSION}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body)) return null;
    const { tag_name: tag, html_url: url } = body;
    if (typeof tag !== "string" || tag === "" || typeof url !== "string") return null;
    // Only a GitHub page is ever linked from the panel.
    if (!url.startsWith("https://github.com/")) return null;
    return { tag, url };
  } catch {
    return null;
  }
}

/**
 * The latest release, from the KV cache or from GitHub; `null` when checks are disabled or the
 * check failed (a failure is cached for an hour). Never throws.
 */
export async function latestRelease(
  env: Pick<Env, "AUTH" | "CHECK_UPDATES">,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<LatestRelease | null> {
  if (!updatesEnabled(env)) return null;
  const cached = await readCache(env);
  if (cached !== null && isFresh(cached, now)) return "failed" in cached ? null : cached;
  const found = await fetchLatest(fetcher);
  const checkedAt = rfc3339(now);
  if (found === null) {
    await writeCache(env, { failed: true, checkedAt });
    return null;
  }
  const release = { ...found, checkedAt };
  await writeCache(env, release);
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
