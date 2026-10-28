import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../../src/adapters/types";
import {
  addSecret,
  createCredential,
  createFirstAdmin,
  deletePackage,
  deleteVersion,
  expireSecret,
  hasAnyCredential,
  listCredentialViews,
  readCredentialView,
  reindex,
  removeCredential,
  updateGrants,
  yank,
} from "../../src/core/admin";
import {
  getCredential,
  parseToken,
  putCredential,
  verifyKey,
  type CredentialRecord,
} from "../../src/core/auth";
import { closureKey } from "../../src/core/closure";
import { ValidationError } from "../../src/core/errors";
import {
  fileKey,
  readIndex,
  readManifest,
  readDepsGraph,
  readPackagesMeta,
  replacePackageDeps,
  writeManifest,
} from "../../src/core/storage";

const NOW = new Date("2026-10-28T10:12:00Z");
const BASE = "https://packages.example.com";

let counter = 0;
function unique(base: string): string {
  counter += 1;
  return `${base}${counter}`;
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

/** Stores a composer version (manifest and archive) without going through publishing. */
async function seed(name: string, versions: string[]): Promise<void> {
  for (const version of versions) {
    const m: Manifest = {
      eco: "composer",
      name,
      version,
      files: [{ name: "a.zip", size: 3, sha256: "a".repeat(64), role: "archive" }],
      published: "2026-10-01T00:00:00Z",
      publishedBy: "ci-acme",
      yanked: false,
      native: { name },
    };
    await writeManifest(env, m);
    await env.R2_BUCKET.put(fileKey("composer", name, version, "a.zip"), "zip");
  }
  await reindex(env, "composer", name, NOW, BASE);
}

async function p2Versions(name: string): Promise<string[] | null> {
  const index = await readIndex(env, `composer/index/p2/${name}.json`);
  if (index === null) return null;
  const body = JSON.parse(index.body) as { packages: Record<string, { version?: string }[]> };
  return (body.packages[name] ?? []).map((v) => v.version ?? "");
}

describe("closure invalidation", () => {
  async function cached(project: string, eco: "composer" | "npm"): Promise<boolean> {
    return (await env.AUTH.get(closureKey(project, eco))) !== null;
  }

  it("drops the ecosystem's closures on yank, delete and reindex", async () => {
    const name = unique("acme/closure");
    await seed(name, ["1.0.0", "1.1.0", "1.2.0"]);
    const project = unique("closure-reader-");
    const steps: (() => Promise<unknown>)[] = [
      () => yank(env, "composer", name, "1.2.0", NOW, BASE),
      () => deleteVersion(env, "composer", name, "1.2.0", NOW, BASE),
      () => reindex(env, "composer", name, NOW, BASE),
      () => deletePackage(env, "composer", name, BASE),
    ];
    for (const step of steps) {
      await env.AUTH.put(closureKey(project, "composer"), "{}");
      await env.AUTH.put(closureKey(project, "npm"), "{}");
      await step();
      expect(await cached(project, "composer")).toBe(false);
      expect(await cached(project, "npm")).toBe(true);
    }
    await env.AUTH.delete(closureKey(project, "npm"));
  });

  it("drops a credential's closures when its grants change or it is deleted", async () => {
    const project = unique("closure-cred-");
    const other = unique("closure-other-");
    await createCredential(env, { project, kind: "read" }, NOW);
    await env.AUTH.put(closureKey(project, "composer"), "{}");
    await env.AUTH.put(closureKey(other, "composer"), "{}");
    await updateGrants(env, project, { grants: [] });
    expect(await cached(project, "composer")).toBe(false);
    expect(await cached(other, "composer")).toBe(true);
    await env.AUTH.put(closureKey(project, "npm"), "{}");
    await removeCredential(env, project);
    expect(await cached(project, "npm")).toBe(false);
    expect(await cached(other, "composer")).toBe(true);
    await env.AUTH.delete(closureKey(other, "composer"));
  });
});

describe("the dependency graph", () => {
  it("follows yank, delete, reindex and package delete", async () => {
    const name = unique("acme/graph");
    await seed(name, ["1.0.0", "1.1.0", "1.2.0"]);
    const versions = async () =>
      Object.keys((await readDepsGraph(env, "composer"))[name] ?? {}).sort();
    expect(await versions()).toEqual(["1.0.0", "1.1.0", "1.2.0"]);

    await yank(env, "composer", name, "1.2.0", NOW, BASE);
    expect(await versions()).toEqual(["1.0.0", "1.1.0", "1.2.0"]);

    await deleteVersion(env, "composer", name, "1.1.0", NOW, BASE);
    expect(await versions()).toEqual(["1.0.0", "1.2.0"]);

    // A manifest written behind the graph's back is picked up by a reindex.
    await writeManifest(env, {
      eco: "composer",
      name,
      version: "2.0.0",
      files: [{ name: "a.zip", size: 3, sha256: "a".repeat(64), role: "archive" }],
      published: "2026-10-01T00:00:00Z",
      publishedBy: "ci-acme",
      yanked: false,
      native: { name, require: { "acme/other": "^3.0" } },
    });
    await replacePackageDeps(env, "composer", name, new Map([["9.9.9", []]]));
    await reindex(env, "composer", name, NOW, BASE);
    expect((await readDepsGraph(env, "composer"))[name]).toEqual({
      "1.0.0": {},
      "1.2.0": {},
      "2.0.0": { "acme/other": "^3.0" },
    });

    await deletePackage(env, "composer", name, BASE);
    expect(await versions()).toEqual([]);
  });

  it("drops a package with its last version", async () => {
    const name = unique("acme/graph-last");
    await seed(name, ["1.0.0"]);
    await deleteVersion(env, "composer", name, "1.0.0", NOW, BASE);
    expect(Object.hasOwn(await readDepsGraph(env, "composer"), name)).toBe(false);
  });
});

describe("yank", () => {
  it("marks the version yanked and drops it from the index", async () => {
    const name = unique("acme/yank");
    await seed(name, ["1.0.0", "1.1.0"]);
    const res = await yank(env, "composer", name, "1.1.0", NOW, BASE);

    expect(res).toEqual({
      eco: "composer",
      name,
      version: "1.1.0",
      published: "2026-10-01T00:00:00Z",
      yanked: true,
      files: [{ name: "a.zip", size: 3, sha256: "a".repeat(64), role: "archive" }],
    });
    expect((await readManifest(env, "composer", name, "1.1.0"))?.yanked).toBe(true);
    expect(await p2Versions(name)).toEqual(["1.0.0"]);
    expect(await env.R2_BUCKET.head(fileKey("composer", name, "1.1.0", "a.zip"))).not.toBeNull();
    expect((await readPackagesMeta(env)).composer[name]?.versions).toBe(2);
    await expect(yank(env, "composer", name, "1.1.0", NOW, BASE)).resolves.toMatchObject({
      yanked: true,
    });
  });

  it("answers 404 for unknown versions and ecosystems", async () => {
    const name = unique("acme/yank");
    await seed(name, ["1.0.0"]);
    expect(await code(yank(env, "composer", name, "2.0.0", NOW, BASE))).toBe("not_found");
    expect(await code(yank(env, "composer", name, "1.0/0", NOW, BASE))).toBe("not_found");
    expect(await code(yank(env, "pypi", name, "1.0.0", NOW, BASE))).toBe("not_found");
    const disabled = { ...env, ECOSYSTEMS: "npm" };
    expect(await code(yank(disabled, "composer", name, "1.0.0", NOW, BASE))).toBe("not_found");
  });
});

describe("deleteVersion", () => {
  it("deletes the objects and rebuilds the index", async () => {
    const name = unique("acme/del");
    await seed(name, ["1.0.0", "1.1.0"]);
    expect(await deleteVersion(env, "composer", name, "1.1.0", NOW, BASE)).toEqual({
      eco: "composer",
      name,
      version: "1.1.0",
      deleted: true,
    });
    expect(await readManifest(env, "composer", name, "1.1.0")).toBeNull();
    expect(await env.R2_BUCKET.head(fileKey("composer", name, "1.1.0", "a.zip"))).toBeNull();
    expect(await p2Versions(name)).toEqual(["1.0.0"]);
    expect((await readPackagesMeta(env)).composer[name]).toEqual({
      versions: 1,
      updated: "2026-10-28T10:12:00Z",
    });
  });

  it("removes the indexes and the meta entry with the last version", async () => {
    const name = unique("acme/del");
    await seed(name, ["1.0.0"]);
    await deleteVersion(env, "composer", name, "1.0.0", NOW, BASE);
    expect(await p2Versions(name)).toBeNull();
    expect(await readIndex(env, `composer/index/p2/${name}~dev.json`)).toBeNull();
    expect((await readPackagesMeta(env)).composer[name]).toBeUndefined();
    expect(await code(deleteVersion(env, "composer", name, "1.0.0", NOW, BASE))).toBe("not_found");
  });
});

describe("deletePackage", () => {
  it("deletes every version, the indexes and the meta entry", async () => {
    const name = unique("acme/pkg");
    await seed(name, ["1.0.0", "1.2.0", "1.1.0"]);
    expect(await deletePackage(env, "composer", name, BASE)).toEqual({
      eco: "composer",
      name,
      deletedVersions: ["1.2.0", "1.1.0", "1.0.0"],
    });
    expect(await readManifest(env, "composer", name, "1.0.0")).toBeNull();
    expect(await p2Versions(name)).toBeNull();
    expect((await readPackagesMeta(env)).composer[name]).toBeUndefined();
    expect(await code(deletePackage(env, "composer", name, BASE))).toBe("not_found");
  });
});

describe("reindex", () => {
  it("rebuilds the index from the manifests", async () => {
    const name = unique("acme/re");
    await seed(name, ["1.0.0", "2.0.0"]);
    await env.R2_BUCKET.delete(`composer/index/p2/${name}.json`);
    expect(await reindex(env, "composer", name, NOW, BASE)).toEqual({
      eco: "composer",
      name,
      manifests: 2,
    });
    expect(await p2Versions(name)).toEqual(["2.0.0", "1.0.0"]);
    expect(await code(reindex(env, "composer", unique("acme/none"), NOW, BASE))).toBe("not_found");
  });
});

describe("credentials", () => {
  it("creates a credential with a key secret and returns the token once", async () => {
    const project = unique("shop-");
    const res = await createCredential(
      env,
      {
        project,
        kind: "read",
        grants: [{ eco: "composer", package: "acme/*", versions: "^1.0" }],
      },
      NOW,
    );
    expect(res.credential).toEqual({
      project,
      kind: "read",
      auth: [
        {
          id: expect.stringMatching(/^[0-9a-f]{12}$/) as unknown,
          type: "key",
          created: "2026-10-28T10:12:00Z",
          expires: null,
        },
      ],
      grants: [{ eco: "composer", package: "acme/*", versions: "^1.0", transitive: true }],
    });
    expect(JSON.stringify(res)).not.toContain("sha256:");
    const parsed = parseToken(res.token ?? "");
    expect(parsed?.project).toBe(project);
    const record = await getCredential(env, project);
    if (record === null || parsed === null) throw new Error("not stored");
    expect(await verifyKey(record, parsed.secret, NOW.getTime())).not.toBeNull();
    expect(await readCredentialView(env, project)).toEqual(res.credential);
    expect(await code(createCredential(env, { project, kind: "read" }, NOW))).toBe(
      "credential_exists",
    );
  });

  it("puts TOKEN_PREFIX in front of issued tokens", async () => {
    const project = unique("pre-");
    const res = await createCredential(
      { ...env, TOKEN_PREFIX: "srg_" },
      { project, kind: "read" },
      NOW,
    );
    expect(res.token).toMatch(new RegExp(`^srg_${project}:[A-Za-z0-9]{32}$`));
  });

  it("creates a gh-only credential without a token", async () => {
    const project = unique("ci-");
    const res = await createCredential(
      env,
      {
        project,
        kind: "publish",
        grants: [{ eco: "composer", package: "acme/sdk" }],
        secret: { type: "gh", repository: "acme/sdk", ref: "refs/heads/main" },
      },
      NOW,
    );
    expect(res.token).toBeUndefined();
    expect(res.credential.auth).toEqual([
      expect.objectContaining({
        type: "gh",
        repository: "acme/sdk",
        ref: "refs/heads/main",
        workflow: null,
      }),
    ]);
  });

  it.each([
    [{ project: "X", kind: "read" }],
    [{ project: "ok-project", kind: "owner" }],
    [{ project: "ok-project", kind: "admin", grants: [{ eco: "npm", package: "*" }] }],
    [
      {
        project: "ok-project",
        kind: "read",
        grants: [{ eco: "composer", package: "a/*", versions: "dev-main" }],
      },
    ],
    [{ project: "ok-project", kind: "read", secret: { type: "password" } }],
    [{ project: "ok-project", kind: "read", secret: { type: "key", repository: "a/b" } }],
    [{ project: "ok-project", kind: "read", secret: { type: "gh", repository: "nope" } }],
    [{ project: "ok-project", kind: "read", secret: { type: "key", expires: "tomorrow" } }],
  ])("rejects %j", async (body) => {
    expect(await code(createCredential(env, body, NOW))).toBe("invalid_request");
  });

  it("lists credentials sorted by project", async () => {
    await createCredential(env, { project: unique("list-"), kind: "read" }, NOW);
    const { credentials } = await listCredentialViews(env);
    const projects = credentials.map((c) => c.project);
    expect(projects).toEqual([...projects].sort());
    expect(credentials.length).toBeGreaterThan(0);
  });

  it("replaces grants and nothing else", async () => {
    const project = unique("patch-");
    await createCredential(env, { project, kind: "read" }, NOW);
    const grants = [{ eco: "composer", package: "acme/*", versions: "*" }];
    expect((await updateGrants(env, project, { grants })).grants).toEqual([
      { ...grants[0], transitive: true },
    ]);
    const opaque = [{ ...grants[0], transitive: false }];
    expect((await updateGrants(env, project, { grants: opaque })).grants).toEqual(opaque);
    expect((await updateGrants(env, project, { grants: [] })).grants).toEqual([]);
    expect(await code(updateGrants(env, project, {}))).toBe("invalid_request");
    expect(await code(updateGrants(env, project, { grants, kind: "admin" }))).toBe(
      "invalid_request",
    );
    expect(await code(updateGrants(env, unique("missing-"), { grants }))).toBe("not_found");
    expect(await code(updateGrants(env, "okta.shop", { grants }))).toBe("invalid_request");

    const admin = unique("admin-");
    await createCredential(env, { project: admin, kind: "admin" }, NOW);
    expect(await code(updateGrants(env, admin, { grants }))).toBe("invalid_request");
    expect((await updateGrants(env, admin, { grants: [] })).grants).toEqual([]);
  });

  it("refuses to delete the last admin", async () => {
    for (const record of (await listCredentialViews(env)).credentials) {
      if (record.kind === "admin") await env.AUTH.delete(`cred:${record.project}`);
    }
    const first = unique("admin-");
    const second = unique("admin-");
    await createCredential(env, { project: first, kind: "admin" }, NOW);
    expect(await code(removeCredential(env, first))).toBe("forbidden");
    await createCredential(env, { project: second, kind: "admin" }, NOW);
    expect(await removeCredential(env, first)).toEqual({ project: first, deleted: true });
    expect(await getCredential(env, first)).toBeNull();
    expect(await code(removeCredential(env, first))).toBe("not_found");
  });

  it("adds key and gh secrets", async () => {
    const project = unique("sec-");
    await createCredential(env, { project, kind: "read" }, NOW);
    const key = await addSecret(env, project, { type: "key", expires: "2026-12-01" }, NOW);
    expect(key.secret).toMatchObject({ type: "key", expires: "2026-12-01T00:00:00Z" });
    expect(key.token).toMatch(new RegExp(`^${project}:[A-Za-z0-9]{32}$`));

    const gh = await addSecret(
      env,
      project,
      { type: "gh", repository: "acme/shop", workflow: "ci.yml" },
      NOW,
    );
    expect(gh).toEqual({
      secret: {
        id: expect.stringMatching(/^[0-9a-f]{12}$/) as unknown,
        type: "gh",
        repository: "acme/shop",
        ref: null,
        workflow: "ci.yml",
        repository_id: null,
        repository_owner_id: null,
        environment: null,
        pin_on_first_use: true,
        created: "2026-10-28T10:12:00Z",
        expires: null,
      },
    });
    expect(
      await code(
        addSecret(env, project, { type: "gh", repository: "acme/shop", workflow: "ci.yml" }, NOW),
      ),
    ).toBe("invalid_request");
    expect((await readCredentialView(env, project)).auth).toHaveLength(3);
    expect(await code(addSecret(env, unique("missing-"), { type: "key" }, NOW))).toBe("not_found");
  });
});

describe("gh entry claims", () => {
  it("stores the optional repository ids, ref glob, workflow and environment", async () => {
    const project = unique("ghx-");
    await createCredential(env, { project, kind: "publish" }, NOW);
    const body = {
      type: "gh",
      repository: "acme/*",
      repository_id: "123456",
      repository_owner_id: "789",
      ref: "refs/tags/v*",
      workflow: ".github/workflows/release.yml",
      environment: "release",
      expires: "2027-01-01",
    };
    const { secret } = await addSecret(env, project, body, NOW);
    expect(secret).toMatchObject({ ...body, expires: "2027-01-01T00:00:00Z" });
    const stored = (await getCredential(env, project))?.auth[1];
    expect(stored).toMatchObject({ repository_id: "123456", environment: "release" });

    // Differing only in the environment is not a duplicate.
    const other = await addSecret(env, project, { ...body, environment: "staging" }, NOW);
    expect(other.secret).toMatchObject({ environment: "staging" });
    expect(await code(addSecret(env, project, body, NOW))).toBe("invalid_request");
  });

  it("stores pin_on_first_use explicitly, true by default", async () => {
    const project = unique("ghp-");
    await createCredential(env, { project, kind: "publish" }, NOW);
    const off = await addSecret(
      env,
      project,
      { type: "gh", repository: "acme/a", pin_on_first_use: false },
      NOW,
    );
    expect(off.secret).toMatchObject({ pin_on_first_use: false });
    const on = await addSecret(env, project, { type: "gh", repository: "acme/b" }, NOW);
    expect(on.secret).toMatchObject({ pin_on_first_use: true });
    const stored = (await getCredential(env, project))?.auth.slice(1);
    expect(stored?.map((e) => (e.type === "gh" ? e.pin_on_first_use : undefined))).toEqual([
      false,
      true,
    ]);
    const bad = (body: Record<string, unknown>) => code(addSecret(env, project, body, NOW));
    expect(await bad({ type: "gh", repository: "acme/c", pin_on_first_use: "yes" })).toBe(
      "invalid_request",
    );
    expect(await bad({ type: "key", pin_on_first_use: true })).toBe("invalid_request");
  });

  it("validates the new fields", async () => {
    const project = unique("ghv-");
    await createCredential(env, { project, kind: "read" }, NOW);
    const gh = (extra: Record<string, unknown>) =>
      code(addSecret(env, project, { type: "gh", repository: "acme/shop", ...extra }, NOW));
    expect(await gh({ repository_id: "12a" })).toBe("invalid_request");
    expect(await gh({ repository_id: 12 })).toBe("invalid_request");
    expect(await gh({ repository_owner_id: "" })).toBe("invalid_request");
    expect(await gh({ environment: "" })).toBe("invalid_request");
    expect(await gh({ repository: "acme/*/x" })).toBe("invalid_request");
    expect(await gh({ repository: "*/*" })).toBe("invalid_request");
    expect(await code(addSecret(env, project, { type: "key", environment: "x" }, NOW))).toBe(
      "invalid_request",
    );
  });

  it("allows key secrets on publish credentials", async () => {
    const project = unique("pubkey-");
    const created = await createCredential(env, { project, kind: "publish" }, NOW);
    expect(created.token).toMatch(new RegExp(`^${project}:`));
    const added = await addSecret(env, project, { type: "key" }, NOW);
    expect(added.token).toMatch(new RegExp(`^${project}:`));
  });
});

describe("expireSecret", () => {
  async function withEntries(hashes: string[]): Promise<string> {
    const project = unique("exp-");
    const record: CredentialRecord = {
      project,
      kind: "read",
      auth: hashes.map((hex) => ({
        type: "key",
        hash: `sha256:${hex}`,
        created: "2026-01-01T00:00:00Z",
        expires: null,
      })),
      grants: [],
    };
    await putCredential(env, record);
    return project;
  }

  it("expires an entry now by default and at a later date on request", async () => {
    const project = await withEntries(["1".repeat(64), "2".repeat(64)]);
    expect(await expireSecret(env, project, "11111111", {}, NOW)).toEqual({
      secret: {
        id: "111111111111",
        type: "key",
        created: "2026-01-01T00:00:00Z",
        expires: "2026-10-28T10:12:00Z",
      },
    });
    const later = await expireSecret(env, project, "222222222222", { expires: "2026-11-11" }, NOW);
    expect(later.secret.expires).toBe("2026-11-11T00:00:00Z");
  });

  it("treats a past date as now and never extends an expiry", async () => {
    const project = await withEntries(["3".repeat(64)]);
    const past = await expireSecret(env, project, "33333333", { expires: "2020-01-01" }, NOW);
    expect(past.secret.expires).toBe("2026-10-28T10:12:00Z");
    const extended = await expireSecret(env, project, "33333333", { expires: "2027-01-01" }, NOW);
    expect(extended.secret.expires).toBe("2026-10-28T10:12:00Z");
  });

  it("requires exactly one match", async () => {
    const project = await withEntries([`abcdef12${"0".repeat(56)}`, `abcdef12${"1".repeat(56)}`]);
    expect(await code(expireSecret(env, project, "abcdef12", {}, NOW))).toBe("invalid_request");
    expect((await expireSecret(env, project, "abcdef120000", {}, NOW)).secret.id).toBe(
      "abcdef120000",
    );
    expect(await code(expireSecret(env, project, "ffffffff", {}, NOW))).toBe("not_found");
    expect(await code(expireSecret(env, project, "abc", {}, NOW))).toBe("invalid_request");
    expect(await code(expireSecret(env, project, "abcdef12", { expires: 5 }, NOW))).toBe(
      "invalid_request",
    );
  });
});

describe("first run", () => {
  it("creates the first admin only while no credential exists", async () => {
    for (const key of (await env.AUTH.list({ prefix: "cred:" })).keys) {
      await env.AUTH.delete(key.name);
    }
    expect(await hasAnyCredential(env)).toBe(false);
    expect(await code(createFirstAdmin(env, "Bad Name", NOW))).toBe("invalid_request");
    const res = await createFirstAdmin(env, "owner", NOW);
    expect(res.credential).toMatchObject({ project: "owner", kind: "admin", grants: [] });
    expect(res.token).toMatch(/^owner:[A-Za-z0-9]{32}$/);
    expect(await hasAnyCredential(env)).toBe(true);
    expect(await code(createFirstAdmin(env, "intruder", NOW))).toBe("forbidden");
  });
});
