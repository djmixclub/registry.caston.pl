import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FAILURE_TTL,
  LATEST_RELEASE_URL,
  UPDATES_KEY,
  latestRelease,
  updateStatus,
  updatesEnabled,
} from "../../src/core/updates";
import { updateLine } from "../../src/pages/admin";
import { VERSION } from "../../src/version";

const NOW = new Date("2026-10-28T10:00:00Z");
const enabled = { AUTH: env.AUTH, CHECK_UPDATES: "true" };

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

const release = () =>
  Response.json({
    tag_name: "v9.0.0",
    html_url: "https://github.com/kduma-OSS/serverless-registry-worker/releases/tag/v9.0.0",
  });

beforeEach(async () => {
  await env.AUTH.delete(UPDATES_KEY);
});

describe("latestRelease", () => {
  it("does nothing unless CHECK_UPDATES is true", async () => {
    const fake = fakeFetch(release);
    expect(updatesEnabled({ CHECK_UPDATES: "false" })).toBe(false);
    expect(updatesEnabled({ CHECK_UPDATES: " TRUE " })).toBe(true);
    expect(await latestRelease({ AUTH: env.AUTH, CHECK_UPDATES: "" }, fake.fetch, NOW)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("asks GitHub once and caches the release for 24 hours", async () => {
    const fake = fakeFetch(release);
    const first = await latestRelease(enabled, fake.fetch, NOW);
    expect(first).toEqual({
      tag: "v9.0.0",
      url: "https://github.com/kduma-OSS/serverless-registry-worker/releases/tag/v9.0.0",
      checkedAt: "2026-10-28T10:00:00Z",
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe(LATEST_RELEASE_URL);
    expect(fake.calls[0]?.headers.get("user-agent")).toBe(`serverless-registry/${VERSION}`);
    expect(await env.AUTH.get(UPDATES_KEY, "json")).toEqual(first);

    const later = new Date(NOW.getTime() + 23 * 3600 * 1000);
    expect(await latestRelease(enabled, fake.fetch, later)).toEqual(first);
    expect(fake.calls).toHaveLength(1);

    const nextDay = new Date(NOW.getTime() + 25 * 3600 * 1000);
    await latestRelease(enabled, fake.fetch, nextDay);
    expect(fake.calls).toHaveLength(2);
  });

  it("returns null on failures and caches them for an hour", async () => {
    const failing = fakeFetch(() => new Response("rate limited", { status: 403 }));
    expect(await latestRelease(enabled, failing.fetch, NOW)).toBeNull();
    expect(await env.AUTH.get(UPDATES_KEY, "json")).toEqual({
      failed: true,
      checkedAt: "2026-10-28T10:00:00Z",
    });
    const soon = new Date(NOW.getTime() + (FAILURE_TTL - 60) * 1000);
    expect(await latestRelease(enabled, failing.fetch, soon)).toBeNull();
    expect(failing.calls).toHaveLength(1);

    const ok = fakeFetch(release);
    const after = new Date(NOW.getTime() + (FAILURE_TTL + 60) * 1000);
    expect((await latestRelease(enabled, ok.fetch, after))?.tag).toBe("v9.0.0");
  });

  it("never throws", async () => {
    const throwing = fakeFetch(() => {
      throw new TypeError("network down");
    });
    expect(await latestRelease(enabled, throwing.fetch, NOW)).toBeNull();
    await env.AUTH.delete(UPDATES_KEY);
    const garbage = fakeFetch(() => new Response("not json"));
    expect(await latestRelease(enabled, garbage.fetch, NOW)).toBeNull();
    await env.AUTH.delete(UPDATES_KEY);
    const foreign = fakeFetch(() =>
      Response.json({ tag_name: "v1.0.0", html_url: "https://example.com/x" }),
    );
    expect(await latestRelease(enabled, foreign.fetch, NOW)).toBeNull();
    await env.AUTH.put(UPDATES_KEY, "not json");
    expect(await latestRelease(enabled, garbage.fetch, NOW)).toBeNull();
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
