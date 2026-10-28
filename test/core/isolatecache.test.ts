import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  deleteCredential,
  getCredential,
  putCredential,
  type CredentialRecord,
  type Kind,
} from "../../src/core/auth";
import { ghRepoCandidates, readGhRepoIndex, syncGhRepoIndex } from "../../src/core/ghindex";
import { ISOLATE_CACHE_TTL_MS, IsolateCache } from "../../src/core/isolatecache";
import { legacy, recordOf } from "../records";

const NOW = Date.parse("2026-10-28T10:00:00Z");

function record(project: string, kind: Kind = "read"): CredentialRecord {
  return recordOf(project, kind);
}

describe("IsolateCache", () => {
  it("serves a value until its TTL has passed, null included", () => {
    const cache = new IsolateCache<string | null>(1000);
    expect(cache.get("a", NOW)).toBeUndefined();
    cache.set("a", "x", NOW);
    cache.set("b", null, NOW);
    expect(cache.get("a", NOW + 999)).toBe("x");
    expect(cache.get("b", NOW + 999)).toBeNull();
    expect(cache.get("a", NOW + 1000)).toBeUndefined();
    expect(cache.size).toBe(1);
    cache.delete("b");
    expect(cache.get("b", NOW)).toBeUndefined();
    cache.set("c", "y", NOW);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("drops the oldest entries beyond its bound", () => {
    const cache = new IsolateCache<number>();
    for (let i = 0; i < 1005; i++) cache.set(`k${i}`, i, NOW);
    expect(cache.size).toBe(1000);
    expect(cache.get("k0", NOW)).toBeUndefined();
    expect(cache.get("k1004", NOW)).toBe(1004);
  });
});

describe("credential records in the isolate cache", () => {
  it("serves a record read within the TTL without reading KV again", async () => {
    await env.AUTH.put("cred:cache-hit", JSON.stringify(record("cache-hit")));
    expect((await getCredential(env, "cache-hit", { now: NOW }))?.roles).toEqual(["read"]);
    // Another isolate changes the record: this one keeps its copy for the TTL.
    await env.AUTH.put("cred:cache-hit", JSON.stringify(record("cache-hit", "publish")));
    expect((await getCredential(env, "cache-hit", { now: NOW + 59_000 }))?.roles).toEqual(["read"]);
    expect((await getCredential(env, "cache-hit", { fresh: true }))?.roles).toEqual(["publish"]);
  });

  it("reads KV again once the TTL has passed", async () => {
    await env.AUTH.put("cred:cache-ttl", JSON.stringify(record("cache-ttl")));
    expect((await getCredential(env, "cache-ttl", { now: NOW }))?.roles).toEqual(["read"]);
    await env.AUTH.put("cred:cache-ttl", JSON.stringify(record("cache-ttl", "admin")));
    const later = NOW + ISOLATE_CACHE_TTL_MS;
    expect((await getCredential(env, "cache-ttl", { now: later }))?.roles).toEqual(["admin"]);
  });

  it("caches a missing record and updates the cache on every write", async () => {
    expect(await getCredential(env, "cache-write", { now: NOW })).toBeNull();
    await env.AUTH.put("cred:cache-write", JSON.stringify(record("cache-write")));
    expect(await getCredential(env, "cache-write", { now: NOW })).toBeNull();

    await putCredential(env, record("cache-write", "publish"));
    expect((await getCredential(env, "cache-write", { now: NOW }))?.roles).toEqual(["publish"]);

    // The cached copy is detached from the object that was written.
    const written = record("cache-write", "admin");
    await putCredential(env, written);
    written.roles = ["read"];
    expect((await getCredential(env, "cache-write", { now: NOW }))?.roles).toEqual(["admin"]);

    await deleteCredential(env, "cache-write");
    expect(await getCredential(env, "cache-write", { now: NOW })).toBeNull();
  });
});

describe("gh-repo lists in the isolate cache", () => {
  it("serves lists within the TTL and updates them on every index write", async () => {
    await env.AUTH.put("gh-repo:cache/sdk", JSON.stringify(["one"]));
    expect(await ghRepoCandidates(env, "cache/sdk", NOW)).toEqual(["one"]);
    await env.AUTH.put("gh-repo:cache/sdk", JSON.stringify(["one", "two"]));
    expect(await ghRepoCandidates(env, "cache/sdk", NOW + 1000)).toEqual(["one"]);
    expect(await ghRepoCandidates(env, "cache/sdk", NOW + ISOLATE_CACHE_TTL_MS)).toEqual([
      "one",
      "two",
    ]);

    const three: CredentialRecord = legacy({
      project: "three",
      kind: "read",
      auth: [
        {
          type: "gh",
          repository: "cache/sdk",
          ref: null,
          workflow: null,
          created: "2026-10-28T09:00:00Z",
          expires: null,
        },
      ],
      grants: [],
    });
    await syncGhRepoIndex(env, null, three);
    expect(await readGhRepoIndex(env, "gh-repo:cache/sdk")).toEqual(["one", "three", "two"]);
    await syncGhRepoIndex(env, three, null);
    expect(await readGhRepoIndex(env, "gh-repo:cache/sdk")).toEqual(["one", "two"]);
  });
});
