import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { composerAdapter } from "../../src/adapters/composer/index";
import type { Manifest } from "../../src/adapters/types";
import {
  constraintList,
  depsGraphKey,
  readDepsGraph,
  rebuildDepsGraph,
  removeVersionDeps,
  replacePackageDeps,
  setVersionDeps,
  toVersionDeps,
  writeManifest,
} from "../../src/core/storage";

beforeEach(async () => {
  for (;;) {
    const page = await env.R2_BUCKET.list();
    if (page.objects.length === 0) return;
    await env.R2_BUCKET.delete(page.objects.map((o) => o.key));
  }
});

function composer(name: string, version: string, require: Record<string, string> = {}): Manifest {
  return {
    eco: "composer",
    name,
    version,
    files: [{ name: "a.zip", size: 1, sha256: "0".repeat(64), role: "archive" }],
    published: "2026-10-28T10:12:00Z",
    publishedBy: "ci-acme",
    yanked: false,
    native: { name, require },
  };
}

describe("toVersionDeps", () => {
  it("keeps one constraint as a string and several distinct ones as a list", () => {
    expect(
      toVersionDeps([
        { name: "acme/b", constraint: "^1.0" },
        { name: "acme/c", constraint: "*" },
        { name: "acme/b", constraint: "^1.2" },
        { name: "acme/c", constraint: "*" },
      ]),
    ).toEqual({ "acme/b": ["^1.0", "^1.2"], "acme/c": "*" });
    expect(toVersionDeps([])).toEqual({});
    expect(constraintList("^1.0")).toEqual(["^1.0"]);
    expect(constraintList(["^1.0", "^2.0"])).toEqual(["^1.0", "^2.0"]);
  });
});

describe("the dependency graph", () => {
  it("is empty when missing and keeps only well-formed entries", async () => {
    expect(await readDepsGraph(env, "composer")).toEqual({});
    await env.R2_BUCKET.put(
      depsGraphKey("composer"),
      JSON.stringify({
        "acme/a": { "1.0.0": { "acme/b": "^1.0", "acme/c": 3, "acme/d": [], "acme/e": ["*"] } },
        "acme/b": { "1.0.0": "nope" },
        "acme/c": [],
      }),
    );
    expect(await readDepsGraph(env, "composer")).toEqual({
      "acme/a": { "1.0.0": { "acme/b": "^1.0", "acme/e": ["*"] } },
    });
    await env.R2_BUCKET.put(depsGraphKey("npm"), "not json");
    expect(await readDepsGraph(env, "npm")).toEqual({});
  });

  it("adds, replaces and removes versions and packages, sorted", async () => {
    await setVersionDeps(env, "composer", "acme/b", "1.0.0", []);
    await setVersionDeps(env, "composer", "acme/a", "1.1.0", [
      { name: "acme/b", constraint: "^1.0" },
    ]);
    await setVersionDeps(env, "composer", "acme/a", "1.0.0", [
      { name: "acme/z", constraint: "*" },
      { name: "acme/b", constraint: "~1.0" },
    ]);
    const stored = await env.R2_BUCKET.get(depsGraphKey("composer"));
    expect(await stored?.text()).toBe(
      JSON.stringify({
        "acme/a": {
          "1.0.0": { "acme/b": "~1.0", "acme/z": "*" },
          "1.1.0": { "acme/b": "^1.0" },
        },
        "acme/b": { "1.0.0": {} },
      }),
    );
    expect(stored?.httpMetadata?.contentType).toBe("application/json");

    await setVersionDeps(env, "composer", "acme/a", "1.0.0", []);
    await removeVersionDeps(env, "composer", "acme/a", "1.1.0");
    await removeVersionDeps(env, "composer", "acme/missing", "1.0.0");
    expect(await readDepsGraph(env, "composer")).toEqual({
      "acme/a": { "1.0.0": {} },
      "acme/b": { "1.0.0": {} },
    });

    await removeVersionDeps(env, "composer", "acme/b", "1.0.0");
    await replacePackageDeps(
      env,
      "composer",
      "acme/a",
      new Map([["2.0.0", [{ name: "acme/b", constraint: "^2.0" }]]]),
    );
    expect(await readDepsGraph(env, "composer")).toEqual({
      "acme/a": { "2.0.0": { "acme/b": "^2.0" } },
    });
    await replacePackageDeps(env, "composer", "acme/a", new Map());
    expect(await readDepsGraph(env, "composer")).toEqual({});
    expect(await readDepsGraph(env, "npm")).toEqual({});
  });

  it("survives concurrent writers through the etag retry", async () => {
    await Promise.all(
      ["1.0.0", "1.1.0", "1.2.0", "1.3.0"].map((version) =>
        setVersionDeps(env, "composer", "acme/a", version, []),
      ),
    );
    expect(Object.keys((await readDepsGraph(env, "composer"))["acme/a"] ?? {})).toEqual([
      "1.0.0",
      "1.1.0",
      "1.2.0",
      "1.3.0",
    ]);
  });

  it("is rebuilt from the manifests of one ecosystem", async () => {
    await writeManifest(env, composer("acme/a", "1.0.0", { php: "^8.1", "acme/b": "^1.0" }));
    await writeManifest(env, { ...composer("acme/b", "1.0.0"), yanked: true });
    await env.R2_BUCKET.put("composer/pkg/acme__b/1.0.0/a.zip", "zip");
    await env.R2_BUCKET.put("composer/pkg/acme__c/1.0.0/manifest.json", "broken");
    await setVersionDeps(env, "composer", "acme/stale", "9.9.9", []);
    await setVersionDeps(env, "npm", "@acme/kept", "1.0.0", []);

    const rebuilt = await rebuildDepsGraph(env, "composer", (m) => composerAdapter.dependencies(m));
    expect(rebuilt).toEqual({
      "acme/a": { "1.0.0": { "acme/b": "^1.0" } },
      "acme/b": { "1.0.0": {} },
    });
    expect(await readDepsGraph(env, "composer")).toEqual(rebuilt);
    expect(await readDepsGraph(env, "npm")).toEqual({ "@acme/kept": { "1.0.0": {} } });
  });
});
