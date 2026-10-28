import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Eco, Manifest } from "../../src/adapters/types";
import { ValidationError } from "../../src/core/errors";
import {
  PACKAGES_META_KEY,
  compareVersionStrings,
  fileKey,
  decodePackageName,
  deleteIndexFiles,
  deleteIndexPrefix,
  deleteVersion,
  encodePackageName,
  indexKey,
  listManifests,
  listPackageNames,
  manifestExists,
  manifestKey,
  packagePrefix,
  readIndex,
  readManifest,
  stagingKey,
  stagingMetaKey,
  stagingResultKey,
  writeIndexFiles,
  writeManifest,
} from "../../src/core/storage";

let counter = 0;
/** A package name unique within this file (storage is shared between its tests). */
function unique(base: string): string {
  counter += 1;
  return `${base}${counter}`;
}

function manifest(
  eco: Eco,
  name: string,
  version: string,
  extra: Partial<Manifest> = {},
): Manifest {
  return {
    eco,
    name,
    version,
    files: [{ name: `pkg-${version}.zip`, size: 10, sha256: "0".repeat(64) }],
    published: "2026-10-28T10:12:00Z",
    publishedBy: "ci-acme",
    yanked: false,
    native: { name },
    ...extra,
  };
}

async function keysUnder(prefix: string): Promise<string[]> {
  return (await env.R2_BUCKET.list({ prefix })).objects.map((o) => o.key).sort();
}

describe("keys", () => {
  it.each([
    ["acme/sdk", "acme__sdk"],
    ["@acme/sdk", "@acme__sdk"],
    ["acme-core", "acme-core"],
  ])("encodes %j as %j", (name, encoded) => {
    expect(encodePackageName(name)).toBe(encoded);
    expect(decodePackageName(encoded, "npm")).toBe(name);
  });

  it("decodes only the first separator outside cargo", () => {
    expect(decodePackageName("@acme__my__sdk", "npm")).toBe("@acme/my__sdk");
    expect(decodePackageName("acme__sdk")).toBe("acme/sdk");
    expect(decodePackageName("foo__bar", "cargo")).toBe("foo__bar");
  });

  it("builds the layout from the spec", () => {
    expect(manifestKey("npm", "@acme/sdk", "2.3.1")).toBe("npm/pkg/@acme__sdk/2.3.1/manifest.json");
    expect(fileKey("npm", "@acme/sdk", "2.3.1", "sdk-2.3.1.tgz")).toBe(
      "npm/pkg/@acme__sdk/2.3.1/sdk-2.3.1.tgz",
    );
    expect(fileKey("composer", "acme/sdk", "1.2.0", "sdk-1.2.0.zip")).toBe(
      "composer/pkg/acme__sdk/1.2.0/sdk-1.2.0.zip",
    );
    expect(fileKey("generic", "acme-tool", "1.0.0", "tool-linux-x86_64.tar.gz")).toBe(
      "generic/pkg/acme-tool/1.0.0/tool-linux-x86_64.tar.gz",
    );
    expect(packagePrefix("cargo", "acme-core")).toBe("cargo/pkg/acme-core/");
    expect(indexKey("composer", "p2", "acme", "sdk.json")).toBe("composer/index/p2/acme/sdk.json");
    expect(indexKey("cargo", "ac/me/acme-core")).toBe("cargo/index/ac/me/acme-core");
    expect(stagingKey("UPLOAD123", "sdk.tgz")).toBe("_staging/UPLOAD123/sdk.tgz");
    expect(stagingMetaKey("UPLOAD123")).toBe("_staging/UPLOAD123/meta.json");
    expect(stagingResultKey("UPLOAD123")).toBe("_staging/UPLOAD123/result.json");
    expect(PACKAGES_META_KEY).toBe("_meta/packages.json");
  });

  it("rejects versions, file names and upload ids that would change the layout", () => {
    expect(() => manifestKey("npm", "a", "1/2")).toThrow(TypeError);
    expect(() => fileKey("generic", "a", "1.0.0", "bin/a")).toThrow(TypeError);
    expect(() => fileKey("generic", "a", "1.0.0", "manifest.json")).toThrow(TypeError);
    expect(() => fileKey("generic", "a", "1.0.0", "")).toThrow(TypeError);
    expect(() => manifestKey("npm", "a", "")).toThrow(TypeError);
    expect(() => stagingKey("a/b", "f")).toThrow(TypeError);
  });
});

describe("manifests", () => {
  it("writes, reads and detects a manifest", async () => {
    const name = unique("@acme/sdk");
    const m = manifest("npm", name, "2.3.1");
    expect(await readManifest(env, "npm", name, "2.3.1")).toBeNull();
    expect(await manifestExists(env, "npm", name, "2.3.1")).toBe(false);

    await writeManifest(env, m);

    expect(await readManifest(env, "npm", name, "2.3.1")).toEqual(m);
    expect(await manifestExists(env, "npm", name, "2.3.1")).toBe(true);
    const head = await env.R2_BUCKET.head(manifestKey("npm", name, "2.3.1"));
    expect(head?.httpMetadata?.contentType).toBe("application/json");
  });

  it("refuses to overwrite a version unless asked", async () => {
    const name = unique("acme/sdk");
    await writeManifest(env, manifest("composer", name, "1.0.0"));

    const error = await writeManifest(env, manifest("composer", name, "1.0.0")).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("version_exists");
    expect((error as ValidationError).status).toBe(409);

    await writeManifest(env, manifest("composer", name, "1.0.0", { yanked: true }), {
      overwrite: true,
    });
    expect((await readManifest(env, "composer", name, "1.0.0"))?.yanked).toBe(true);
  });

  it("lets exactly one of two concurrent writes of a version win", async () => {
    const name = unique("acme/race");
    const results = await Promise.allSettled([
      writeManifest(env, manifest("composer", name, "1.0.0", { publishedBy: "a" })),
      writeManifest(env, manifest("composer", name, "1.0.0", { publishedBy: "b" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected?.reason as ValidationError).code).toBe("version_exists");
  });

  it("returns null for a corrupt manifest", async () => {
    const name = unique("acme/bad");
    await env.R2_BUCKET.put(manifestKey("composer", name, "1.0.0"), "{not json");
    await env.R2_BUCKET.put(manifestKey("composer", name, "1.0.1"), '{"eco":"composer"}');
    const file = { name: "a.zip", size: 1, sha256: "0".repeat(64) };
    for (const [version, files] of [
      ["1.0.2", []],
      ["1.0.3", [file, file]],
      ["1.0.4", [{ name: "a.zip" }]],
    ] as const) {
      const body = JSON.stringify({ ...manifest("composer", name, version), files });
      await env.R2_BUCKET.put(manifestKey("composer", name, version), body);
    }
    for (const version of ["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4"]) {
      expect(await readManifest(env, "composer", name, version)).toBeNull();
    }
    expect(await listManifests(env, "composer", name)).toEqual([]);
  });

  it("lists the manifests of one package sorted by version", async () => {
    const name = unique("acme/list");
    for (const v of ["1.10.0", "1.2.0", "2.0.0-rc.1", "2.0.0", "1.2.0-beta"]) {
      await writeManifest(env, manifest("composer", name, v));
      await env.R2_BUCKET.put(fileKey("composer", name, v, `pkg-${v}.zip`), "zip");
    }
    // A package whose encoded name extends this one must not be listed.
    await writeManifest(env, manifest("composer", `${name}-extra`, "9.9.9"));

    const versions = (await listManifests(env, "composer", name)).map((m) => m.version);
    expect(versions).toEqual(["1.2.0-beta", "1.2.0", "1.10.0", "2.0.0-rc.1", "2.0.0"]);
    expect(await listManifests(env, "composer", unique("acme/none"))).toEqual([]);
  });

  it("sorts versions that are not semver first", async () => {
    const name = unique("acme/odd");
    for (const v of ["1.0.0", "dev-main", "1.0"]) {
      await writeManifest(env, manifest("composer", name, v));
    }
    const versions = (await listManifests(env, "composer", name)).map((m) => m.version);
    expect(versions).toEqual(["1.0", "dev-main", "1.0.0"]);
  });

  it("sorts with the adapter's comparator and keeps names as given", async () => {
    // NuGet-style: up to four numeric parts, compared numerically; the adapter lower-cases
    // the name itself, the kernel stores whatever name it is given.
    const name = unique("acme.tools");
    for (const v of ["1.0.0.10", "1.0.0.9", "1.0", "1.0.0.9-beta"]) {
      await writeManifest(env, manifest("nuget", name, v));
    }
    const nuget = (a: string, b: string): number => {
      const parts = (v: string) => v.split("-")[0]?.split(".").map(Number) ?? [];
      const pa = parts(a);
      const pb = parts(b);
      for (let i = 0; i < 4; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
      }
      return (a.includes("-") ? 0 : 1) - (b.includes("-") ? 0 : 1);
    };
    const versions = (await listManifests(env, "nuget", name, nuget)).map((m) => m.version);
    expect(versions).toEqual(["1.0", "1.0.0.9-beta", "1.0.0.9", "1.0.0.10"]);
    expect(await listPackageNames(env, "nuget")).toContain(name);

    await writeManifest(env, manifest("nuget", "Acme.Mixed", "1.0.0"));
    expect(manifestKey("nuget", "Acme.Mixed", "1.0.0")).toBe(
      "nuget/pkg/Acme.Mixed/1.0.0/manifest.json",
    );
    expect(await readManifest(env, "nuget", "acme.mixed", "1.0.0")).toBeNull();
  });

  it("orders versions by semver by default", () => {
    expect(["2.0.0", "1.10.0", "x", "1.2.0"].sort(compareVersionStrings)).toEqual([
      "x",
      "1.2.0",
      "1.10.0",
      "2.0.0",
    ]);
  });

  it("deletes the manifest and every file of one version", async () => {
    const name = unique("@acme/del");
    await writeManifest(env, manifest("npm", name, "1.0.0"));
    await env.R2_BUCKET.put(fileKey("npm", name, "1.0.0", "del-1.0.0.tgz"), "tgz");
    await env.R2_BUCKET.put(fileKey("npm", name, "1.0.0", "del-1.0.0.sig"), "sig");
    await writeManifest(env, manifest("npm", name, "1.0.1"));

    expect(await deleteVersion(env, "npm", name, "1.0.0")).toBe(true);
    expect(await keysUnder(packagePrefix("npm", name))).toEqual([
      manifestKey("npm", name, "1.0.1"),
    ]);
    expect(await deleteVersion(env, "npm", name, "1.0.0")).toBe(false);
  });

  it("lists decoded package names of one ecosystem", async () => {
    const eco: Eco = "cargo";
    const before = await listPackageNames(env, eco);
    expect(before).toEqual([]);
    await writeManifest(env, manifest("cargo", "acme-core", "1.0.0"));
    await writeManifest(env, manifest("cargo", "acme-core", "1.1.0"));
    await writeManifest(env, manifest("cargo", "foo__bar", "0.1.0"));
    await writeManifest(env, manifest("npm", "@acme/cli", "0.1.0"));

    expect(await listPackageNames(env, "cargo")).toEqual(["acme-core", "foo__bar"]);
    expect(await listPackageNames(env, "npm")).toContain("@acme/cli");
  });
});

describe("index files", () => {
  it("writes, reads and deletes index files", async () => {
    const base = unique("acme/idx");
    const key = indexKey("composer", "p2", `${base}.json`);
    const dev = indexKey("composer", "p2", `${base}~dev.json`);
    const other = indexKey("composer", "p2", `${base}x.json`);

    expect(await readIndex(env, key)).toBeNull();
    await writeIndexFiles(env, [
      { key, body: '{"packages":{}}', contentType: "application/json" },
      { key: dev, body: "{}", contentType: "application/json" },
      { key: other, body: "{}", contentType: "application/json" },
    ]);

    const stored = await readIndex(env, key);
    expect(stored?.body).toBe('{"packages":{}}');
    expect(stored?.etag).toBe((await env.R2_BUCKET.head(key))?.etag);
    expect((await env.R2_BUCKET.head(key))?.httpMetadata?.contentType).toBe("application/json");

    expect(await deleteIndexPrefix(env, "composer", `p2/${base}.json`)).toBe(1);
    expect(await deleteIndexPrefix(env, "composer", `p2/${base}~`)).toBe(1);
    expect(await readIndex(env, key)).toBeNull();
    expect(await readIndex(env, dev)).toBeNull();
    expect(await readIndex(env, other)).not.toBeNull();
  });

  it("deletes index files by key and refuses other keys", async () => {
    const base = unique("acme/byk");
    const key = indexKey("composer", "p2", `${base}.json`);
    const kept = indexKey("composer", "p2", `${base}x.json`);
    await writeIndexFiles(env, [
      { key, body: "{}", contentType: "application/json" },
      { key: kept, body: "{}", contentType: "application/json" },
    ]);
    expect(await deleteIndexFiles(env, [key])).toBe(1);
    expect(await readIndex(env, key)).toBeNull();
    expect(await readIndex(env, kept)).not.toBeNull();
    await expect(deleteIndexFiles(env, ["composer/pkg/x/1.0.0/manifest.json"])).rejects.toThrow(
      TypeError,
    );
    await expect(deleteIndexFiles(env, [indexKey("composer")])).rejects.toThrow(TypeError);
    expect(await readIndex(env, kept)).not.toBeNull();
  });

  it("deletes more than one listing page", async () => {
    const prefix = `${unique("many")}/`;
    const files = Array.from({ length: 1100 }, (_, i) => ({
      key: indexKey("npm", prefix + String(i).padStart(4, "0")),
      body: "x",
      contentType: "text/plain",
    }));
    await writeIndexFiles(env, files);
    expect(await deleteIndexPrefix(env, "npm", prefix)).toBe(1100);
    expect(await keysUnder(indexKey("npm", prefix))).toEqual([]);
    // Writing 1100 objects takes a few seconds when the whole suite runs in parallel.
  }, 30_000);
});
