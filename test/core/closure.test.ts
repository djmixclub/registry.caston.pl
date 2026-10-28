import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { composerAdapter as adapter } from "../../src/adapters/composer/index";
import type { Manifest } from "../../src/adapters/types";
import type { Identity, Kind } from "../../src/core/auth";
import {
  CLOSURE_TTL_SECONDS,
  allowedFor,
  closureKey,
  computeClosure,
  invalidateClosures,
  invalidateProjectClosures,
  type Closure,
} from "../../src/core/closure";
import type { Grant } from "../../src/core/grants";
import { addPackageToMeta, removePackageFromMeta, writeManifest } from "../../src/core/storage";

const NOW = new Date("2026-10-28T10:12:00Z");

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

function identity(project: string, grants: Grant[], kind: Kind = "read"): Identity {
  return { project, kind, grants, record: { project, kind, auth: [], grants }, entryId: "x" };
}

type Spec = [version: string, require?: Record<string, string>, yanked?: boolean];

async function seed(name: string, versions: Spec[]): Promise<void> {
  for (const [version, require = {}, yanked = false] of versions) {
    const m: Manifest = {
      eco: "composer",
      name,
      version,
      files: [{ name: "a.zip", size: 3, sha256: "a".repeat(64), role: "archive" }],
      published: "2026-10-01T00:00:00Z",
      publishedBy: "ci",
      yanked,
      native: { name, require },
    };
    await writeManifest(env, m);
  }
  await addPackageToMeta(env, "composer", name, {
    versions: versions.length,
    updated: "2026-10-01T00:00:00Z",
  });
}

function plain(closure: Closure): Record<string, string[]> {
  return Object.fromEntries(
    [...closure.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, versions]) => [name, [...versions].sort()]),
  );
}

function grant(pkg: string, versions = "*", transitive?: boolean): Grant {
  return {
    eco: "composer",
    package: pkg,
    versions,
    ...(transitive === undefined ? {} : { transitive }),
  };
}

/** A vendor with `a` 1.0.0 → `b` ^1.1 (1.0.0, 1.1.0, 1.4.0, 2.0.0), `b` 1.4.0 → `c` (0.1.0). */
async function chain(): Promise<string> {
  const v = unique("chain");
  await seed(`${v}/a`, [["1.0.0", { php: "^8.1", [`${v}/b`]: "^1.1" }]]);
  await seed(`${v}/b`, [
    ["1.0.0"],
    ["1.1.0"],
    ["1.4.0", { [`${v}/c`]: "^0.1" }],
    ["2.0.0", { [`${v}/c`]: "*" }],
  ]);
  await seed(`${v}/c`, [["0.1.0"]]);
  return v;
}

describe("computeClosure", () => {
  it("follows dependency constraints transitively", async () => {
    const v = await chain();
    const reader = identity(unique("closure-"), [grant(`${v}/a`)]);
    expect(plain(await computeClosure(env, reader, "composer", adapter, NOW))).toEqual({
      [`${v}/b`]: ["1.1.0", "1.4.0"],
      [`${v}/c`]: ["0.1.0"],
    });
  });

  it("starts only from the versions the grant covers", async () => {
    const v = unique("range");
    await seed(`${v}/a`, [
      ["1.0.0", { [`${v}/b`]: "^1.0" }],
      ["2.0.0", { [`${v}/b`]: "^2.0" }],
    ]);
    await seed(`${v}/b`, [["1.0.0"], ["2.0.0"]]);
    const reader = identity(unique("closure-"), [grant(`${v}/a`, "^2.0")]);
    expect(plain(await computeClosure(env, reader, "composer", adapter, NOW))).toEqual({
      [`${v}/b`]: ["2.0.0"],
    });
  });

  it("opens nothing for non-transitive grants and does not cache", async () => {
    const v = await chain();
    const project = unique("opaque-");
    const reader = identity(project, [grant(`${v}/a`, "*", false), grant(`${v}/c`, "*", false)]);
    expect((await computeClosure(env, reader, "composer", adapter, NOW)).size).toBe(0);
    expect(await env.AUTH.get(closureKey(project, "composer"))).toBeNull();
  });

  it("lets yanked versions take part as sources and targets", async () => {
    const v = unique("yanked");
    await seed(`${v}/a`, [["1.0.0", { [`${v}/b`]: "^1.0" }, true]]);
    await seed(`${v}/b`, [["1.0.0", { [`${v}/c`]: "^1.0" }, true]]);
    await seed(`${v}/c`, [["1.0.0"]]);
    const reader = identity(unique("closure-"), [grant(`${v}/a`)]);
    expect(plain(await computeClosure(env, reader, "composer", adapter, NOW))).toEqual({
      [`${v}/b`]: ["1.0.0"],
      [`${v}/c`]: ["1.0.0"],
    });
  });

  it("handles cycles, case-insensitive names and unknown or unparsable dependencies", async () => {
    const v = unique("cycle");
    await seed(`${v}/a`, [
      [
        "1.0.0",
        {
          [`${v.toUpperCase()}/B`]: "^1.0",
          [`${v}/missing`]: "*",
          [`${v}/c`]: "dev-main as 1.0.0",
        },
      ],
    ]);
    await seed(`${v}/b`, [["1.0.0", { [`${v}/a`]: "^1.0" }]]);
    await seed(`${v}/c`, [["1.0.0"]]);
    const reader = identity(unique("closure-"), [grant(`${v}/a`)]);
    expect(plain(await computeClosure(env, reader, "composer", adapter, NOW))).toEqual({
      [`${v}/a`]: ["1.0.0"],
      [`${v}/b`]: ["1.0.0"],
    });
  });

  it("ignores packages that are not listed in the registry meta", async () => {
    const v = await chain();
    await removePackageFromMeta(env, "composer", `${v}/b`);
    const reader = identity(unique("closure-"), [grant(`${v}/a`)]);
    expect((await computeClosure(env, reader, "composer", adapter, NOW)).size).toBe(0);
  });

  it("reads the manifests of each package once", async () => {
    const v = unique("diamond");
    await seed(`${v}/a`, [["1.0.0", { [`${v}/b`]: "*", [`${v}/c`]: "*" }]]);
    await seed(`${v}/b`, [["1.0.0", { [`${v}/d`]: "^1.0" }]]);
    await seed(`${v}/c`, [["1.0.0", { [`${v}/d`]: ">=1.0" }]]);
    await seed(`${v}/d`, [["1.0.0"], ["1.1.0"]]);
    const listed: string[] = [];
    const bucket = env.R2_BUCKET;
    const counting = {
      list: (options?: R2ListOptions) => {
        listed.push(options?.prefix ?? "");
        return bucket.list(options);
      },
      get: (key: string) => bucket.get(key),
    } as unknown as R2Bucket;
    const reader = identity(unique("closure-"), [grant(`${v}/a`)]);
    const closure = await computeClosure(
      { AUTH: env.AUTH, R2_BUCKET: counting },
      reader,
      "composer",
      adapter,
      NOW,
    );
    expect(plain(closure)).toEqual({
      [`${v}/b`]: ["1.0.0"],
      [`${v}/c`]: ["1.0.0"],
      [`${v}/d`]: ["1.0.0", "1.1.0"],
    });
    const packageLists = listed.filter((prefix) => prefix.startsWith(`composer/pkg/${v}`));
    expect(packageLists).toHaveLength(new Set(packageLists).size);
    expect(packageLists).toHaveLength(4);
  });
});

describe("closure cache", () => {
  it("serves the cached closure until the ecosystem's closures are invalidated", async () => {
    const v = await chain();
    const project = unique("cached-");
    const reader = identity(project, [grant(`${v}/a`)]);
    await computeClosure(env, reader, "composer", adapter, NOW);
    const stored = await env.AUTH.getWithMetadata(closureKey(project, "composer"), "json");
    expect(stored.value).toEqual({
      computedAt: "2026-10-28T10:12:00Z",
      packages: { [`${v}/b`]: ["1.1.0", "1.4.0"], [`${v}/c`]: ["0.1.0"] },
    });

    // A new version written behind the cache's back is not seen: the cache answers.
    await seed(`${v}/b`, [["1.5.0"]]);
    expect(plain(await computeClosure(env, reader, "composer", adapter, NOW))[`${v}/b`]).toEqual([
      "1.1.0",
      "1.4.0",
    ]);

    await env.AUTH.put(closureKey(project, "npm"), "{}", { expirationTtl: CLOSURE_TTL_SECONDS });
    expect(await invalidateClosures(env, "composer")).toBeGreaterThanOrEqual(1);
    expect(await env.AUTH.get(closureKey(project, "composer"))).toBeNull();
    expect(await env.AUTH.get(closureKey(project, "npm"))).toBe("{}");
    expect(plain(await computeClosure(env, reader, "composer", adapter, NOW))[`${v}/b`]).toEqual([
      "1.1.0",
      "1.4.0",
      "1.5.0",
    ]);
    await env.AUTH.delete(closureKey(project, "npm"));
  });

  it("recomputes when the cached value is malformed", async () => {
    const v = await chain();
    const project = unique("broken-");
    await env.AUTH.put(closureKey(project, "composer"), JSON.stringify({ packages: [] }));
    const reader = identity(project, [grant(`${v}/a`)]);
    expect(plain(await computeClosure(env, reader, "composer", adapter, NOW))).toEqual({
      [`${v}/b`]: ["1.1.0", "1.4.0"],
      [`${v}/c`]: ["0.1.0"],
    });
  });

  it("drops the closures of one project only", async () => {
    const project = unique("proj-");
    for (const key of [
      closureKey(project, "composer"),
      closureKey(project, "npm"),
      closureKey(`${project}0`, "composer"),
    ]) {
      await env.AUTH.put(key, "{}");
    }
    expect(await invalidateProjectClosures(env, project)).toBe(2);
    expect(await env.AUTH.get(closureKey(project, "composer"))).toBeNull();
    expect(await env.AUTH.get(closureKey(project, "npm"))).toBeNull();
    expect(await env.AUTH.get(closureKey(`${project}0`, "composer"))).toBe("{}");
    await env.AUTH.delete(closureKey(`${project}0`, "composer"));
  });
});

describe("allowedFor", () => {
  it("allows explicit grants first and the closure second", async () => {
    const v = await chain();
    const allowed = await allowedFor(
      env,
      identity(unique("allowed-"), [grant(`${v}/a`), grant(`${v}/b`, "^2.0", false)]),
      "composer",
      adapter,
    );
    expect(allowed(`${v}/a`, "1.0.0")).toBe(true);
    expect(allowed(`${v}/b`, "2.0.0")).toBe(true);
    expect(allowed(`${v}/b`, "1.4.0")).toBe(true);
    expect(allowed(`${v}/b`, "1.0.0")).toBe(false);
    expect(allowed(`${v}/c`, "0.1.0")).toBe(true);
    expect(allowed(`${v}/c`, "0.2.0")).toBe(false);
  });

  it("allows everything for admin and only explicit grants for publish", async () => {
    const v = await chain();
    const admin = await allowedFor(env, identity("root", [], "admin"), "composer", adapter);
    expect(admin(`${v}/c`, "9.9.9")).toBe(true);
    const project = unique("publisher-");
    const publisher = await allowedFor(
      env,
      identity(project, [grant(`${v}/a`)], "publish"),
      "composer",
      adapter,
    );
    expect(publisher(`${v}/a`, "1.0.0")).toBe(true);
    expect(publisher(`${v}/b`, "1.4.0")).toBe(false);
    expect(await env.AUTH.get(closureKey(project, "composer"))).toBeNull();
  });
});
