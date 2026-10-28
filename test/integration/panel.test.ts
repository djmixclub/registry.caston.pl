import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleApi } from "../../src/api";
import { handlePanel } from "../../src/panel";
import { UPDATES_KEY } from "../../src/core/updates";
import { call, credential, ORIGIN, publishComposer } from "./helpers";

// The tests of this file run in order: the first ones see an empty registry.

function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return exports.default.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields),
      redirect: "manual",
    }),
  );
}

function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { headers, redirect: "manual" }));
}

/** `sreg_session=<id>` from a login response. */
function cookieOf(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function login(token: string): Promise<string> {
  const res = await post("/login", { mode: "token", token });
  expect(res.status).toBe(303);
  return cookieOf(res);
}

let adminToken = "";

describe("first run", () => {
  it("shows the create-admin form while no credential exists", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('<form method="post" action="/first-run">');
    expect(page).not.toContain('action="/login"');
  });

  it("rejects an invalid project name", async () => {
    const res = await post("/first-run", { project: "Not Valid" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('<p class="error" role="alert">');
  });

  it("creates the admin, shows the token once and never shows the form again", async () => {
    const res = await post("/first-run", { project: "root" });
    expect(res.status).toBe(200);
    const match = /<pre><code>(root:[A-Za-z0-9]{32})<\/code><\/pre>/.exec(await res.text());
    adminToken = match?.[1] ?? "";
    expect(adminToken).not.toBe("");
    expect((await call("GET", "/api/v1/whoami", { token: adminToken })).status).toBe(200);

    const home = await (await get("/")).text();
    expect(home).toContain('action="/login"');
    expect(home).not.toContain("/first-run");

    const again = await post("/first-run", { project: "other" });
    expect(again.status).toBe(403);
    expect(await env.AUTH.get("cred:other")).toBeNull();
  });
});

describe("login", () => {
  it("logs in with a token and sets a secure session cookie", async () => {
    const res = await post("/login", { mode: "token", token: adminToken });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^sreg_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; /);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=43200"]) {
      expect(cookie.split("; ")).toContain(attribute);
    }
    // The session lives in the signed cookie only: nothing is written to KV.
    expect((await env.AUTH.list({ prefix: "session:" })).keys).toEqual([]);
    const home = await get("/", cookieOf(res));
    expect(await home.text()).not.toContain('action="/login"');
  });

  it("refuses a session cookie whose payload or signature was changed", async () => {
    const cookie = await login(adminToken);
    const [payload = "", signature = ""] = (cookie.split("=")[1] ?? "").split(".");
    const forgedPayload = btoa(JSON.stringify({ project: "root", exp: 4102444800 }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    for (const value of [`${forgedPayload}.${signature}`, `${payload}.${"A".repeat(43)}`]) {
      const home = await get("/", `sreg_session=${value}`);
      expect(await home.text()).toContain('action="/login"');
    }
  });

  it("logs in with a login and password, or the whole token as the password", async () => {
    const [user, secret = ""] = adminToken.split(":");
    const split = await post("/login", { mode: "password", login: user ?? "", password: secret });
    expect(split.status).toBe(303);
    const pasted = await post("/login", {
      mode: "password",
      login: user ?? "",
      password: adminToken,
    });
    expect(pasted.status).toBe(303);
  });

  it("answers 401 with the login page and an error for wrong credentials", async () => {
    const attempts: Record<string, string>[] = [
      { mode: "token", token: "root:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { mode: "token", token: "" },
      { mode: "password", login: "root", password: "wrong" },
    ];
    for (const fields of attempts) {
      const res = await post("/login", fields);
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain('<p class="error" role="alert">');
    }
  });

  it("refuses cross-site form posts", async () => {
    const res = await post(
      "/login",
      { mode: "token", token: adminToken },
      { origin: "https://evil.test" },
    );
    expect(res.status).toBe(403);
    const same = await post("/login", { mode: "token", token: adminToken }, { origin: ORIGIN });
    expect(same.status).toBe(303);
  });
});

describe("HTML responses", () => {
  it("carry the CSP and the other security headers", async () => {
    for (const res of [await get("/"), await post("/login", {})]) {
      expect(res.headers.get("content-security-policy")).toMatch(/^default-src 'self'/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("answers HEAD without a body", async () => {
    const res = await exports.default.fetch(new Request(`${ORIGIN}/`, { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("serves the stylesheet, script and icon from public/", async () => {
    const types: Record<string, RegExp> = {
      "/app.css": /^text\/css/,
      "/app.js": /javascript/,
      "/favicon.svg": /^image\/svg\+xml/,
    };
    for (const [path, type] of Object.entries(types)) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(type);
      expect((await res.text()).length).toBeGreaterThan(0);
    }
  });
});

describe("views", () => {
  it("shows a consumer its granted packages, dependencies and snippets", async () => {
    const ci = await credential("panel-ci", "publish", [
      { eco: "composer", package: "acme/*", versions: "*" },
    ]);
    expect((await publishComposer(ci, "acme/http", "1.1.0")).status).toBe(201);
    const sdk = { require: { php: "^8.1", "acme/http": "^1.0" } };
    expect((await publishComposer(ci, "acme/sdk", "1.0.0", "a", sdk)).status).toBe(201);
    expect((await publishComposer(ci, "acme/sdk", "1.1.0", "b", sdk)).status).toBe(201);
    await call("POST", "/api/v1/packages/composer/acme%2Fsdk/1.0.0/yank", { token: adminToken });
    await call("POST", "/api/v1/packages/composer/acme%2Fsdk/1.1.0/yank", { token: adminToken });
    expect((await publishComposer(ci, "acme/sdk", "1.2.0", "c", sdk)).status).toBe(201);
    const reader = await credential("panel-shop", "read", [
      { eco: "composer", package: "acme/sdk", versions: "^1.1" },
    ]);

    const page = await (await get("/", await login(reader))).text();
    expect(page).toContain("Signed in as <strong>panel-shop</strong>");
    expect(page).toContain("<h3>acme/sdk</h3>");
    expect(page).toContain("<code>1.2.0</code>");
    expect(page).toContain('<code>1.1.0</code> <span class="badge warn">yanked</span>');
    expect(page).not.toContain("<code>1.0.0</code>");
    expect(page).not.toContain("<h3>acme/http</h3>");
    expect(page).toContain("<summary>Dependencies (1)</summary>");
    expect(page).toContain("<td>acme/http</td>");
    expect(page).toContain("https://&lt;token&gt;@registry.test/composer");
    expect(page).toContain("composer require acme/sdk");
    expect(page).toContain("replace <code>&lt;token&gt;</code> with your token");
    expect(page).not.toContain("data-api-url");
  });

  it("tells a publish credential that it can only publish", async () => {
    const ci = await credential("panel-ci2", "publish", []);
    const page = await (await get("/", await login(ci))).text();
    expect(page).toContain("This credential can only publish.");
  });

  it("shows the admin panel tabs", async () => {
    const cookie = await login(adminToken);
    const packages = await (await get("/", cookie)).text();
    expect(packages).toContain('aria-current="page">Packages</a>');
    expect(packages).toContain('data-api-url="/api/v1/packages/composer/acme%2Fsdk/reindex"');

    const credentials = await (await get("/?tab=credentials", cookie)).text();
    expect(credentials).toContain('<a href="#credential-panel-shop">panel-shop</a>');
    expect(credentials).toContain('data-api-url="/api/v1/credentials/panel-shop"');

    await env.AUTH.put(
      UPDATES_KEY,
      JSON.stringify({
        tag: "v99.0.0",
        url: "https://github.com/kduma-OSS/serverless-registry-worker/releases/tag/v99.0.0",
        checkedAt: new Date().toISOString(),
      }),
    );
    const settings = await (await get("/?tab=settings", cookie)).text();
    expect(settings).toContain("<th><code>ECOSYSTEMS</code></th>");
    expect(settings).toContain(">v99.0.0</a> is available.");
  });
});

describe("session API calls", () => {
  it("need X-Requested-With for mutations", async () => {
    await credential("panel-doomed", "read", []);
    const cookie = await login(adminToken);
    const bare = await call("DELETE", "/api/v1/credentials/panel-doomed", { headers: { cookie } });
    expect(bare.status).toBe(403);
    const withHeader = await call("DELETE", "/api/v1/credentials/panel-doomed", {
      headers: { cookie, "x-requested-with": "fetch" },
    });
    expect(withHeader.status).toBe(200);
    expect(await withHeader.json()).toEqual({ project: "panel-doomed", deleted: true });
  });
});

describe("logout", () => {
  it("clears the cookie", async () => {
    const cookie = await login(adminToken);
    const res = await post("/logout", {}, { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toMatch(/^sreg_session=; .*Max-Age=0/);
  });

  it("clears a stale cookie on the home page", async () => {
    const home = await get("/", `sreg_session=${"x".repeat(20)}.${"A".repeat(43)}`);
    expect(await home.text()).toContain('action="/login"');
    expect(home.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});

describe("without SESSION_SECRET", () => {
  const unsigned = { ...env, SESSION_SECRET: undefined };

  it("answers the panel login with 500 naming the setting", async () => {
    const token = await credential("no-secret-admin", "admin");
    const request = new Request(`${ORIGIN}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ mode: "token", token }),
    });
    const res = await handlePanel(request, unsigned, new URL(request.url));
    expect(res?.status).toBe(500);
    const page = (await res?.text()) ?? "";
    expect(page).toContain("SESSION_SECRET");
    expect(page).not.toContain(token);
  });

  it("keeps API tokens working", async () => {
    const token = await credential("no-secret-reader", "read");
    const request = new Request(`${ORIGIN}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await handleApi(request, unsigned, new URL(request.url));
    expect(res.status).toBe(200);
  });
});
