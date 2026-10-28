import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addSecret, createCredential, updateGrants } from "../../src/core/admin";
import { approvalProblem, decideLoginSession, readDecision } from "../../src/core/login";
import {
  authEntryId,
  authenticate,
  createSession,
  effectiveRoles,
  getCredential,
  grantsFor,
  hashSecret,
  issueLoginToken,
  legacyGrants,
  primaryKind,
  putCredential,
  sessionIdentity,
  verifyLoginToken,
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

describe("login secrets of a credential with both roles", () => {
  const sessionEnv = { SESSION_SECRET: "unit-test-session-secret" };
  const loginEnv = { ...env, ...sessionEnv, PUBLIC_URL: "https://registry.test" };
  const scopes = [{ eco: "composer" as const, package: "acme/lib", version: "1.0.0" }];
  const exp = NOW.getTime() + 3_600_000;

  async function dualWithLogins() {
    const project = unique("dual-login-");
    await createCredential(
      env,
      {
        project,
        roles: ["read", "publish"],
        read_grants: [{ eco: "composer", package: "acme/*", versions: "*" }],
        publish_grants: [{ eco: "composer", package: "acme/*", versions: "*" }],
        secret: null,
      },
      NOW,
    );
    const add = async (scope: Kind[]) =>
      (await addSecret(env, project, { type: "login", password: "long-enough-pass", scope }, NOW))
        .secret.id;
    const reader = await add(["read"]);
    const publisher = await add(["publish"]);
    const both = await add(["read", "publish"]);
    const record = await getCredential(env, project, { fresh: true });
    if (record === null) throw new Error("missing credential");
    return { record, reader, publisher, both };
  }

  const secretOf = async (project: string, id: string, scopeList?: typeof scopes) =>
    (await issueLoginToken(loginEnv, project, id, exp, scopeList)).slice(project.length + 4);

  it("issues a token only for a role the login's scope includes", async () => {
    const { record, reader, publisher, both } = await dualWithLogins();
    const now = NOW.getTime();
    const check = async (id: string, list?: typeof scopes) =>
      verifyLoginToken(sessionEnv, record, await secretOf(record.project, id, list), now);
    expect((await check(reader))?.roles).toEqual(["read"]);
    expect(await check(reader, scopes)).toBeNull();
    expect((await check(publisher, scopes))?.roles).toEqual(["publish"]);
    expect(await check(publisher)).toBeNull();
    expect((await check(both))?.roles).toEqual(["read"]);
    expect((await check(both, scopes))?.roles).toEqual(["publish"]);
  });

  it("approves a login request only for a login whose scope covers its purpose", async () => {
    const { record, reader, publisher, both } = await dualWithLogins();
    const entryOf = async (id: string) => {
      for (const e of record.auth) if ((await authEntryId(e)) === id) return e;
      throw new Error("no such entry");
    };
    const pull = { purpose: "pull" as const, eco: "composer" as const, nonce: "n", exp: 0 };
    const publish = { purpose: "publish" as const, scopes, nonce: "n", exp: 0 };
    const problem = async (session: typeof pull | typeof publish, id: string) =>
      approvalProblem(env, session, record, await entryOf(id));
    expect(await problem(pull, reader)).toBeNull();
    expect(await problem(pull, both)).toBeNull();
    expect(await problem(pull, publisher)).toContain("scope does not include the read role");
    expect(await problem(publish, publisher)).toBeNull();
    expect(await problem(publish, both)).toBeNull();
    expect(await problem(publish, reader)).toContain("scope does not include the publish role");
  });

  it("stores no decision and issues no token when the login's scope lacks the role", async () => {
    const { record, reader } = await dualWithLogins();
    const refused = await decideLoginSession(
      loginEnv,
      {
        purpose: "publish",
        scopes,
        nonce: "scope-test",
        exp: Math.floor(NOW.getTime() / 1000) + 600,
      },
      record,
      reader,
      true,
      NOW,
    );
    expect(refused).toBe(false);
    expect(await readDecision(loginEnv, "scope-test")).toBeNull();
  });
});
