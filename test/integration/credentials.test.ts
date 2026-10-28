import { beforeAll, describe, expect, it } from "vitest";
import { call, credential, type ErrorBody } from "./helpers";

interface AuthEntryView {
  id: string;
  type: string;
  expires: string | null;
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
