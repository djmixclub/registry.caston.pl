import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../../src/core/auth";
import { ORIGIN, call, credential, type ErrorBody } from "./helpers";

let admin: string;
let ci: string;
let reader: string;

beforeAll(async () => {
  admin = await credential("api-admin", "admin");
  ci = await credential("api-ci", "publish", [
    { eco: "composer", package: "acme/*", versions: "*" },
  ]);
  reader = await credential("api-reader", "read", [
    { eco: "composer", package: "acme/*", versions: "*" },
  ]);
});

async function expectError(res: Response, status: number, error: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("x-min-client-version")).toBe("0.1.0");
  expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect((await res.json<ErrorBody>()).error).toBe(error);
}

describe("client version negotiation", () => {
  it("answers 426 to an old client before authentication", async () => {
    const res = await call("GET", "/api/v1/whoami", { headers: { "x-client-version": "0.0.9" } });
    await expectError(res, 426, "client_too_old");
  });

  it("orders prereleases below the release", async () => {
    const res = await call("GET", "/api/v1/whoami", {
      headers: { "x-client-version": "0.1.0-beta.1" },
    });
    await expectError(res, 426, "client_too_old");
  });

  it.each(["v0.2.0", "0.2", "latest", "01.2.3"])("answers 400 to the malformed %s", async (v) => {
    const res = await call("GET", "/api/v1/whoami", { headers: { "x-client-version": v } });
    await expectError(res, 400, "invalid_request");
  });

  it("accepts current clients and exempts /api/v1/version", async () => {
    const current = await call("GET", "/api/v1/whoami", {
      token: reader,
      headers: { "x-client-version": "0.1.0" },
    });
    expect(current.status).toBe(200);
    const version = await call("GET", "/api/v1/version", {
      headers: { "x-client-version": "0.0.1" },
    });
    expect(version.status).toBe(200);
    expect(version.headers.get("x-min-client-version")).toBe("0.1.0");
    expect(await version.json()).toEqual({
      version: "0.1.0",
      minClientVersion: "0.1.0",
      schemaVersion: 3,
    });
  });
});

describe("routing and bodies", () => {
  it("answers 404 with the API headers for unknown paths and methods", async () => {
    await expectError(await call("GET", "/api/v1/nope", { token: admin }), 404, "not_found");
    await expectError(await call("PUT", "/api/v1/packages", { token: admin }), 404, "not_found");
    await expectError(await call("GET", "/api/v1", { token: admin }), 404, "not_found");
  });

  it("rejects bodies that are not JSON objects", async () => {
    const send = (body: string, type = "application/json") =>
      exports.default.fetch(
        new Request(`${ORIGIN}/api/v1/credentials`, {
          method: "POST",
          headers: { authorization: `Bearer ${admin}`, "content-type": type },
          body,
        }),
      );
    await expectError(await send("{"), 400, "invalid_request");
    await expectError(await send("[]"), 400, "invalid_request");
    await expectError(await send('{"project":"x"}', "text/plain"), 400, "invalid_request");
    await expectError(await send("x".repeat(4 * 1024 * 1024 + 1)), 413, "payload_too_large");
  });

  it("parses the body before authenticating", async () => {
    const res = await exports.default.fetch(
      new Request(`${ORIGIN}/api/v1/publish/init`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    await expectError(res, 400, "invalid_request");
  });

  it("treats an empty body as {}", async () => {
    const res = await call("POST", "/api/v1/publish/commit", { token: ci });
    await expectError(res, 400, "invalid_request");
  });
});

describe("authentication and kinds", () => {
  it("answers 401 with WWW-Authenticate for missing or invalid credentials", async () => {
    for (const token of [undefined, "api-reader:wrongwrongwrongwrongwrongwrong12", "garbage"]) {
      const res = await call("GET", "/api/v1/whoami", { token });
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="serverless-registry"');
      await expectError(res, 401, "unauthorized");
    }
  });

  it("returns the caller from whoami", async () => {
    const res = await call("GET", "/api/v1/whoami", { token: reader });
    expect(await res.json()).toEqual({
      project: "api-reader",
      kind: "read",
      grants: [{ eco: "composer", package: "acme/*", versions: "*", transitive: true }],
    });
    const adminView = await call("GET", "/api/v1/whoami", { token: admin });
    expect(await adminView.json()).toEqual({ project: "api-admin", kind: "admin", grants: [] });
  });

  it.each([
    ["read", "POST", "/api/v1/publish/init"],
    ["read", "POST", "/api/v1/publish/commit"],
    ["read", "GET", "/api/v1/credentials"],
    ["read", "POST", "/api/v1/packages/composer/acme%2Fsdk/1.0.0/yank"],
    ["publish", "GET", "/api/v1/packages"],
    ["publish", "GET", "/api/v1/packages/composer/acme%2Fsdk"],
    ["publish", "DELETE", "/api/v1/packages/composer/acme%2Fsdk"],
    ["admin", "POST", "/api/v1/publish/init"],
  ])("answers 403 to %s on %s %s", async (kind, method, path) => {
    const token = kind === "read" ? reader : kind === "publish" ? ci : admin;
    const body = method === "GET" ? undefined : {};
    await expectError(await call(method, path, { token, body }), 403, "forbidden");
  });

  it("answers 403 to publish credentials on native reads", async () => {
    expect((await call("GET", "/composer/packages.json", { token: ci })).status).toBe(403);
  });
});

describe("panel sessions", () => {
  it("authenticates with the session cookie", async () => {
    const id = await createSession(env, "api-admin");
    const cookie = `sreg_session=${id}`;
    const res = await call("GET", "/api/v1/whoami", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ project: "api-admin", kind: "admin" });
  });

  it("requires X-Requested-With for mutations with a cookie", async () => {
    const id = await createSession(env, "api-admin");
    const cookie = `sreg_session=${id}`;
    const body = { project: "panel-made", kind: "read" };
    await expectError(
      await call("POST", "/api/v1/credentials", { headers: { cookie }, body }),
      403,
      "forbidden",
    );
    const res = await call("POST", "/api/v1/credentials", {
      headers: { cookie, "x-requested-with": "fetch" },
      body,
    });
    expect(res.status).toBe(201);
  });

  it("prefers the Authorization header over the cookie", async () => {
    const id = await createSession(env, "api-admin");
    const res = await call("GET", "/api/v1/whoami", {
      token: "api-reader:wrongwrongwrongwrongwrongwrong12",
      headers: { cookie: `sreg_session=${id}` },
    });
    expect(res.status).toBe(401);
  });

  it("answers 401 for an unknown session", async () => {
    const res = await call("GET", "/api/v1/whoami", {
      headers: { cookie: `sreg_session=${"a".repeat(32)}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("other paths", () => {
  it("serves static assets and a JSON 404 otherwise", async () => {
    const robots = await call("GET", "/robots.txt");
    expect(robots.status).toBe(200);
    const missing = await call("POST", "/robots.txt");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-min-client-version")).toBeNull();
  });
});
