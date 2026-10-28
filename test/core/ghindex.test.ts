import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addSecret,
  createCredential,
  expireSecret,
  removeCredential,
  updateGrants,
} from "../../src/core/admin";
import {
  authEntryId,
  getCredential,
  putCredential,
  type CredentialRecord,
  type GhAuthRecord,
} from "../../src/core/auth";
import { cleanup } from "../../src/core/cron";
import {
  GH_REPO_PREFIX,
  ghRepoCandidates,
  ghRepoKey,
  ghRepoKeys,
  rebuildGhRepoIndex,
  syncGhRepoIndex,
} from "../../src/core/ghindex";
import { recordOf } from "../records";

const NOW = new Date("2026-10-28T10:12:00Z");
const adminEnv = { AUTH: env.AUTH, TOKEN_PREFIX: "" };

function gh(repository: string, overrides: Partial<GhAuthRecord> = {}): GhAuthRecord {
  return {
    type: "gh",
    repository,
    ref: null,
    workflow: null,
    created: "2026-10-28T09:00:00Z",
    expires: null,
    ...overrides,
  };
}

function record(project: string, ...auth: GhAuthRecord[]): CredentialRecord {
  return recordOf(project, "read", auth);
}

async function index(key: string): Promise<unknown> {
  return env.AUTH.get(GH_REPO_PREFIX + key, "json");
}

beforeEach(async () => {
  const listed = await env.AUTH.list({ prefix: GH_REPO_PREFIX });
  await Promise.all(listed.keys.map((k) => env.AUTH.delete(k.name)));
});

describe("gh-repo keys", () => {
  it("lower-cases repositories and owner globs", () => {
    expect(ghRepoKey("Acme/SDK")).toBe("gh-repo:acme/sdk");
    expect(ghRepoKey("Acme/*")).toBe("gh-repo:acme/*");
  });

  it("collects one key per distinct gh repository and ignores keys", () => {
    const keys = ghRepoKeys(
      recordOf("p", "read", [
        gh("acme/sdk"),
        gh("Acme/SDK", { ref: "refs/tags/v*" }),
        gh("acme/*"),
        { type: "key", hash: "sha256:00", created: "2026-01-01", expires: null },
      ]),
    );
    expect([...keys].sort()).toEqual(["gh-repo:acme/*", "gh-repo:acme/sdk"]);
    expect(ghRepoKeys(null).size).toBe(0);
  });
});

describe("syncGhRepoIndex", () => {
  it("adds, keeps sorted and removes projects", async () => {
    await syncGhRepoIndex(env, null, record("zeta", gh("acme/sdk")));
    await syncGhRepoIndex(env, null, record("alpha", gh("Acme/Sdk"), gh("acme/*")));
    expect(await index("acme/sdk")).toEqual(["alpha", "zeta"]);
    expect(await index("acme/*")).toEqual(["alpha"]);

    const before = record("alpha", gh("acme/sdk"), gh("acme/*"));
    await syncGhRepoIndex(env, before, record("alpha", gh("acme/other")));
    expect(await index("acme/sdk")).toEqual(["zeta"]);
    expect(await index("acme/*")).toBeNull();
    expect(await index("acme/other")).toEqual(["alpha"]);

    await syncGhRepoIndex(env, record("zeta", gh("acme/sdk")), null);
    expect(await index("acme/sdk")).toBeNull();
  });

  it("heals a project missing from a key it should be under", async () => {
    const same = record("p", gh("acme/sdk"));
    await syncGhRepoIndex(env, same, same);
    expect(await index("acme/sdk")).toEqual(["p"]);
  });
});

describe("ghRepoCandidates", () => {
  it("unites the repository and its owner glob, case-insensitively", async () => {
    await syncGhRepoIndex(env, null, record("one", gh("acme/sdk")));
    await syncGhRepoIndex(env, null, record("two", gh("acme/*")));
    await syncGhRepoIndex(env, null, record("three", gh("acme/other")));
    expect(await ghRepoCandidates(env, "ACME/sdk")).toEqual(["one", "two"]);
    expect(await ghRepoCandidates(env, "acme/x")).toEqual(["two"]);
    expect(await ghRepoCandidates(env, "other/sdk")).toEqual([]);
    expect(await ghRepoCandidates(env, "no-slash")).toEqual([]);
  });

  it("treats a malformed value as empty", async () => {
    await env.AUTH.put("gh-repo:acme/sdk", "not json");
    await env.AUTH.put("gh-repo:acme/*", JSON.stringify(["ok", 3]));
    expect(await ghRepoCandidates(env, "acme/sdk")).toEqual(["ok"]);
  });
});

describe("rebuildGhRepoIndex", () => {
  it("writes the keys the records need and deletes stale ones", async () => {
    await env.AUTH.put("gh-repo:stale/repo", JSON.stringify(["gone"]));
    await env.AUTH.put("gh-repo:acme/sdk", JSON.stringify(["gone"]));
    const written = await rebuildGhRepoIndex(env, [
      record("b", gh("acme/sdk")),
      record("a", gh("acme/sdk"), gh("Acme/*")),
    ]);
    expect(written).toBe(2);
    expect(await index("acme/sdk")).toEqual(["a", "b"]);
    expect(await index("acme/*")).toEqual(["a"]);
    expect(await index("stale/repo")).toBeNull();
  });
});

describe("credential writes keep the index in step", () => {
  it("covers create, grants, secrets, expiry and delete", async () => {
    await createCredential(
      adminEnv,
      { project: "idx-ci", kind: "publish", secret: { type: "gh", repository: "Acme/Lib" } },
      NOW,
    );
    expect(await index("acme/lib")).toEqual(["idx-ci"]);

    await env.AUTH.delete("gh-repo:acme/lib");
    await updateGrants(adminEnv, "idx-ci", { grants: [] });
    expect(await index("acme/lib")).toEqual(["idx-ci"]);

    await addSecret(adminEnv, "idx-ci", { type: "gh", repository: "acme/*" }, NOW);
    expect(await index("acme/*")).toEqual(["idx-ci"]);

    const stored = await getCredential(env, "idx-ci");
    const glob = stored?.auth.find((e) => e.type === "gh" && e.repository === "acme/*");
    const id = glob === undefined ? "" : await authEntryId(glob);
    await expireSecret(adminEnv, "idx-ci", id, {}, NOW);
    // An expired entry stays indexed until the cron removes it.
    expect(await index("acme/*")).toEqual(["idx-ci"]);
    await cleanup(env, new Date(NOW.getTime() + 1000));
    expect(await index("acme/*")).toBeNull();
    expect(await index("acme/lib")).toEqual(["idx-ci"]);

    await removeCredential(adminEnv, "idx-ci");
    expect(await index("acme/lib")).toBeNull();
  });

  it("does not index key-only credentials", async () => {
    await createCredential(adminEnv, { project: "idx-key", kind: "read" }, NOW);
    expect((await env.AUTH.list({ prefix: GH_REPO_PREFIX })).keys).toEqual([]);
    await putCredential(env, record("idx-direct", gh("acme/raw")));
    expect(await index("acme/raw")).toBeNull();
  });
});
