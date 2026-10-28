import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { manifestKey, stagingKey } from "../../src/core/storage";
import { ORIGIN, credential, sha256Hex, type ErrorBody, type InitResult } from "./helpers";
import { callWithPublicUrl, githubJwt, installGithubKey } from "./oidc";

// The reserved login `_:gh.<jwt>` (docs/api.md 2.5). The tests of this file run in order.

let admin = "";
let jwt = "";

function call(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  return callWithPublicUrl(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    }),
  );
}

function postLogin(token: string): Promise<Response> {
  return callWithPublicUrl(
    new Request(`${ORIGIN}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ mode: "token", token }),
      redirect: "manual",
    }),
  );
}

async function createGhCredential(
  project: string,
  kind: "read" | "publish",
  secret: Record<string, unknown>,
): Promise<void> {
  const res = await call("POST", "/api/v1/credentials", admin, {
    project,
    kind,
    grants: [{ eco: "composer", package: "acme/*", versions: "*" }],
    secret: { type: "gh", ...secret },
  });
  expect(res.status).toBe(201);
}

async function publish(token: string, version: string): Promise<Response> {
  const bytes = new TextEncoder().encode(`acme/sdk@${version}`);
  const sha = await sha256Hex(bytes);
  const file = `acme-sdk-${version}.zip`;
  const init = await call("POST", "/api/v1/publish/init", token, {
    eco: "composer",
    name: "acme/sdk",
    version,
    files: [{ name: file, size: bytes.length, sha256: sha }],
    manifest: { name: "acme/sdk", description: "The SDK", require: { php: "^8.1" } },
  });
  if (init.status !== 200) return init;
  const { uploadId } = await init.json<InitResult>();
  await env.R2_BUCKET.put(stagingKey(uploadId, file), bytes, { sha256: sha });
  return call("POST", "/api/v1/publish/commit", token, { uploadId });
}

beforeAll(async () => {
  await installGithubKey();
  admin = await credential("gh-admin", "admin");
  await createGhCredential("gh-reader", "read", { repository: "acme/sdk" });
  await createGhCredential("gh-publisher", "publish", {
    repository: "Acme/SDK",
    ref: "refs/tags/v*",
    workflow: ".github/workflows/release.yml",
  });
  jwt = await githubJwt("acme/sdk");
});

describe("the _ login", () => {
  it("indexes the gh entries by repository", async () => {
    expect(await env.AUTH.get("gh-repo:acme/sdk", "json")).toEqual(["gh-publisher", "gh-reader"]);
  });

  it("resolves the read credential outside the publishing endpoints", async () => {
    const res = await call("GET", "/api/v1/whoami", `_:gh.${jwt}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ project: "gh-reader", kind: "read" });
  });

  it("publishes through init and commit as the publish credential", async () => {
    const res = await publish(`_:gh.${jwt}`, "1.0.0");
    expect(res.status).toBe(201);
    const stored = await env.R2_BUCKET.get(manifestKey("composer", "acme/sdk", "1.0.0"));
    expect(await stored?.json()).toMatchObject({ publishedBy: "gh-publisher" });
  });

  it("does not publish from a ref the publish entry does not allow", async () => {
    const branch = await githubJwt("acme/sdk", {
      ref: "refs/heads/main",
      workflow_ref: "acme/sdk/.github/workflows/release.yml@refs/heads/main",
    });
    const res = await publish(`_:gh.${branch}`, "1.1.0");
    expect(res.status).toBe(401);
  });

  it("reads the composer index as the read credential", async () => {
    const res = await call("GET", "/composer/p2/acme/sdk.json", `_:gh.${jwt}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ packages: Record<string, { version: string }[]> }>();
    expect(body.packages["acme/sdk"]?.[0]?.version).toBe("1.0.0");
  });

  it("logs in to the panel as the read credential", async () => {
    const res = await postLogin(`_:gh.${jwt}`);
    expect(res.status).toBe(303);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const home = await callWithPublicUrl(
      new Request(`${ORIGIN}/`, { headers: { cookie }, redirect: "manual" }),
    );
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("gh-reader");
  });

  it("refuses to guess when another read credential matches", async () => {
    await createGhCredential("gh-reader-two", "read", { repository: "acme/*" });
    expect(await env.AUTH.get("gh-repo:acme/*", "json")).toEqual(["gh-reader-two"]);

    const res = await call("GET", "/composer/p2/acme/sdk.json", `_:gh.${jwt}`);
    expect(res.status).toBe(401);
    expect(await res.json<ErrorBody>()).toEqual({
      error: "unauthorized",
      message: "more than one project matches this token; use <project>:gh.<jwt>",
    });
    const whoami = await call("GET", "/api/v1/whoami", `_:gh.${jwt}`);
    expect(whoami.status).toBe(401);
    const login = await postLogin(`_:gh.${jwt}`);
    expect(login.status).toBe(401);
    expect(await login.text()).toContain("more than one project matches this token");

    // Naming the project still works, and so does publishing.
    const named = await call("GET", "/api/v1/whoami", `gh-reader-two:gh.${jwt}`);
    expect(await named.json()).toMatchObject({ project: "gh-reader-two" });
    expect((await publish(`_:gh.${jwt}`, "1.2.0")).status).toBe(201);
  });

  it("drops a deleted credential from the index", async () => {
    const res = await call("DELETE", "/api/v1/credentials/gh-reader-two", admin);
    expect(res.status).toBe(200);
    expect(await env.AUTH.get("gh-repo:acme/*")).toBeNull();
    const whoami = await call("GET", "/api/v1/whoami", `_:gh.${jwt}`);
    expect(await whoami.json()).toMatchObject({ project: "gh-reader" });
  });

  it("never resolves an admin credential", async () => {
    await call("POST", "/api/v1/credentials/gh-admin/secrets", admin, {
      type: "gh",
      repository: "acme/tools",
    });
    const tools = await githubJwt("acme/tools");
    expect((await call("GET", "/api/v1/whoami", `_:gh.${tools}`)).status).toBe(401);
    expect((await call("GET", "/api/v1/whoami", `gh-admin:gh.${tools}`)).status).toBe(200);
  });

  it("rejects _ with a key secret", async () => {
    const res = await call("GET", "/api/v1/whoami", "_:k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e");
    expect(res.status).toBe(401);
  });
});
