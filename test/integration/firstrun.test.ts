import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, ORIGIN } from "./helpers";

// The tests of this file run in order on their own registry, which starts empty.

/** A chosen password with non-ASCII letters and a dot (not a `<type>.<secret>` split). */
const PASSWORD = "Naïve.résumé-π-€";

const SAME_ORIGIN: Readonly<Record<string, string>> = {
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
};

function post(path: string, fields: Record<string, string>): Promise<Response> {
  return exports.default.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...SAME_ORIGIN },
      body: new URLSearchParams(fields),
      redirect: "manual",
    }),
  );
}

/** `Authorization: Basic` with the UTF-8 bytes of `user:password` in base64. */
function basic(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

describe("first run with a chosen password", () => {
  it("creates the admin with the password as its secret", async () => {
    const res = await post("/first-run", {
      project: "boss",
      password: PASSWORD,
      password_repeat: PASSWORD,
    });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Log in with the login <code>boss</code> and the password you chose.");
    expect(page).toContain(`<pre><code>boss:${PASSWORD}</code></pre>`);
    // Stored as a password hash, never as the password itself.
    const stored = (await env.AUTH.get("cred:boss")) ?? "";
    expect(stored).not.toBe("");
    expect(stored).not.toContain(PASSWORD);
  });

  it("logs in through the form with the project as login and the password", async () => {
    const res = await post("/login", { mode: "password", login: "boss", password: PASSWORD });
    expect(res.status).toBe(303);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^sreg_session=/);
    const home = await exports.default.fetch(
      new Request(`${ORIGIN}/admin/packages`, { headers: { cookie } }),
    );
    const page = await home.text();
    expect(page).toContain("Signed in as <strong>boss</strong>");
    expect(page).toContain('aria-current="page">Packages</a>');

    const wrong = await post("/login", {
      mode: "password",
      login: "boss",
      password: `${PASSWORD}x`,
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  it("logs in through the form with the whole token", async () => {
    const res = await post("/login", { mode: "token", token: `boss:${PASSWORD}` });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(/^sreg_session=/);
  });

  it("authenticates API calls with Authorization: Basic", async () => {
    const res = await call("GET", "/api/v1/whoami", {
      headers: { authorization: basic("boss", PASSWORD) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ project: "boss", kind: "admin" });

    const wrong = await call("GET", "/api/v1/whoami", {
      headers: { authorization: basic("boss", `${PASSWORD}x`) },
    });
    expect(wrong.status).toBe(401);
  });
});
