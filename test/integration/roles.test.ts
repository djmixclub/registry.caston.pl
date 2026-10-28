import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { manifestKey, stagingKey } from "../../src/core/storage";
import { ORIGIN, call, credential, publishComposer, sha256Hex, type ErrorBody } from "./helpers";
import { callWithPublicUrl, githubJwt, installGithubKey } from "./oidc";

// One credential holding `read` and `publish`, with a scope on every secret (docs/api.md 2.4).
// The tests of this file run in order.

const GRANT = { eco: "composer", package: "acme/*", versions: "*" };

let admin = "";
let readOnly = "";
let publishOnly = "";
let both = "";

async function create(body: Record<string, unknown>): Promise<Response> {
  return call("POST", "/api/v1/credentials", { token: admin, body });
}

async function secret(project: string, body: Record<string, unknown>): Promise<string> {
  const res = await call("POST", `/api/v1/credentials/${project}/secrets`, { token: admin, body });
  expect(res.status).toBe(201);
  return (await res.json<{ token: string }>()).token;
}

beforeAll(async () => {
  admin = await credential("roles-admin", "admin");
  await installGithubKey();
});

describe("a credential with both roles", () => {
  it("needs an explicit scope for its first secret", async () => {
    const res = await create({
      project: "dual",
      roles: ["read", "publish"],
      read_grants: [GRANT],
      publish_grants: [GRANT],
    });
    expect(res.status).toBe(400);
    expect((await res.json<ErrorBody>()).message).toContain("`scope` is required");
  });

  it("is created with per-role grants and a scoped first secret", async () => {
    const res = await create({
      project: "dual",
      roles: ["read", "publish"],
      read_grants: [GRANT],
      publish_grants: [{ ...GRANT, package: "acme/sdk" }],
      secret: { type: "key", scope: ["read"] },
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ token: string; credential: Record<string, unknown> }>();
    readOnly = body.token;
    expect(body.credential).toMatchObject({
      project: "dual",
      kind: "read",
      roles: ["read", "publish"],
      grants: [{ ...GRANT, transitive: true }],
      read_grants: [{ ...GRANT, transitive: true }],
      publish_grants: [{ ...GRANT, package: "acme/sdk", transitive: true }],
    });
    publishOnly = await secret("dual", { type: "key", scope: ["publish"] });
    both = await secret("dual", { type: "key", scope: ["read", "publish"] });
  });

  it("refuses the legacy flat grants and a missing scope on further secrets", async () => {
    const flat = await call("PATCH", "/api/v1/credentials/dual", {
      token: admin,
      body: { grants: [GRANT] },
    });
    expect(flat.status).toBe(400);
    const noScope = await call("POST", "/api/v1/credentials/dual/secrets", {
      token: admin,
      body: { type: "key" },
    });
    expect(noScope.status).toBe(400);
  });

  it("reports the roles a token may use from whoami", async () => {
    const roles = async (token: string) =>
      (await (await call("GET", "/api/v1/whoami", { token })).json<{ roles: string[] }>()).roles;
    expect(await roles(readOnly)).toEqual(["read"]);
    expect(await roles(publishOnly)).toEqual(["publish"]);
    expect(await roles(both)).toEqual(["read", "publish"]);
  });

  it("keeps a read-scoped secret from publishing", async () => {
    const res = await publishComposer(readOnly, "acme/sdk", "1.0.0");
    expect(res.status).toBe(403);
    expect((await call("GET", "/api/v1/packages", { token: readOnly })).status).toBe(200);
  });

  it("keeps a publish-scoped secret from reading", async () => {
    expect((await call("GET", "/api/v1/packages", { token: publishOnly })).status).toBe(403);
    const native = await call("GET", "/composer/p2/acme/sdk.json", { token: publishOnly });
    expect(native.status).toBe(403);
    const res = await publishComposer(publishOnly, "acme/sdk", "1.0.0");
    expect(res.status).toBe(201);
    const stored = await env.R2_BUCKET.get(manifestKey("composer", "acme/sdk", "1.0.0"));
    expect(await stored?.json()).toMatchObject({ publishedBy: "dual" });
  });

  it("checks publishing against the publish grants only", async () => {
    const res = await publishComposer(both, "acme/other", "1.0.0");
    expect(res.status).toBe(403);
    expect((await publishComposer(both, "acme/sdk", "1.1.0")).status).toBe(201);
    const list = await call("GET", "/api/v1/packages", { token: both });
    const { packages } = await list.json<{ packages: { name: string }[] }>();
    expect(packages.map((p) => p.name)).toContain("acme/sdk");
  });
});

describe("adding a role to an existing credential", () => {
  it("never widens the secrets it already has", async () => {
    const res = await create({ project: "solo", kind: "read", read_grants: [GRANT] });
    expect(res.status).toBe(201);
    const token = (await res.json<{ token: string }>()).token;

    const patch = await call("PATCH", "/api/v1/credentials/solo", {
      token: admin,
      body: { roles: ["read", "publish"], publish_grants: [GRANT] },
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ roles: ["read", "publish"], kind: "read" });

    expect((await publishComposer(token, "acme/solo", "1.0.0")).status).toBe(403);
    const added = await secret("solo", { type: "key", scope: ["publish"] });
    expect((await publishComposer(added, "acme/solo", "1.0.0")).status).toBe(201);
  });

  it("refuses to drop a role an active secret still needs", async () => {
    const patch = await call("PATCH", "/api/v1/credentials/solo", {
      token: admin,
      body: { roles: ["read"] },
    });
    expect(patch.status).toBe(400);
    expect((await patch.json<ErrorBody>()).message).toContain("would be left without a role");
  });

  it("does not turn a credential into an admin", async () => {
    const patch = await call("PATCH", "/api/v1/credentials/solo", {
      token: admin,
      body: { roles: ["admin"] },
    });
    expect(patch.status).toBe(400);
  });
});

describe("the _ login with scoped gh secrets", () => {
  async function callGh(method: string, path: string, jwt: string, body?: unknown) {
    return callWithPublicUrl(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          authorization: `Bearer _:gh.${jwt}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  it("resolves one credential for each role through different entries", async () => {
    const res = await create({
      project: "dual-gh",
      roles: ["read", "publish"],
      read_grants: [GRANT],
      publish_grants: [GRANT],
      secret: { type: "gh", repository: "acme/dualgh", scope: ["read"] },
    });
    expect(res.status).toBe(201);
    const second = await call("POST", "/api/v1/credentials/dual-gh/secrets", {
      token: admin,
      body: {
        type: "gh",
        repository: "acme/dualgh",
        ref: "refs/tags/v*",
        workflow: ".github/workflows/release.yml",
        scope: ["publish"],
      },
    });
    expect(second.status).toBe(201);

    const jwt = await githubJwt("acme/dualgh");
    const whoami = await callGh("GET", "/api/v1/whoami", jwt);
    expect(await whoami.json()).toMatchObject({ project: "dual-gh", roles: ["read"] });

    const bytes = new TextEncoder().encode("acme/dualgh@1.0.0");
    const sha = await sha256Hex(bytes);
    const init = await callGh("POST", "/api/v1/publish/init", jwt, {
      eco: "composer",
      name: "acme/dualgh",
      version: "1.0.0",
      files: [{ name: "acme-dualgh-1.0.0.zip", size: bytes.length, sha256: sha }],
      manifest: { name: "acme/dualgh", description: "x", require: { php: "^8.1" } },
    });
    expect(init.status).toBe(200);
    const { uploadId } = await init.json<{ uploadId: string }>();
    await env.R2_BUCKET.put(stagingKey(uploadId, "acme-dualgh-1.0.0.zip"), bytes, { sha256: sha });
    const commit = await callGh("POST", "/api/v1/publish/commit", jwt, { uploadId });
    expect(commit.status).toBe(201);
  });

  it("refuses a publish from a ref only the read entry would allow", async () => {
    const branch = await githubJwt("acme/dualgh", {
      ref: "refs/heads/main",
      workflow_ref: "acme/dualgh/.github/workflows/release.yml@refs/heads/main",
    });
    const init = await callGh("POST", "/api/v1/publish/init", branch, {
      eco: "composer",
      name: "acme/dualgh",
      version: "1.1.0",
      files: [{ name: "a.zip", size: 1, sha256: "a".repeat(64) }],
      manifest: { name: "acme/dualgh", description: "x", require: { php: "^8.1" } },
    });
    expect(init.status).toBe(401);
  });
});
