import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import {
  getCredential,
  hashSecret,
  putCredential,
  type CredentialRecord,
} from "../../src/core/auth";
import {
  META_UPGRADES_PER_RUN,
  STAGING_MAX_AGE_MS,
  cleanup,
  upgradePackageEntries,
} from "../../src/core/cron";
import {
  stagingKey,
  stagingResultKey,
  addPackageToMeta,
  readPackagesMeta,
  writeManifest,
  writeStagingMeta,
  type StagingMeta,
} from "../../src/core/storage";
import { legacy } from "../records";

const NOW = new Date("2026-10-28T12:00:00Z");
const HOUR = 60 * 60 * 1000;

async function wipe(): Promise<void> {
  for (;;) {
    const page = await env.R2_BUCKET.list();
    if (page.objects.length === 0) break;
    await env.R2_BUCKET.delete(page.objects.map((o) => o.key));
  }
  for (const key of (await env.AUTH.list()).keys) await env.AUTH.delete(key.name);
}

beforeEach(wipe);

function meta(createdAt: Date): StagingMeta {
  return {
    eco: "generic",
    name: "acme-tool",
    version: "1.0.0",
    files: [
      { name: "tool-linux.tgz", size: 1, sha256: "0".repeat(64) },
      { name: "tool-macos.tgz", size: 1, sha256: "0".repeat(64) },
    ],
    manifest: {},
    publishedBy: "ci-acme",
    createdAt: createdAt.toISOString(),
    expires: new Date(createdAt.getTime() + 10 * 60 * 1000).toISOString(),
  };
}

async function stage(uploadId: string, createdAt: Date | null): Promise<void> {
  if (createdAt !== null) await writeStagingMeta(env, uploadId, meta(createdAt));
  await env.R2_BUCKET.put(stagingKey(uploadId, "tool-linux.tgz"), "a");
  await env.R2_BUCKET.put(stagingKey(uploadId, "tool-macos.tgz"), "b");
}

async function stagedUploads(): Promise<string[]> {
  const objects = (await env.R2_BUCKET.list({ prefix: "_staging/" })).objects;
  return [...new Set(objects.map((o) => o.key.split("/")[1] ?? ""))].sort();
}

async function record(project: string, expires: (string | null)[]): Promise<CredentialRecord> {
  const r: CredentialRecord = legacy({
    project,
    kind: "read",
    auth: await Promise.all(
      expires.map(async (e, i) => ({
        type: "key" as const,
        hash: await hashSecret(`${project}-${i}`),
        created: "2026-01-01",
        expires: e,
      })),
    ),
    grants: [{ eco: "npm", package: "@acme/*", versions: "*", transitive: true }],
  });
  await putCredential(env, r);
  return r;
}

describe("cleanup: staging", () => {
  it("deletes uploads older than 24 hours by createdAt, with all their files", async () => {
    await stage("expired-upload", new Date(NOW.getTime() - 25 * HOUR));
    await env.R2_BUCKET.put(stagingResultKey("expired-upload"), "{}");
    await stage("boundary-upload", new Date(NOW.getTime() - STAGING_MAX_AGE_MS));
    await stage("fresh-upload", new Date(NOW.getTime() - 23 * HOUR));

    const result = await cleanup(env, NOW);

    expect(result.staleUploads).toBe(1);
    expect(result.stagingObjects).toBe(4);
    expect(await stagedUploads()).toEqual(["boundary-upload", "fresh-upload"]);
  });

  it("falls back to the upload time when the meta is missing", async () => {
    await stage("orphan-upload", null);
    // The objects were just uploaded (real time): fresh now, stale a day later.
    expect((await cleanup(env, new Date())).staleUploads).toBe(0);
    expect(await stagedUploads()).toEqual(["orphan-upload"]);

    const later = new Date(Date.now() + STAGING_MAX_AGE_MS + HOUR);
    const result = await cleanup(env, later);
    expect(result).toMatchObject({ staleUploads: 1, stagingObjects: 2 });
    expect(await stagedUploads()).toEqual([]);
  });

  it("leaves package data alone", async () => {
    await env.R2_BUCKET.put("npm/pkg/@acme__sdk/1.0.0/manifest.json", "{}");
    await env.R2_BUCKET.put("_meta/packages.json", "{}");
    await cleanup(env, new Date(Date.now() + 10 * STAGING_MAX_AGE_MS));
    const keys = (await env.R2_BUCKET.list()).objects.map((o) => o.key).sort();
    expect(keys).toEqual(["_meta/packages.json", "npm/pkg/@acme__sdk/1.0.0/manifest.json"]);
  });
});

describe("cleanup: secrets", () => {
  it("removes expired entries and keeps the record", async () => {
    const shop = await record("shop-frontend", [
      null,
      "2026-10-28T11:59:59Z",
      "2026-11-11",
      "2026-10-28",
    ]);
    const ci = await record("ci-acme", ["2026-10-01"]);
    const untouched = await record("stable", [null, "2027-01-01T00:00:00Z"]);

    const result = await cleanup(env, NOW);

    expect(result).toMatchObject({ expiredSecrets: 3, updatedCredentials: 2 });
    expect(await getCredential(env, "shop-frontend")).toEqual({
      ...shop,
      auth: [shop.auth[0], shop.auth[2]],
    });
    // A credential whose last entry expired stays, with no entries.
    expect(await getCredential(env, "ci-acme")).toEqual({ ...ci, auth: [] });
    expect(await getCredential(env, "stable")).toEqual(untouched);
  });

  it("removes an entry expiring exactly now and keeps unparsable dates", async () => {
    const r = await record("edge-case", [NOW.toISOString(), "someday"]);
    expect((await cleanup(env, NOW)).expiredSecrets).toBe(1);
    expect((await getCredential(env, "edge-case"))?.auth).toEqual([r.auth[1]]);
  });

  it("removes expired gh entries too and leaves other KV keys alone", async () => {
    await putCredential(
      env,
      legacy({
        project: "ci-gh",
        kind: "publish",
        auth: [
          {
            type: "gh",
            repository: "acme/sdk",
            ref: null,
            workflow: null,
            created: "2026-01-01",
            expires: "2026-02-01",
          },
        ],
        grants: [],
      }),
    );
    await env.AUTH.put("schema_version", "1");

    expect((await cleanup(env, NOW)).expiredSecrets).toBe(1);
    expect((await getCredential(env, "ci-gh"))?.auth).toEqual([]);
    expect(await env.AUTH.get("schema_version")).toBe("1");
  });

  it("reports nothing when there is nothing to do", async () => {
    expect(await cleanup(env, NOW)).toEqual({
      staleUploads: 0,
      stagingObjects: 0,
      expiredSecrets: 0,
      updatedCredentials: 0,
      upgradedPackages: 0,
    });
  });
});

describe("scheduled", () => {
  it("runs the cleanup at the scheduled time", async () => {
    await stage("expired-upload", new Date(NOW.getTime() - 25 * HOUR));
    await record("shop-frontend", [null, "2026-10-01"]);

    const controller = createScheduledController({
      scheduledTime: NOW.getTime(),
      cron: "0 * * * *",
    });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await stagedUploads()).toEqual([]);
    expect((await getCredential(env, "shop-frontend"))?.auth).toHaveLength(1);
  });
});

describe("upgradePackageEntries", () => {
  async function legacyPackage(name: string, versions: [string, boolean][]): Promise<void> {
    for (const [version, yanked] of versions) {
      await writeManifest(env, {
        eco: "composer",
        name,
        version,
        files: [{ name: "a.zip", size: 3, sha256: "a".repeat(64), role: "archive" }],
        published: "2026-10-01T00:00:00Z",
        publishedBy: "ci",
        yanked,
        native: { name },
      });
    }
    await addPackageToMeta(env, "composer", name, {
      versions: versions.length,
      updated: "2026-10-01T00:00:00Z",
    });
  }

  it("gives packages with an old entry the description of their versions, a few at a time", async () => {
    await legacyPackage("a/one", [
      ["1.0.0", false],
      ["1.1.0", true],
    ]);
    await legacyPackage("a/two", [["2.0.0", false]]);
    await legacyPackage("a/three", [["3.0.0", false]]);

    expect(await upgradePackageEntries(env, 2)).toBe(2);
    let entries = (await readPackagesMeta(env)).composer;
    expect(entries["a/one"]).toEqual({
      versions: 2,
      updated: "2026-10-01T00:00:00Z",
      names: ["1.0.0", "1.1.0"],
      latestYanked: true,
    });
    expect(entries["a/three"]).toMatchObject({ names: ["3.0.0"] });
    expect(entries["a/two"]).toEqual({ versions: 1, updated: "2026-10-01T00:00:00Z" });

    expect(await upgradePackageEntries(env, 2)).toBe(1);
    entries = (await readPackagesMeta(env)).composer;
    expect(entries["a/two"]).toMatchObject({ names: ["2.0.0"], latestYanked: false });
    // Nothing is left to do, and a second pass changes nothing.
    expect(await upgradePackageEntries(env, 2)).toBe(0);
  });

  it("leaves an entry without manifests alone, and is part of the hourly cleanup", async () => {
    await addPackageToMeta(env, "composer", "a/ghost", { versions: 1, updated: "T" });
    await legacyPackage("a/real", [["1.0.0", false]]);
    expect(META_UPGRADES_PER_RUN).toBeGreaterThan(0);
    const result = await cleanup(env, NOW);
    expect(result.upgradedPackages).toBe(1);
    const entries = (await readPackagesMeta(env)).composer;
    expect(entries["a/ghost"]).toEqual({ versions: 1, updated: "T" });
    expect(entries["a/real"]).toMatchObject({ names: ["1.0.0"] });
  });
});
