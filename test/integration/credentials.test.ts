import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { ORIGIN, call, credential, type ErrorBody } from "./helpers";

interface AuthEntryView {
  id: string;
  type: string;
  expires: string | null;
  description?: string | null;
}

interface CredentialView {
  project: string;
  kind: string;
  auth: AuthEntryView[];
  grants: unknown[];
}

let admin: string;

beforeAll(async () => {
  admin = await credential("cred-admin", "admin");
});

describe("credentials API", () => {
  it("runs the whole lifecycle of a consumer credential", async () => {
    const created = await call("POST", "/api/v1/credentials", {
      token: admin,
      body: {
        project: "shop",
        kind: "read",
        grants: [{ eco: "composer", package: "acme/*", versions: "^1.0" }],
      },
    });
    expect(created.status).toBe(201);
    const { credential: view, token } = await created.json<{
      credential: CredentialView;
      token: string;
    }>();
    expect(token).toMatch(/^shop:[A-Za-z0-9]{32}$/);
    expect(view).toMatchObject({ project: "shop", kind: "read" });
    expect(JSON.stringify(view)).not.toContain("hash");

    const whoami = await call("GET", "/api/v1/whoami", { token });
    expect(await whoami.json()).toMatchObject({ project: "shop", kind: "read" });

    const listed = await call("GET", "/api/v1/credentials", { token: admin });
    const { credentials } = await listed.json<{ credentials: CredentialView[] }>();
    expect(credentials.map((c) => c.project)).toEqual(
      expect.arrayContaining(["cred-admin", "shop"]),
    );

    const one = await call("GET", "/api/v1/credentials/shop", { token: admin });
    expect(await one.json()).toEqual(view);

    const patched = await call("PATCH", "/api/v1/credentials/shop", {
      token: admin,
      body: { grants: [{ eco: "composer", package: "acme/sdk", versions: "*" }] },
    });
    expect(patched.status).toBe(200);
    expect((await patched.json<CredentialView>()).grants).toEqual([
      { eco: "composer", package: "acme/sdk", versions: "*", transitive: true },
    ]);

    const rotated = await call("POST", "/api/v1/credentials/shop/secrets", {
      token: admin,
      body: { type: "key" },
    });
    expect(rotated.status).toBe(201);
    const { token: next } = await rotated.json<{ secret: AuthEntryView; token: string }>();
    expect((await call("GET", "/api/v1/whoami", { token: next })).status).toBe(200);

    const firstId = view.auth[0]?.id ?? "";
    const expired = await call(
      "DELETE",
      `/api/v1/credentials/shop/secrets/${firstId.slice(0, 8)}`,
      {
        token: admin,
      },
    );
    expect(expired.status).toBe(200);
    const { secret } = await expired.json<{ secret: AuthEntryView }>();
    expect(secret.id).toBe(firstId);
    expect(secret.expires).not.toBeNull();
    expect((await call("GET", "/api/v1/whoami", { token })).status).toBe(401);
    expect((await call("GET", "/api/v1/whoami", { token: next })).status).toBe(200);

    const deleted = await call("DELETE", "/api/v1/credentials/shop", { token: admin });
    expect(await deleted.json()).toEqual({ project: "shop", deleted: true });
    expect((await call("GET", "/api/v1/whoami", { token: next })).status).toBe(401);
    expect((await call("GET", "/api/v1/credentials/shop", { token: admin })).status).toBe(404);
  });

  it("adds gh entries without returning a token", async () => {
    await call("POST", "/api/v1/credentials", {
      token: admin,
      body: { project: "ci-gh", kind: "publish", secret: { type: "gh", repository: "acme/sdk" } },
    });
    const res = await call("POST", "/api/v1/credentials/ci-gh/secrets", {
      token: admin,
      body: { type: "gh", repository: "acme/sdk", ref: "refs/heads/main" },
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty("token");
    expect(body.secret).toMatchObject({ type: "gh", ref: "refs/heads/main", workflow: null });
  });

  it("answers the documented errors", async () => {
    const dup = await call("POST", "/api/v1/credentials", {
      token: admin,
      body: { project: "cred-admin", kind: "admin" },
    });
    expect((await dup.json<ErrorBody>()).error).toBe("credential_exists");
    expect(dup.status).toBe(409);

    const provider = await call("GET", "/api/v1/credentials/okta.shop", { token: admin });
    expect(provider.status).toBe(400);

    const lastAdmin = await call("DELETE", "/api/v1/credentials/cred-admin", { token: admin });
    expect(lastAdmin.status).toBe(403);

    const patchKind = await call("PATCH", "/api/v1/credentials/cred-admin", {
      token: admin,
      body: { grants: [], kind: "read" },
    });
    expect(patchKind.status).toBe(400);

    const unknownSecret = await call("DELETE", "/api/v1/credentials/cred-admin/secrets/ffffffff", {
      token: admin,
    });
    expect(unknownSecret.status).toBe(404);
  });
});

describe("logins through the API and the panel", () => {
  const password = "Panel.Password.2026";

  it("creates an admin with a login and answers the password once, not a token", async () => {
    const created = await call("POST", "/api/v1/credentials", {
      token: admin,
      body: {
        project: "pw-ops",
        kind: "admin",
        secret: { type: "login", password, description: "Ops lead" },
      },
    });
    expect(created.status).toBe(201);
    const body = await created.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty("token");
    expect(body.login).toEqual({ password });
    expect(body.credential).toMatchObject({
      project: "pw-ops",
      auth: [{ type: "login", totp: false, description: "Ops lead" }],
    });
    expect(JSON.stringify(body.credential)).not.toContain(password);

    // The password is not a token, in any of the forms a token can take.
    for (const headers of [
      { authorization: `Bearer pw-ops:${password}` },
      { authorization: `Basic ${btoa(`pw-ops:${password}`)}` },
    ]) {
      expect((await call("GET", "/api/v1/whoami", { headers })).status).toBe(401);
    }
  });

  it("logs in to the panel with the login and password", async () => {
    const res = await exports.default.fetch(
      new Request(`${ORIGIN}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        body: new URLSearchParams({ mode: "password", login: "pw-ops", password }),
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(/^sreg_session=/);
  });

  it("answers 400 for a short password and for a password on a key", async () => {
    const short = await call("POST", "/api/v1/credentials/pw-ops/secrets", {
      token: admin,
      body: { type: "login", password: "too-short" },
    });
    expect(short.status).toBe(400);
    for (const kind of ["read", "admin"]) {
      const res = await call("POST", "/api/v1/credentials", {
        token: admin,
        body: { project: `pw-${kind}`, kind, secret: { type: "key", password } },
      });
      expect(res.status).toBe(400);
      expect(await res.json<ErrorBody>()).toEqual({
        error: "invalid_request",
        message: "`password` only applies to `login` secrets; a `key` is always generated.",
      });
    }
  });
});

describe("secrets without a first secret and with descriptions", () => {
  it("creates a credential with `secret: null` and no token", async () => {
    const res = await call("POST", "/api/v1/credentials", {
      token: admin,
      body: { project: "bare-reader", kind: "read", secret: null },
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ credential: CredentialView; token?: string }>();
    expect(body.credential.auth).toEqual([]);
    expect(body.token).toBeUndefined();
    const admins = await call("POST", "/api/v1/credentials", {
      token: admin,
      body: { project: "bare-admin", kind: "admin", secret: null },
    });
    expect(admins.status).toBe(400);
  });

  it("sets, changes and clears a description with PATCH", async () => {
    const created = await call("POST", "/api/v1/credentials", {
      token: admin,
      body: { project: "described", kind: "read", secret: { type: "key", description: " first " } },
    });
    const { credential: view } = await created.json<{ credential: CredentialView }>();
    const id = view.auth[0]?.id ?? "";
    expect(view.auth[0]).toMatchObject({ description: "first" });

    const patch = (body: unknown, path = id) =>
      call("PATCH", `/api/v1/credentials/described/secrets/${path}`, { token: admin, body });
    const changed = await patch({ description: "second" });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ secret: { id, description: "second" } });
    const cleared = await patch({ description: null });
    expect(await cleared.json()).toMatchObject({ secret: { id, description: null } });

    expect((await patch({})).status).toBe(400);
    expect((await patch({ description: "x".repeat(201) })).status).toBe(400);
    expect((await patch({ description: "x", expires: "2030-01-01" })).status).toBe(400);
    expect((await patch({ description: "x" }, "ffffffff")).status).toBe(404);
    const reader = await credential("desc-reader", "read");
    const forbidden = await call("PATCH", `/api/v1/credentials/described/secrets/${id}`, {
      token: reader,
      body: { description: "x" },
    });
    expect(forbidden.status).toBe(403);
  });

  it("replaces a gh secret in one call", async () => {
    const created = await call("POST", "/api/v1/credentials", {
      token: admin,
      body: { project: "gh-editing", kind: "publish", secret: null },
    });
    expect(created.status).toBe(201);
    const gh = { type: "gh", repository: "acme/shop", ref: "refs/tags/v*" };
    const first = await call("POST", "/api/v1/credentials/gh-editing/secrets", {
      token: admin,
      body: gh,
    });
    const { secret: old } = await first.json<{ secret: { id: string } }>();
    const dup = await call("POST", "/api/v1/credentials/gh-editing/secrets", {
      token: admin,
      body: gh,
    });
    expect(dup.status).toBe(400);
    const replaced = await call("POST", "/api/v1/credentials/gh-editing/secrets", {
      token: admin,
      body: { ...gh, workflow: ".github/workflows/release.yml", replaces: old.id },
    });
    expect(replaced.status).toBe(201);
    const view = await (
      await call("GET", "/api/v1/credentials/gh-editing", { token: admin })
    ).json<CredentialView>();
    expect(view.auth).toHaveLength(2);
    expect(view.auth.find((e) => e.id === old.id)?.expires).not.toBeNull();
    const wrongType = await call("POST", "/api/v1/credentials/gh-editing/secrets", {
      token: admin,
      body: { type: "key", replaces: old.id },
    });
    expect(wrongType.status).toBe(400);
  });
});
