import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../../src/adapters/types";
import type { Identity, Kind } from "../../src/core/auth";
import { ValidationError } from "../../src/core/errors";
import type { Grant } from "../../src/core/grants";
import { getPackage, listPackages } from "../../src/core/packages";
import { addPackageToMeta, writeManifest } from "../../src/core/storage";

let counter = 0;
function vendor(): string {
  counter += 1;
  return `list${counter}`;
}

function identity(kind: Kind, grants: Grant[] = []): Identity {
  return {
    project: "someone",
    kind,
    grants,
    record: { project: "someone", kind, auth: [], grants },
    entryId: "x",
  };
}

async function seed(name: string, versions: [string, boolean][]): Promise<void> {
  for (const [version, yanked] of versions) {
    const m: Manifest = {
      eco: "composer",
      name,
      version,
      files: [{ name: "a.zip", size: 3, sha256: "a".repeat(64), role: "archive" }],
      published: "2026-10-01T00:00:00Z",
      publishedBy: "ci",
      yanked,
      native: { name },
    };
    await writeManifest(env, m);
  }
  await addPackageToMeta(env, "composer", name, {
    versions: versions.length,
    updated: "2026-10-01T00:00:00Z",
  });
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ValidationError) return err.code;
    throw err;
  }
  return "ok";
}

describe("listPackages", () => {
  it("lists everything for admin, highest version first, yanked included", async () => {
    const v = vendor();
    await seed(`${v}/b`, [
      ["1.0.0", false],
      ["1.10.0", true],
      ["1.2.0", false],
    ]);
    await seed(`${v}/a`, [["0.1.0", false]]);
    const { packages } = await listPackages(env, identity("admin"));
    const mine = packages.filter((p) => p.name.startsWith(`${v}/`));
    expect(mine.map((p) => p.name)).toEqual([`${v}/a`, `${v}/b`]);
    expect(mine[1]?.versions.map((x) => [x.version, x.yanked])).toEqual([
      ["1.10.0", true],
      ["1.2.0", false],
      ["1.0.0", false],
    ]);
    expect(mine[0]?.versions[0]).toEqual({
      version: "0.1.0",
      published: "2026-10-01T00:00:00Z",
      yanked: false,
      files: [{ name: "a.zip", size: 3, sha256: "a".repeat(64), role: "archive" }],
    });
  });

  it("filters by the read grants and omits packages without visible versions", async () => {
    const v = vendor();
    await seed(`${v}/sdk`, [
      ["1.0.0", false],
      ["2.0.0", false],
    ]);
    await seed(`${v}/other`, [["3.0.0", false]]);
    await seed(`${v}/hidden`, [["1.0.0", false]]);
    const reader = identity("read", [
      { eco: "composer", package: `${v}/sdk`, versions: "^2.0" },
      { eco: "composer", package: `${v}/other`, versions: "^1.0" },
    ]);
    const { packages } = await listPackages(env, reader);
    expect(packages.map((p) => [p.name, p.versions.map((x) => x.version)])).toEqual([
      [`${v}/sdk`, ["2.0.0"]],
    ]);
  });

  it("skips disabled ecosystems and refuses publish credentials", async () => {
    const v = vendor();
    await seed(`${v}/a`, [["1.0.0", false]]);
    const { packages } = await listPackages({ ...env, ECOSYSTEMS: "npm" }, identity("admin"));
    expect(packages.some((p) => p.name === `${v}/a`)).toBe(false);
    expect(await code(listPackages(env, identity("publish")))).toBe("forbidden");
  });
});

describe("getPackage", () => {
  it("returns one package with the visible versions", async () => {
    const v = vendor();
    await seed(`${v}/sdk`, [
      ["1.0.0", false],
      ["2.0.0", true],
    ]);
    const reader = identity("read", [{ eco: "composer", package: `${v}/*`, versions: "*" }]);
    const view = await getPackage(env, reader, "composer", `${v}/sdk`);
    expect(view.eco).toBe("composer");
    expect(view.versions.map((x) => x.version)).toEqual(["2.0.0", "1.0.0"]);
  });

  it("answers 404 instead of revealing packages outside the grants", async () => {
    const v = vendor();
    await seed(`${v}/sdk`, [["1.0.0", false]]);
    const none = identity("read", [{ eco: "composer", package: "other/*", versions: "*" }]);
    const range = identity("read", [{ eco: "composer", package: `${v}/sdk`, versions: "^2.0" }]);
    expect(await code(getPackage(env, none, "composer", `${v}/sdk`))).toBe("not_found");
    expect(await code(getPackage(env, range, "composer", `${v}/sdk`))).toBe("not_found");
    expect(await code(getPackage(env, identity("admin"), "composer", `${v}/missing`))).toBe(
      "not_found",
    );
    expect(await code(getPackage(env, identity("admin"), "pypi", `${v}/sdk`))).toBe("not_found");
    expect(await code(getPackage(env, identity("publish"), "composer", `${v}/sdk`))).toBe(
      "forbidden",
    );
  });
});
