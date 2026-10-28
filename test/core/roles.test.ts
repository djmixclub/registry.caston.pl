import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addSecret, createCredential, updateGrants } from "../../src/core/admin";
import {
  authenticate,
  createSession,
  effectiveRoles,
  getCredential,
  grantsFor,
  hashSecret,
  legacyGrants,
  primaryKind,
  putCredential,
  sessionIdentity,
  type AuthRecordEntry,
  type CredentialRecord,
  type Kind,
} from "../../src/core/auth";
import { ValidationError } from "../../src/core/errors";
import type { Grant } from "../../src/core/grants";

const NOW = new Date("2026-10-28T10:12:00Z");
const GRANT: Grant = { eco: "npm", package: "@acme/*", versions: "*", transitive: true };
const SECRET = "k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e";

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

async function keyEntry(secret: string, scope?: Kind[]): Promise<AuthRecordEntry> {
  const entry: AuthRecordEntry = {
    type: "key",
    hash: await hashSecret(secret),
    created: "2026-01-01",
    expires: null,
  };
  return scope === undefined ? entry : { ...entry, scope };
}

const request = (token: string) =>
  new Request("https://registry.test/", { headers: { authorization: `Bearer ${token}` } });
const authEnv = { AUTH: env.AUTH, PUBLIC_URL: undefined, TOKEN_PREFIX: undefined };

describe("stored credential records", () => {
  it("reads a record written with kind and flat grants as roles and per-role grants", async () => {
    const stored = (kind: string) => ({ project: "p", kind, auth: [], grants: [GRANT] });
    await env.AUTH.put(
      "cred:legacy-read",
      JSON.stringify({ ...stored("read"), project: "legacy-read" }),
    );
    await env.AUTH.put(
      "cred:legacy-pub",
      JSON.stringify({ ...stored("publish"), project: "legacy-pub" }),
    );
    const reader = await getCredential(env, "legacy-read", { fresh: true });
    expect(reader).toEqual({
      project: "legacy-read",
      roles: ["read"],
      auth: [],
      grants: { read: [GRANT], publish: [] },
    });
    const publisher = await getCredential(env, "legacy-pub", { fresh: true });
    expect(publisher?.roles).toEqual(["publish"]);
    expect(publisher?.grants).toEqual({ read: [], publish: [GRANT] });
  });

  it("rejects role sets that are not allowed", async () => {
    for (const roles of [[], ["admin", "read"], ["read", "read"], ["owner"]]) {
      const name = unique("badroles");
      const record = { project: name, roles, auth: [], grants: { read: [], publish: [] } };
      await env.AUTH.put(`cred:${name}`, JSON.stringify(record));
      expect(await getCredential(env, name, { fresh: true })).toBeNull();
    }
  });
});

describe("roles of a secret", () => {
  const dual: CredentialRecord = {
    project: "dual-roles",
    roles: ["read", "publish"],
    auth: [],
    grants: { read: [GRANT], publish: [] },
  };

  it("defaults to every role of the credential and stays within them", () => {
    expect(effectiveRoles(dual, {})).toEqual(["read", "publish"]);
    expect(effectiveRoles(dual, { scope: ["publish"] })).toEqual(["publish"]);
    expect(effectiveRoles({ roles: ["read"] }, { scope: ["read", "publish"] })).toEqual(["read"]);
    expect(effectiveRoles(dual, { scope: [] })).toEqual([]);
  });

  it("reports the legacy kind and grants as the read side first", () => {
    expect(primaryKind(["read", "publish"])).toBe("read");
    expect(primaryKind(["publish"])).toBe("publish");
    expect(primaryKind(["admin"])).toBe("admin");
    expect(legacyGrants(["read", "publish"], dual.grants)).toEqual([GRANT]);
    expect(legacyGrants(["admin"], dual.grants)).toEqual([]);
    expect(grantsFor(["publish"], dual.grants, "read")).toEqual([]);
  });

  it("limits what authenticate lets a key use", async () => {
    const name = unique("scoped");
    const read = "R".repeat(32);
    const publish = "P".repeat(32);
    const all = "A".repeat(32);
    const none = "N".repeat(32);
    await putCredential(env, {
      ...dual,
      project: name,
      auth: [
        await keyEntry(read, ["read"]),
        await keyEntry(publish, ["publish"]),
        await keyEntry(all),
        await keyEntry(none, []),
      ],
    });
    const roles = async (secret: string) =>
      (await authenticate(request(`${name}:${secret}`), authEnv))?.identity.roles ?? null;
    expect(await roles(read)).toEqual(["read"]);
    expect(await roles(publish)).toEqual(["publish"]);
    expect(await roles(all)).toEqual(["read", "publish"]);
    expect(await roles(none)).toBeNull();
  });

  it("never gives a panel session the publish role", async () => {
    const name = unique("session");
    await putCredential(env, { ...dual, project: name, auth: [await keyEntry(SECRET)] });
    const sessionEnv = { AUTH: env.AUTH, SESSION_SECRET: "unit-test-session-secret" };
    const value = await createSession(sessionEnv, name);
    const cookie = new Request("https://registry.test/", {
      headers: { cookie: `sreg_session=${value}` },
    });
    const found = await sessionIdentity(cookie, sessionEnv);
    expect(found?.identity.roles).toEqual(["read"]);
  });
});

describe("secrets of a credential with both roles", () => {
  async function dualCredential(): Promise<string> {
    const project = unique("adm-dual-");
    await createCredential(
      env,
      {
        project,
        roles: ["read", "publish"],
        read_grants: [{ eco: "npm", package: "@acme/*", versions: "*" }],
        publish_grants: [{ eco: "npm", package: "@acme/sdk", versions: "*" }],
        secret: { type: "key", scope: ["read"] },
      },
      NOW,
    );
    return project;
  }

  it("takes a scope within the credential's roles", async () => {
    const project = await dualCredential();
    expect(await code(addSecret(env, project, { type: "key" }, NOW))).toBe("invalid_request");
    for (const scope of [[], ["admin"], ["read", "read"], "read"]) {
      expect(await code(addSecret(env, project, { type: "key", scope }, NOW))).toBe(
        "invalid_request",
      );
    }
    const added = await addSecret(env, project, { type: "key", scope: ["publish", "read"] }, NOW);
    expect(added.secret.scope).toEqual(["read", "publish"]);
  });

  it("allows identical gh claims only for different scopes", async () => {
    const project = await dualCredential();
    const gh = { type: "gh", repository: "acme/dual" };
    await addSecret(env, project, { ...gh, scope: ["read"] }, NOW);
    expect(await code(addSecret(env, project, { ...gh, scope: ["read"] }, NOW))).toBe(
      "invalid_request",
    );
    expect(await code(addSecret(env, project, { ...gh, scope: ["publish"] }, NOW))).toBe("ok");
  });

  it("takes grants only for roles the credential holds", async () => {
    const project = unique("one-role-");
    const body = { project, roles: ["read"], publish_grants: [GRANT] };
    expect(await code(createCredential(env, body, NOW))).toBe("invalid_request");
    const both = { project, roles: ["read", "publish"], grants: [GRANT] };
    expect(await code(createCredential(env, both, NOW))).toBe("invalid_request");
    expect(await code(createCredential(env, { project, kind: "read", roles: ["read"] }, NOW))).toBe(
      "invalid_request",
    );
  });

  it("takes no scope on an admin credential", async () => {
    const project = unique("adm-");
    const secret = { type: "key", scope: ["read"] };
    expect(await code(createCredential(env, { project, kind: "admin", secret }, NOW))).toBe(
      "invalid_request",
    );
  });
});

describe("changing the roles of a credential", () => {
  it("pins existing secrets to the roles they had when a role is added", async () => {
    const project = unique("grow-");
    await createCredential(env, { project, kind: "read" }, NOW);
    const patched = await updateGrants(
      env,
      project,
      { roles: ["read", "publish"], publish_grants: [GRANT] },
      NOW,
    );
    expect(patched.roles).toEqual(["read", "publish"]);
    expect(patched.auth.map((e) => e.scope)).toEqual([["read"]]);
    const stored = await getCredential(env, project, { fresh: true });
    expect(stored?.auth[0]?.scope).toEqual(["read"]);
  });

  it("drops the grants of a removed role and refuses to strand an active secret", async () => {
    const project = unique("shrink-");
    await createCredential(
      env,
      {
        project,
        roles: ["read", "publish"],
        read_grants: [GRANT],
        publish_grants: [GRANT],
        secret: { type: "key", scope: ["read", "publish"] },
      },
      NOW,
    );
    await addSecret(env, project, { type: "key", scope: ["publish"] }, NOW);
    expect(await code(updateGrants(env, project, { roles: ["read"] }, NOW))).toBe(
      "invalid_request",
    );
    const record = await getCredential(env, project, { fresh: true });
    expect(record?.roles).toEqual(["read", "publish"]);
  });
});
