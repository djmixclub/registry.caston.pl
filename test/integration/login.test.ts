import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createCredential, expireSecret } from "../../src/core/admin";
import { totpCode, totpStep } from "../../src/core/totp";
import { ORIGIN, call, publishComposer, type ErrorBody } from "./helpers";

const PASSWORD = "correct-horse-battery";
const GRANTS = [{ eco: "composer", package: "acme/*", versions: "*" }];

let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}`;

interface Account {
  project: string;
  totpSecret?: string;
}

async function account(kind: "read" | "publish", totp = false): Promise<Account> {
  const project = unique(kind === "read" ? "reader" : "writer");
  const created = await createCredential(
    env,
    { project, kind, grants: GRANTS, secret: { type: "login", password: PASSWORD, totp } },
    new Date(),
  );
  return { project, totpSecret: created.login?.totp?.secret };
}

async function currentCode(secret: string | undefined, offset = 0): Promise<string> {
  return (await totpCode(secret ?? "", totpStep(Date.now()) + offset)) ?? "";
}

interface Created {
  session: string;
  url: string;
  poll_token: string;
}

async function createSession(body: unknown): Promise<Created> {
  const res = await call("POST", "/api/v1/auth/sessions", { body });
  expect(res.status).toBe(201);
  return res.json<Created>();
}

function poll(created: Created): Promise<Response> {
  return call("POST", "/api/v1/auth/sessions/poll", {
    body: { session: created.session, poll_token: created.poll_token },
  });
}

/** A browser request to the authorize page (`cookie` is the signed-in session, if any). */
function page(
  created: Created,
  action: string,
  options: { form?: Record<string, string>; cookie?: string } = {},
): Promise<Response> {
  const path = new URL(created.url).pathname + (action === "" ? "" : `/${action}`);
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  let body: string | undefined;
  if (options.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers.origin = ORIGIN;
    body = new URLSearchParams(options.form).toString();
  }
  return exports.default.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: options.form === undefined ? "GET" : "POST",
      headers,
      body,
      redirect: "manual",
    }),
  );
}

/** The `name=value` of the cookie `name` set by a response, or an empty string. */
function cookieOf(res: Response, name: string): string {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "";
  return line.split(";")[0] ?? "";
}

/**
 * Signs in on the authorize page and returns the session cookie: the password, and for a login
 * with a one-time code a second step with `code` (the pending cookie of the first step).
 */
async function signIn(created: Created, who: Account, code = ""): Promise<string> {
  const first = await page(created, "login", {
    form: { project: who.project, password: PASSWORD },
  });
  expect(first.status).toBe(303);
  const session = cookieOf(first, "sreg_session");
  if (session !== "") return session;
  const pending = cookieOf(first, "sreg_pending");
  expect(pending).toMatch(/^sreg_pending=/);
  const second = await page(created, "code", { cookie: pending, form: { code } });
  expect(second.status).toBe(303);
  const done = cookieOf(second, "sreg_session");
  expect(done).toMatch(/^sreg_session=/);
  return done;
}

interface Issued {
  status: string;
  token: string;
  expires_at: string;
  project: string;
  kind: string;
}

describe("browser login for downloads", () => {
  it("signs in, approves and hands the token to the poll", async () => {
    const who = await account("read", true);
    const created = await createSession({ purpose: "pull" });
    expect(created.url).toBe(`${ORIGIN}/authorize/${created.session}`);
    expect((await poll(created)).status).toBe(202);

    const open = await page(created, "");
    expect(open.status).toBe(200);
    const html = await open.text();
    expect(html).toContain("download");
    expect(html).toContain('name="password"');

    const cookie = await signIn(created, who, await currentCode(who.totpSecret));
    const approve = await page(created, "", { cookie });
    expect(approve.status).toBe(200);
    const form = await approve.text();
    expect(form).toContain(`Signed in as <strong>${who.project}</strong>`);
    expect(form).toContain('name="extended"');
    // The pull token does not need a fresh one-time code.
    expect(form).not.toContain("Verify");

    expect((await page(created, "approve", { cookie, form: {} })).status).toBe(200);
    const res = await poll(created);
    expect(res.status).toBe(200);
    const issued = await res.json<Issued>();
    expect(issued).toMatchObject({ status: "approved", project: who.project, kind: "read" });
    expect(Date.parse(issued.expires_at) - Date.now()).toBeLessThanOrEqual(3_600_000);
    expect(Date.parse(issued.expires_at) - Date.now()).toBeGreaterThan(3_500_000);

    const whoami = await call("GET", "/api/v1/whoami", { token: issued.token });
    expect(await whoami.json()).toMatchObject({ project: who.project, kind: "read" });
    expect((await call("GET", "/api/v1/packages", { token: issued.token })).status).toBe(200);
    // Not a publish token and not an admin token.
    expect(
      (await call("POST", "/api/v1/publish/init", { token: issued.token, body: {} })).status,
    ).toBe(403);
    expect((await call("GET", "/api/v1/credentials", { token: issued.token })).status).toBe(403);
  });

  it("offers the extended validity and uses it when ticked", async () => {
    const who = await account("read");
    const created = await createSession({ purpose: "pull" });
    const cookie = await signIn(created, who);
    await page(created, "approve", { cookie, form: { extended: "1" } });
    const issued = await (await poll(created)).json<Issued>();
    const hours = (Date.parse(issued.expires_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it("does not offer extended validity to a one-off generic download", async () => {
    const who = await account("read");
    const created = await createSession({ purpose: "pull", eco: "generic" });
    const cookie = await signIn(created, who);
    expect(await (await page(created, "", { cookie })).text()).not.toContain('name="extended"');
    await page(created, "approve", { cookie, form: { extended: "1" } });
    const issued = await (await poll(created)).json<Issued>();
    expect(Date.parse(issued.expires_at) - Date.now()).toBeLessThanOrEqual(3_600_000);
  });

  it("reuses a signed-in browser for the next request", async () => {
    const who = await account("read");
    const first = await createSession({ purpose: "pull" });
    const cookie = await signIn(first, who);
    const second = await createSession({ purpose: "pull" });
    const html = await (await page(second, "", { cookie })).text();
    expect(html).toContain(`Signed in as <strong>${who.project}</strong>`);
    expect(html).not.toContain('name="password"');
  });

  it("reports a refusal to the poll", async () => {
    const who = await account("read");
    const created = await createSession({ purpose: "pull" });
    const cookie = await signIn(created, who);
    expect((await page(created, "deny", { cookie, form: {} })).status).toBe(200);
    const res = await poll(created);
    expect(res.status).toBe(403);
    expect((await res.json<ErrorBody>()).error).toBe("forbidden");
  });

  it("refuses a credential that cannot download", async () => {
    const who = await account("publish");
    const created = await createSession({ purpose: "pull" });
    const cookie = await signIn(created, who);
    const html = await (await page(created, "", { cookie })).text();
    expect(html).toContain("cannot download");
    expect(html).not.toContain("/approve");
    expect((await page(created, "approve", { cookie, form: {} })).status).toBe(403);
    expect((await poll(created)).status).toBe(202);
  });

  it("stops working when the login secret is expired", async () => {
    const who = await account("read");
    const created = await createSession({ purpose: "pull" });
    const cookie = await signIn(created, who);
    await page(created, "approve", { cookie, form: {} });
    const issued = await (await poll(created)).json<Issued>();
    expect((await call("GET", "/api/v1/whoami", { token: issued.token })).status).toBe(200);

    const credential = await (
      await call("GET", `/api/v1/credentials/${who.project}`, {
        token: await adminToken(),
      })
    ).json<{ auth: { id: string }[] }>();
    await expireSecret(env, who.project, credential.auth[0]?.id ?? "", {}, new Date());
    expect((await call("GET", "/api/v1/whoami", { token: issued.token })).status).toBe(401);
    // The browser session ended with the secret too.
    expect(await (await page(created, "", { cookie })).text()).toContain('name="password"');
  });
});

async function adminToken(): Promise<string> {
  const { credential } = await import("./helpers");
  return credential(unique("login-admin"), "admin");
}

describe("signing in on the page", () => {
  it("shows the same message for a wrong password and an unknown login", async () => {
    const who = await account("read");
    const created = await createSession({ purpose: "pull" });
    const wrong = await page(created, "login", {
      form: { project: who.project, password: "wrong-password-here", code: "" },
    });
    const unknown = await page(created, "login", {
      form: { project: "no-such-login", password: "wrong-password-here", code: "" },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const a = await wrong.text();
    const b = await unknown.text();
    expect(a).toContain("The login or the password is not valid.");
    expect(b).toContain("The login or the password is not valid.");
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  it("asks for the one-time code in a second step, and never takes the same one twice", async () => {
    const who = await account("read", true);
    const created = await createSession({ purpose: "pull" });
    // Step 1: only the password. A wrong one never gets as far as asking for a code.
    const wrong = await page(created, "login", {
      form: { project: who.project, password: "wrong-password-here" },
    });
    expect(wrong.status).toBe(401);
    expect(cookieOf(wrong, "sreg_pending")).toBe("");

    const first = await page(created, "login", {
      form: { project: who.project, password: PASSWORD },
    });
    expect(first.status).toBe(303);
    expect(cookieOf(first, "sreg_session")).toBe("");
    const pending = cookieOf(first, "sreg_pending");
    expect(first.headers.get("set-cookie")).toContain("Path=/authorize/");

    // The page now asks for the code and carries no password.
    const ask = await (await page(created, "", { cookie: pending })).text();
    expect(ask).toContain("<h1>One-time code</h1>");
    expect(ask).toContain(`<strong>${who.project}</strong>`);
    expect(ask).not.toContain('type="password"');

    // Step 2: a wrong code keeps the pending sign-in, a right one ends it.
    const bad = await page(created, "code", { cookie: pending, form: { code: "000000" } });
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain("The one-time code is not valid.");
    const code = await currentCode(who.totpSecret);
    const good = await page(created, "code", { cookie: pending, form: { code } });
    expect(good.status).toBe(303);
    expect(cookieOf(good, "sreg_session")).toMatch(/^sreg_session=/);

    // The same code is refused, even with a fresh pending sign-in.
    const again = await page(created, "login", {
      form: { project: who.project, password: PASSWORD },
    });
    const replay = await page(created, "code", {
      cookie: cookieOf(again, "sreg_pending"),
      form: { code },
    });
    expect(replay.status).toBe(401);
  });

  it("does not take a code without a pending password, or for another login request", async () => {
    const who = await account("read", true);
    const created = await createSession({ purpose: "pull" });
    const other = await createSession({ purpose: "pull" });
    const code = await currentCode(who.totpSecret);
    const none = await page(created, "code", { form: { code } });
    expect(none.status).toBe(303);
    expect(cookieOf(none, "sreg_session")).toBe("");

    const first = await page(created, "login", {
      form: { project: who.project, password: PASSWORD },
    });
    const pending = cookieOf(first, "sreg_pending");
    const wrongRequest = await page(other, "code", { cookie: pending, form: { code } });
    expect(wrongRequest.status).toBe(303);
    expect(cookieOf(wrongRequest, "sreg_session")).toBe("");
    // The pending cookie is not a session for the panel or the API either.
    const api = await call("GET", "/api/v1/whoami", { headers: { cookie: pending } });
    expect(api.status).toBe(401);
    const switched = await page(created, "switch", { cookie: pending, form: {} });
    expect(switched.headers.getSetCookie().join("\n")).toContain("sreg_pending=; ");
  });

  it("refuses cross-site posts and unknown or tampered sessions", async () => {
    const who = await account("read");
    const created = await createSession({ purpose: "pull" });
    const cross = await exports.default.fetch(
      new Request(`${ORIGIN}/authorize/${created.session}/login`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.test",
        },
        body: new URLSearchParams({ project: who.project, password: PASSWORD }).toString(),
      }),
    );
    expect(cross.status).toBe(403);

    const tampered = { ...created, url: `${created.url.slice(0, -2)}AA` };
    expect((await page(tampered, "")).status).toBe(410);
    expect((await page(tampered, "login", { form: { project: who.project } })).status).toBe(410);
  });

  it("does not let an admin password session approve", async () => {
    const created = await createSession({ purpose: "pull" });
    const adminSession = await createAdminCookie();
    const html = await (await page(created, "", { cookie: adminSession })).text();
    expect(html).toContain('name="password"');
    expect((await page(created, "approve", { cookie: adminSession, form: {} })).status).toBe(303);
    expect((await poll(created)).status).toBe(202);
  });
});

async function createAdminCookie(): Promise<string> {
  const { createSession: sign } = await import("../../src/core/auth");
  const project = unique("session-admin");
  await createCredential(env, { project, kind: "admin" }, new Date());
  return `sreg_session=${await sign(env, project)}`;
}

describe("browser login for publishing", () => {
  const scope = { eco: "composer", package: "acme/lib", version: "1.0.0" };

  it("approves exactly the listed version", async () => {
    const who = await account("publish");
    const created = await createSession({ purpose: "publish", scopes: [scope] });
    const html = await (await page(created, "")).text();
    expect(html).toContain("acme/lib");
    expect(html).toContain("1.0.0");

    const cookie = await signIn(created, who);
    const approve = await (await page(created, "", { cookie })).text();
    expect(approve).toContain("acme/lib");
    expect(approve).not.toContain("not allowed");
    expect(approve).not.toContain('name="extended"');
    await page(created, "approve", { cookie, form: { extended: "1" } });

    const issued = await (await poll(created)).json<Issued>();
    expect(issued).toMatchObject({ project: who.project, kind: "publish" });
    expect(Date.parse(issued.expires_at) - Date.now()).toBeLessThanOrEqual(900_000);

    const whoami = await call("GET", "/api/v1/whoami", { token: issued.token });
    expect(await whoami.json()).toMatchObject({ project: who.project, scopes: [scope] });

    expect((await publishComposer(issued.token, "acme/lib", "1.0.0")).status).toBe(201);
    const other = await publishComposer(issued.token, "acme/lib", "1.0.1");
    expect(other.status).toBe(403);
    expect((await other.json<ErrorBody>()).message).toContain("not approved");
    const elsewhere = await publishComposer(issued.token, "acme/other", "1.0.0");
    expect(elsewhere.status).toBe(403);
  });

  it("approves several versions with one token", async () => {
    const who = await account("publish");
    const scopes = [scope, { ...scope, version: "1.0.1" }, { ...scope, package: "acme/two" }];
    const created = await createSession({ purpose: "publish", scopes });
    const cookie = await signIn(created, who);
    await page(created, "approve", { cookie, form: {} });
    const issued = await (await poll(created)).json<Issued>();
    expect((await publishComposer(issued.token, "acme/two", "1.0.0")).status).toBe(201);
    expect((await publishComposer(issued.token, "acme/lib", "1.0.1")).status).toBe(201);
    expect((await publishComposer(issued.token, "acme/lib", "9.9.9")).status).toBe(403);
  });

  it("offers no approval when the grants do not allow every version", async () => {
    const who = await account("publish");
    const created = await createSession({
      purpose: "publish",
      scopes: [scope, { eco: "composer", package: "other/lib", version: "1.0.0" }],
    });
    const cookie = await signIn(created, who);
    const html = await (await page(created, "", { cookie })).text();
    expect(html).toContain("not allowed");
    expect(html).toContain("grants do not allow");
    expect(html).not.toContain("/approve");
    expect((await page(created, "approve", { cookie, form: {} })).status).toBe(403);
    expect((await poll(created)).status).toBe(202);
  });

  it("refuses a read credential", async () => {
    const who = await account("read");
    const created = await createSession({ purpose: "publish", scopes: [scope] });
    const cookie = await signIn(created, who);
    expect(await (await page(created, "", { cookie })).text()).toContain("cannot publish");
    expect((await page(created, "approve", { cookie, form: {} })).status).toBe(403);
  });

  it("takes a code from the sign-in and approves without asking again", async () => {
    const who = await account("publish", true);
    const created = await createSession({ purpose: "publish", scopes: [scope] });
    const cookie = await signIn(created, who, await currentCode(who.totpSecret));
    const html = await (await page(created, "", { cookie })).text();
    expect(html).not.toContain("Verify");
    expect((await page(created, "approve", { cookie, form: {} })).status).toBe(200);
    expect((await poll(created)).status).toBe(200);
  });

  it("asks for a new code when the browser session has none", async () => {
    // A session started without a verified code: the entry has TOTP, the cookie has no `totp_at`.
    const who = await account("publish", true);
    const created = await createSession({ purpose: "publish", scopes: [scope] });
    const first = await signIn(created, who, await currentCode(who.totpSecret));
    const stale = await staleCookie(first);
    const html = await (await page(created, "", { cookie: stale })).text();
    expect(html).toContain("new one-time code");
    expect((await page(created, "approve", { cookie: stale, form: {} })).status).toBe(403);
    expect((await poll(created)).status).toBe(202);

    const wrong = await page(created, "totp", { cookie: stale, form: { code: "000000" } });
    expect(wrong.status).toBe(401);
    const next = await currentCode(who.totpSecret, 1);
    const verified = await page(created, "totp", { cookie: stale, form: { code: next } });
    expect(verified.status).toBe(303);
    const fresh = (verified.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await page(created, "approve", { cookie: fresh, form: {} })).status).toBe(200);
    expect((await poll(created)).status).toBe(200);
  });
});

/** The same login session as `cookie` but without a verified one-time code. */
async function staleCookie(cookie: string): Promise<string> {
  const { readSession, createSession: sign } = await import("../../src/core/auth");
  const value = cookie.slice("sreg_session=".length);
  const session = await readSession(
    new Request(ORIGIN, { headers: { cookie: `sreg_session=${value}` } }),
    env,
  );
  if (session === null || session.entry === undefined) throw new Error("no login session");
  return `sreg_session=${await sign(env, session.project, {}, { entry: session.entry })}`;
}

async function adminAccount(totp = false): Promise<Account> {
  const project = unique("operator");
  const created = await createCredential(
    env,
    { project, kind: "admin", secret: { type: "login", password: PASSWORD, totp } },
    new Date(),
  );
  return { project, totpSecret: created.login?.totp?.secret };
}

async function publisherToken(): Promise<string> {
  const { credential } = await import("./helpers");
  return credential(unique("ci"), "publish", [
    { eco: "composer", package: "acme/*", versions: "*" },
  ]);
}

async function packageVersions(token: string, name: string): Promise<Record<string, boolean>> {
  const res = await call("GET", `/api/v1/packages/composer/${encodeURIComponent(name)}`, { token });
  if (res.status !== 200) return {};
  const body = await res.json<{ versions: { version: string; yanked: boolean }[] }>();
  return Object.fromEntries(body.versions.map((v) => [v.version, v.yanked]));
}

/** An admin token approved for `purpose` on `scopes`, issued through the whole flow. */
async function issueAdminToken(
  purpose: "yank" | "delete",
  scopes: unknown[],
  who?: Account,
): Promise<Issued> {
  const operator = who ?? (await adminAccount());
  const created = await createSession({ purpose, scopes });
  const cookie = await signIn(created, operator);
  expect((await page(created, "approve", { cookie, form: {} })).status).toBe(200);
  return (await poll(created)).json<Issued>();
}

describe("browser login for yank and delete", () => {
  const target = (name: string, version?: string) => ({
    eco: "composer",
    package: name,
    ...(version === undefined ? {} : { version }),
  });

  it("validates the scopes of the session", async () => {
    const bad = async (body: unknown) => {
      const res = await call("POST", "/api/v1/auth/sessions", { body });
      expect(res.status).toBe(400);
      return (await res.json<ErrorBody>()).message;
    };
    // A yank names an exact version in every scope; a delete may name a whole package.
    await bad({ purpose: "yank" });
    await bad({ purpose: "yank", scopes: [] });
    await bad({ purpose: "yank", scopes: [target("acme/lib")] });
    await bad({ purpose: "yank", scopes: [{ ...target("acme/lib"), version: null }] });
    await bad({ purpose: "delete", scopes: [{ ...target("acme/lib"), version: 3 }] });
    await bad({ purpose: "delete", scopes: [{ eco: "rpm", package: "a", version: "1" }] });
    await bad({ purpose: "delete", scopes: [target("acme/lib", "not a version")] });
    await bad({ purpose: "yank", scopes: [target("acme/lib", "1.0.0")], eco: "composer" });
    expect(await bad({ purpose: "nope" })).toContain("`yank` or `delete`");
    const tooMany = Array.from({ length: 101 }, (_, i) => target("acme/lib", `1.0.${i}`));
    await bad({ purpose: "yank", scopes: tooMany });

    expect(
      (
        await call("POST", "/api/v1/auth/sessions", {
          body: {
            purpose: "delete",
            scopes: [target("acme/lib"), { ...target("acme/lib"), version: null }],
          },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call("POST", "/api/v1/auth/sessions", {
          body: { purpose: "delete", scopes: [target("acme/lib"), target("acme/lib", "1.0.0")] },
        })
      ).status,
    ).toBe(201);
  });

  it("shows the operation, approves it for an admin and issues an admin token", async () => {
    const who = await adminAccount(true);
    const created = await createSession({ purpose: "yank", scopes: [target("acme/lib", "1.0.0")] });
    const html = await (await page(created, "")).text();
    expect(html).toContain("<strong>yank</strong>");
    expect(html).toContain("acme/lib");
    expect(html).toContain("1.0.0");

    const cookie = await signIn(created, who, await currentCode(who.totpSecret));
    const approve = await (await page(created, "", { cookie })).text();
    expect(approve).toContain("acme/lib");
    expect(approve).toContain("/approve");
    expect((await poll(created)).status).toBe(202);
    expect((await page(created, "approve", { cookie, form: {} })).status).toBe(200);

    const res = await poll(created);
    expect(res.status).toBe(200);
    const issued = await res.json<Issued>();
    expect(issued).toMatchObject({ status: "approved", project: who.project, kind: "admin" });
    expect(issued.token).toContain(`${who.project}:st.`);
    expect(Date.parse(issued.expires_at) - Date.now()).toBeLessThanOrEqual(900_000);
    expect(Date.parse(issued.expires_at) - Date.now()).toBeGreaterThan(800_000);

    const whoami = await call("GET", "/api/v1/whoami", { token: issued.token });
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toMatchObject({
      project: who.project,
      kind: "admin",
      roles: ["admin"],
      access: {},
      ops: [{ op: "yank", eco: "composer", package: "acme/lib", version: "1.0.0" }],
    });
  });

  it("shows a delete with a warning and the whole-package wording", async () => {
    const created = await createSession({
      purpose: "delete",
      scopes: [target("acme/lib", "1.0.0"), target("acme/old")],
    });
    const html = await (await page(created, "")).text();
    expect(html).toContain("permanently delete");
    expect(html).toContain("cannot be undone");
    expect(html).toContain("the whole package, every version");
  });

  it("yanks exactly the approved version and nothing else", async () => {
    const token = await publisherToken();
    for (const v of ["1.0.0", "1.0.1"]) {
      expect((await publishComposer(token, "acme/yank-me", v)).status).toBe(201);
    }
    const issued = await issueAdminToken("yank", [target("acme/yank-me", "1.0.0")]);
    const url = (v: string, name = "acme%2Fyank-me") =>
      `/api/v1/packages/composer/${name}/${v}/yank`;

    const other = await call("POST", url("1.0.1"), { token: issued.token });
    expect(other.status).toBe(403);
    expect((await other.json<ErrorBody>()).message).toContain("not approved");
    expect((await call("POST", url("1.0.0", "acme%2Fother"), { token: issued.token })).status).toBe(
      403,
    );
    // The yank approval does not cover deleting.
    expect(
      (
        await call("DELETE", "/api/v1/packages/composer/acme%2Fyank-me/1.0.0", {
          token: issued.token,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("DELETE", "/api/v1/packages/composer/acme%2Fyank-me", { token: issued.token }))
        .status,
    ).toBe(403);

    const yanked = await call("POST", url("1.0.0"), { token: issued.token });
    expect(yanked.status).toBe(200);
    expect(await yanked.json()).toMatchObject({
      name: "acme/yank-me",
      version: "1.0.0",
      yanked: true,
    });
    expect(await packageVersions(await adminToken(), "acme/yank-me")).toEqual({
      "1.0.0": true,
      "1.0.1": false,
    });
  });

  it("rejects the admin token on every other route", async () => {
    const issued = await issueAdminToken("delete", [
      target("acme/some"),
      target("acme/some", "1.0.0"),
    ]);
    const t = issued.token;
    const denied: [string, string, unknown?][] = [
      ["GET", "/api/v1/packages"],
      ["GET", "/api/v1/packages/composer/acme%2Fsome"],
      ["POST", "/api/v1/packages/composer/acme%2Fsome/reindex"],
      ["GET", "/api/v1/credentials"],
      ["POST", "/api/v1/credentials", { project: "x", kind: "read" }],
      ["GET", "/api/v1/credentials/anyone"],
      ["PATCH", "/api/v1/credentials/anyone", { grants: [] }],
      ["DELETE", "/api/v1/credentials/anyone"],
      ["POST", "/api/v1/credentials/anyone/secrets", { type: "key" }],
      ["PATCH", "/api/v1/credentials/anyone/secrets/abcdef123456", { description: "x" }],
      ["DELETE", "/api/v1/credentials/anyone/secrets/abcdef123456"],
      ["GET", "/api/v1/github/repository?name=acme/sdk"],
      ["POST", "/api/v1/bucket/accept"],
      ["POST", "/api/v1/publish/init", {}],
      ["POST", "/api/v1/publish/commit", {}],
    ];
    for (const [method, path, body] of denied) {
      const res = await call(method, path, { token: t, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json<ErrorBody>()).error).toBe("forbidden");
    }
    // Nor does it read packages through a native protocol, or open the panel.
    expect((await call("GET", "/composer/p2/acme/some.json", { token: t })).status).toBe(403);
    const panel = await exports.default.fetch(
      new Request(`${ORIGIN}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        body: new URLSearchParams({ mode: "token", token: t }),
        redirect: "manual",
      }),
    );
    expect(panel.status).toBe(401);
    expect(cookieOf(panel, "sreg_session")).toBe("");
  });

  it("deletes a version only for a version approval, and a package only for a package approval", async () => {
    const token = await publisherToken();
    for (const v of ["1.0.0", "1.1.0"]) {
      expect((await publishComposer(token, "acme/del-me", v)).status).toBe(201);
    }
    const version = await issueAdminToken("delete", [target("acme/del-me", "1.0.0")]);
    const whole = await issueAdminToken("delete", [target("acme/del-me")]);
    const versionUrl = (v: string) => `/api/v1/packages/composer/acme%2Fdel-me/${v}`;
    const packageUrl = "/api/v1/packages/composer/acme%2Fdel-me";

    // A whole-package approval does not delete one version, and the other way round.
    expect((await call("DELETE", versionUrl("1.0.0"), { token: whole.token })).status).toBe(403);
    expect((await call("DELETE", packageUrl, { token: version.token })).status).toBe(403);
    expect((await call("DELETE", versionUrl("1.1.0"), { token: version.token })).status).toBe(403);
    expect(
      (await call("POST", `${versionUrl("1.0.0")}/yank`, { token: version.token })).status,
    ).toBe(403);

    const deleted = await call("DELETE", versionUrl("1.0.0"), { token: version.token });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ version: "1.0.0", deleted: true });
    const gone = await call("DELETE", packageUrl, { token: whole.token });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toMatchObject({ name: "acme/del-me", deletedVersions: ["1.1.0"] });
  });

  it("offers no approval to a credential without the admin role", async () => {
    for (const purpose of ["yank", "delete"] as const) {
      for (const kind of ["read", "publish"] as const) {
        const who = await account(kind);
        const created = await createSession({ purpose, scopes: [target("acme/lib", "1.0.0")] });
        const cookie = await signIn(created, who);
        const html = await (await page(created, "", { cookie })).text();
        expect(html).toContain(`cannot ${purpose}`);
        expect(html).not.toContain("/approve");
        expect((await page(created, "approve", { cookie, form: {} })).status).toBe(403);
        expect((await poll(created)).status).toBe(202);
      }
    }
  });

  it("lets an admin-only login sign in for a yank or delete but not for a pull or publish", async () => {
    const who = await adminAccount();
    const pull = await createSession({ purpose: "pull" });
    const refused = await page(pull, "login", {
      form: { project: who.project, password: PASSWORD },
    });
    expect(refused.status).toBe(401);
    const publish = await createSession({
      purpose: "publish",
      scopes: [{ eco: "composer", package: "acme/lib", version: "1.0.0" }],
    });
    expect(
      (await page(publish, "login", { form: { project: who.project, password: PASSWORD } })).status,
    ).toBe(401);
    const yank = await createSession({ purpose: "yank", scopes: [target("acme/lib", "1.0.0")] });
    const ok = await page(yank, "login", { form: { project: who.project, password: PASSWORD } });
    expect(ok.status).toBe(303);
    expect(cookieOf(ok, "sreg_session")).toMatch(/^sreg_session=/);
  });

  it("asks for a new one-time code when the browser session has none", async () => {
    const who = await adminAccount(true);
    const created = await createSession({ purpose: "delete", scopes: [target("acme/lib")] });
    const first = await signIn(created, who, await currentCode(who.totpSecret));
    const stale = await staleCookie(first);
    expect(await (await page(created, "", { cookie: stale })).text()).toContain(
      "new one-time code",
    );
    expect((await page(created, "approve", { cookie: stale, form: {} })).status).toBe(403);
    expect((await poll(created)).status).toBe(202);
  });

  it("stops working when the login secret is expired", async () => {
    const who = await adminAccount();
    const issued = await issueAdminToken("yank", [target("acme/lib", "1.0.0")], who);
    expect((await call("GET", "/api/v1/whoami", { token: issued.token })).status).toBe(200);
    const record = await (
      await call("GET", `/api/v1/credentials/${who.project}`, { token: await adminToken() })
    ).json<{ auth: { id: string }[] }>();
    await expireSecret(env, who.project, record.auth[0]?.id ?? "", {}, new Date());
    expect((await call("GET", "/api/v1/whoami", { token: issued.token })).status).toBe(401);
  });
});

describe("login endpoints", () => {
  it("validate their input", async () => {
    const bad = await call("POST", "/api/v1/auth/sessions", { body: { purpose: "nope" } });
    expect(bad.status).toBe(400);
    const noPoll = await call("POST", "/api/v1/auth/sessions/poll", { body: {} });
    expect(noPoll.status).toBe(400);
    const created = await createSession({ purpose: "pull" });
    const wrong = await call("POST", "/api/v1/auth/sessions/poll", {
      body: { session: created.session, poll_token: "x" },
    });
    expect(wrong.status).toBe(401);
  });

  it("need no credential", async () => {
    const res = await exports.default.fetch(
      new Request(`${ORIGIN}/api/v1/auth/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose: "pull" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(totpStep(0)).toBe(0);
  });
});
