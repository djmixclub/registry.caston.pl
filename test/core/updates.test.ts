import { beforeEach, describe, expect, it } from "vitest";
import {
  FAILURE_TTL,
  LATEST_RELEASE_URL,
  RELEASE_TTL,
  UPDATES_CACHE_URL,
  latestRelease,
  storeLatestRelease,
  updateStatus,
  updatesEnabled,
  type UpdatesCache,
} from "../../src/core/updates";
import { updateLine } from "../../src/pages/settings";
import { VERSION } from "../../src/version";

const NOW = new Date("2026-10-28T10:00:00Z");
const enabled = { CHECK_UPDATES: "true" };

interface FakeFetch {
  fetch: typeof fetch;
  calls: { url: string; headers: Headers }[];
}

function fakeFetch(respond: () => Response | Promise<Response>): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return respond();
  };
  return { fetch: fetcher as typeof fetch, calls };
}

/** An in-memory stand-in for `caches.default` that ignores `max-age`. */
class MemoryCache implements UpdatesCache {
  readonly entries = new Map<string, { body: string; headers: Headers }>();
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const entry = this.entries.get(String(request));
    return entry === undefined ? undefined : new Response(entry.body, { headers: entry.headers });
  }
  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(String(request), { body: await response.text(), headers: response.headers });
  }
  stored(): unknown {
    const entry = this.entries.get(UPDATES_CACHE_URL);
    return entry === undefined ? null : (JSON.parse(entry.body) as unknown);
  }
  maxAge(): string | null {
    return this.entries.get(UPDATES_CACHE_URL)?.headers.get("cache-control") ?? null;
  }
}

const release = () =>
  Response.json({
    tag_name: "v9.0.0",
    html_url: "https://github.com/kduma-OSS/serverless-registry-worker/releases/tag/v9.0.0",
  });

let cache: MemoryCache;

beforeEach(() => {
  cache = new MemoryCache();
});

describe("latestRelease", () => {
  it("does nothing when CHECK_UPDATES is set to anything but true", async () => {
    const fake = fakeFetch(release);
    expect(updatesEnabled({ CHECK_UPDATES: "false" })).toBe(false);
    expect(updatesEnabled({ CHECK_UPDATES: " TRUE " })).toBe(true);
    expect(updatesEnabled({})).toBe(true);
    expect(await latestRelease({ CHECK_UPDATES: "false" }, fake.fetch, NOW, cache)).toBeNull();
    expect(fake.calls).toHaveLength(0);
    expect(cache.entries.size).toBe(0);
  });

  it("asks GitHub once and caches the release for 24 hours", async () => {
    const fake = fakeFetch(release);
    const first = await latestRelease(enabled, fake.fetch, NOW, cache);
    expect(first).toEqual({
      tag: "v9.0.0",
      url: "https://github.com/kduma-OSS/serverless-registry-worker/releases/tag/v9.0.0",
      checkedAt: "2026-10-28T10:00:00Z",
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe(LATEST_RELEASE_URL);
    expect(fake.calls[0]?.headers.get("user-agent")).toBe(`serverless-registry/${VERSION}`);
    expect(cache.stored()).toEqual(first);
    expect(cache.maxAge()).toBe(`max-age=${RELEASE_TTL}`);

    const later = new Date(NOW.getTime() + 23 * 3600 * 1000);
    expect(await latestRelease(enabled, fake.fetch, later, cache)).toEqual(first);
    expect(fake.calls).toHaveLength(1);

    const nextDay = new Date(NOW.getTime() + 25 * 3600 * 1000);
    await latestRelease(enabled, fake.fetch, nextDay, cache);
    expect(fake.calls).toHaveLength(2);
  });

  it("returns null on failures and caches them for an hour", async () => {
    const failing = fakeFetch(() => new Response("rate limited", { status: 403 }));
    expect(await latestRelease(enabled, failing.fetch, NOW, cache)).toBeNull();
    expect(cache.stored()).toEqual({ failed: true, checkedAt: "2026-10-28T10:00:00Z" });
    expect(cache.maxAge()).toBe(`max-age=${FAILURE_TTL}`);
    const soon = new Date(NOW.getTime() + (FAILURE_TTL - 60) * 1000);
    expect(await latestRelease(enabled, failing.fetch, soon, cache)).toBeNull();
    expect(failing.calls).toHaveLength(1);

    const ok = fakeFetch(release);
    const after = new Date(NOW.getTime() + (FAILURE_TTL + 60) * 1000);
    expect((await latestRelease(enabled, ok.fetch, after, cache))?.tag).toBe("v9.0.0");
  });

  it("never throws", async () => {
    const throwing = fakeFetch(() => {
      throw new TypeError("network down");
    });
    expect(await latestRelease(enabled, throwing.fetch, NOW, cache)).toBeNull();
    cache.entries.clear();
    const garbage = fakeFetch(() => new Response("not json"));
    expect(await latestRelease(enabled, garbage.fetch, NOW, cache)).toBeNull();
    cache.entries.clear();
    const foreign = fakeFetch(() =>
      Response.json({ tag_name: "v1.0.0", html_url: "https://example.com/x" }),
    );
    expect(await latestRelease(enabled, foreign.fetch, NOW, cache)).toBeNull();
    cache.entries.set(UPDATES_CACHE_URL, { body: "not json", headers: new Headers() });
    expect(await latestRelease(enabled, garbage.fetch, NOW, cache)).toBeNull();
    const broken: UpdatesCache = {
      match: () => Promise.reject(new Error("cache down")),
      put: () => Promise.reject(new Error("cache down")),
    };
    expect((await latestRelease(enabled, fakeFetch(release).fetch, NOW, broken))?.tag).toBe(
      "v9.0.0",
    );
  });

  it("uses caches.default when no cache is given", async () => {
    const value = { tag: "v8.0.0", url: "https://github.com/o/r/releases/tag/v8.0.0" };
    await storeLatestRelease({ ...value, checkedAt: "2026-10-28T09:00:00Z" });
    const fake = fakeFetch(release);
    expect(await latestRelease(enabled, fake.fetch, NOW)).toEqual({
      ...value,
      checkedAt: "2026-10-28T09:00:00Z",
    });
    expect(fake.calls).toHaveLength(0);
    await caches.default.delete(UPDATES_CACHE_URL);
  });
});

describe("updateStatus", () => {
  it("compares tags with the running version by semver", () => {
    expect(updateStatus("v1.2.0", "1.1.9")).toBe("available");
    expect(updateStatus("1.10.0", "1.9.0")).toBe("available");
    expect(updateStatus("v1.2.0", "1.2.0")).toBe("current");
    expect(updateStatus("v1.2.0-rc.1", "1.2.0")).toBe("current");
    expect(updateStatus("v1.1.0", "1.2.0")).toBe("current");
    expect(updateStatus("nightly", "1.2.0")).toBe("unknown");
  });

  it("is shown in the Settings tab", () => {
    const url = "https://github.com/o/r/releases/tag/v2.0.0";
    const at = "2026-10-28T10:00:00Z";
    expect(updateLine("1.0.0", { tag: "v2.0.0", url, checkedAt: at }).value).toContain(
      `New release <a href="${url}" rel="noreferrer">v2.0.0</a> is available.`,
    );
    expect(updateLine("2.0.0", { tag: "v2.0.0", url, checkedAt: at }).value).toContain(
      "Up to date",
    );
    expect(updateLine("2.0.0", null).value).toContain("Could not check for new releases");
  });
});
