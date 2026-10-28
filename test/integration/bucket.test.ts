import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { INSTALLATION_ID_KEY } from "../../src/core/bucket";
import { SCHEMA_VERSION_KEY } from "../../src/core/migrate";
import { INSTALLATION_MARKER_KEY, PACKAGES_META_KEY } from "../../src/core/storage";
import { call, credential, ORIGIN, type ErrorBody } from "./helpers";

// KV and R2 keep what a test stores; every test starts without any of the keys it looks at.
beforeEach(async () => {
  await env.AUTH.delete(INSTALLATION_ID_KEY);
  await env.AUTH.delete(SCHEMA_VERSION_KEY);
  await env.R2_BUCKET.delete([INSTALLATION_MARKER_KEY, PACKAGES_META_KEY]);
});

/** An installation that used another bucket: KV knows an id the bucket does not carry. */
async function swapBucket(): Promise<void> {
  await env.AUTH.put(INSTALLATION_ID_KEY, "the-old-bucket");
}

async function failure(res: Response): Promise<ErrorBody & { reason?: string }> {
  return (await res.json()) as ErrorBody & { reason?: string };
}

describe("a bucket that is not the installation's own", () => {
  it("answers 503 bucket_mismatch where packages are read or written", async () => {
    const admin = await credential("root", "admin");
    const publisher = await credential("ci", "publish");
    await swapBucket();

    for (const [method, path, token] of [
      ["GET", "/api/v1/packages", admin],
      ["GET", "/api/v1/packages/composer/acme%2Fsdk", admin],
      ["DELETE", "/api/v1/packages/composer/acme%2Fsdk", admin],
      ["POST", "/api/v1/publish/init", publisher],
      ["POST", "/api/v1/publish/commit", publisher],
    ] as const) {
      const res = await call(method, path, { token, body: method === "GET" ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(503);
      const body = await failure(res);
      expect(body.error).toBe("bucket_mismatch");
      expect(body.reason).toBe("empty");
    }
  });

  it("answers the native protocols with 503 too", async () => {
    await swapBucket();
    const res = await exports.default.fetch(new Request(`${ORIGIN}/composer/packages.json`));
    expect(res.status).toBe(503);
    expect((await failure(res)).error).toBe("bucket_mismatch");
  });

  it("leaves the endpoints that do not use the bucket alone", async () => {
    const admin = await credential("root", "admin");
    await swapBucket();
    expect((await call("GET", "/api/v1/whoami", { token: admin })).status).toBe(200);
    expect((await call("GET", "/api/v1/credentials", { token: admin })).status).toBe(200);
    expect((await call("GET", "/api/v1/version")).status).toBe(200);
  });

  it("runs no migration in the wrong bucket", async () => {
    const admin = await credential("root", "admin");
    await env.AUTH.put(INSTALLATION_ID_KEY, "the-old-bucket");
    await env.AUTH.put(SCHEMA_VERSION_KEY, "0");
    await call("GET", "/api/v1/whoami", { token: admin });
    expect(await env.R2_BUCKET.head(PACKAGES_META_KEY)).toBeNull();
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBe("0");
  });

  it("shows a banner with the way out to an admin in the panel", async () => {
    const admin = await credential("root", "admin");
    const reader = await credential("dev", "read");
    await swapBucket();

    const login = async (token: string) => {
      const res = await exports.default.fetch(
        new Request(`${ORIGIN}/login`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: ORIGIN,
            "sec-fetch-site": "same-origin",
          },
          body: new URLSearchParams({ mode: "token", token }),
          redirect: "manual",
        }),
      );
      expect(res.status).toBe(303);
      return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    };
    const page = async (cookie: string, path: string) =>
      (
        await exports.default.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }))
      ).text();

    const adminPage = await page(await login(admin), "/admin/packages");
    expect(adminPage).toContain("The R2 bucket is not the one this registry used before.");
    expect(adminPage).toContain('action="/admin/bucket/accept"');

    const readerPage = await page(await login(reader), "/");
    expect(readerPage).toContain("The R2 bucket is not the one this registry used before.");
    expect(readerPage).not.toContain("/admin/bucket/accept");
  });

  it("is confirmed by an admin in the panel", async () => {
    const admin = await credential("root", "admin");
    await swapBucket();
    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
    };
    const session = await exports.default.fetch(
      new Request(`${ORIGIN}/login`, {
        method: "POST",
        headers,
        body: new URLSearchParams({ mode: "token", token: admin }),
        redirect: "manual",
      }),
    );
    const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const res = await exports.default.fetch(
      new Request(`${ORIGIN}/admin/bucket/accept`, {
        method: "POST",
        headers: { ...headers, cookie },
        body: new URLSearchParams({ confirm: "1" }),
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/packages");
    expect((await call("GET", "/api/v1/packages", { token: admin })).status).toBe(200);
    expect(await env.R2_BUCKET.head(INSTALLATION_MARKER_KEY)).not.toBeNull();
  });

  it("is confirmed by an admin through the API, and only by an admin", async () => {
    const admin = await credential("root", "admin");
    const reader = await credential("dev", "read");
    await swapBucket();

    expect((await call("POST", "/api/v1/bucket/accept", { token: reader })).status).toBe(403);
    expect((await call("GET", "/api/v1/packages", { token: admin })).status).toBe(503);

    const res = await call("POST", "/api/v1/bucket/accept", { token: admin });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    expect((await call("GET", "/api/v1/packages", { token: admin })).status).toBe(200);
  });
});
