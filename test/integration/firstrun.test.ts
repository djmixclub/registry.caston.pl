import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../../src/core/totp";
import { handlePanel } from "../../src/panel";
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

describe("first run without SESSION_SECRET", () => {
  const unsigned = { ...env, SESSION_SECRET: undefined };

  it("shows only the setup checklist with a generator", async () => {
    const request = new Request(`${ORIGIN}/`);
    const res = await handlePanel(request, unsigned, new URL(request.url));
    expect(res?.status).toBe(200);
    const page = (await res?.text()) ?? "";
    expect(page).toContain("<h1>Finish the setup</h1>");
    expect(page).toContain("data-generate hidden>Generate a value</button>");
    expect(page).toContain("<code>openssl rand -base64 48</code>");
    expect(page).not.toContain('action="/first-run"');
    expect(page).not.toContain("test-secret-access-key");
  });

  it("creates no admin that could not sign in", async () => {
    const request = new Request(`${ORIGIN}/first-run`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...SAME_ORIGIN },
      body: new URLSearchParams({ project: "early" }),
    });
    const res = await handlePanel(request, unsigned, new URL(request.url));
    expect(res?.status).toBe(409);
    expect(await res?.text()).toContain("<h1>Finish the setup</h1>");
    expect(await env.AUTH.get("cred:early")).toBeNull();
  });

  it("shows the collapsed checklist above the form once it is set", async () => {
    const page = await (await exports.default.fetch(new Request(`${ORIGIN}/`))).text();
    expect(page).toContain("All required settings are present");
    expect(page).toContain('action="/first-run"');
  });
});

describe("first run with a login secret", () => {
  /** The password and the one-time code key shown on the page of a new login. */
  function shown(page: string): { password: string; key: string } {
    const password = /Password<\/div>[\s\S]*?<pre><code>([^<]+)<\/code>/.exec(page)?.[1] ?? "";
    const key = /Key<\/div>[\s\S]*?<pre><code>([A-Z2-7]+)<\/code>/.exec(page)?.[1] ?? "";
    return { password, key };
  }

  let key = "";
  let usedStep = 0;

  const code = async (offset: number) => (await totpCode(key, totpStep(Date.now()) + offset)) ?? "";

  const cookieOf = (res: Response, name: string) =>
    (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0] ?? "";

  it("creates the admin with the chosen password and a one-time code, shown once", async () => {
    const res = await post("/first-run", {
      project: "boss",
      password: PASSWORD,
      password_repeat: PASSWORD,
      totp: "on",
    });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<h1>Admin created</h1>");
    expect(page).toContain("Sign in as <code>boss</code> with this password.");
    const seen = shown(page);
    expect(seen.password).toBe(PASSWORD);
    key = seen.key;
    expect(key).toMatch(/^[A-Z2-7]{32}$/);
    // A QR code and the otpauth link, with no script or style.
    expect(page).toContain('<div class="qr"><svg ');
    expect(page).toContain("otpauth://totp/");
    expect(page).not.toMatch(/<script(?![^>]*\bsrc=)/);
    // Stored as a password hash and an encrypted key, never as themselves.
    const stored = (await env.AUTH.get("cred:boss")) ?? "";
    expect(stored).toContain('"type":"login"');
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(key);
    expect(stored).not.toContain('"type":"key"');
  });

  it("shows the sign-in page with the login and password by default", async () => {
    const page = await (await exports.default.fetch(new Request(`${ORIGIN}/`))).text();
    expect(page).toContain('id="mode-password" value="password" checked');
    expect(page).toContain('name="login"');
  });

  it("asks for the one-time code only after the password, with a cookie that is no session", async () => {
    const res = await post("/login", { mode: "password", login: "boss", password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login/code");
    expect(cookieOf(res, "sreg_session")).toBe("");
    const pending = cookieOf(res, "sreg_pending");
    expect(pending).toMatch(/^sreg_pending=/);
    expect(res.headers.get("set-cookie")).toContain("Path=/login");

    const form = await exports.default.fetch(
      new Request(`${ORIGIN}/login/code`, { headers: { cookie: pending } }),
    );
    const html = await form.text();
    expect(html).toContain("<strong>boss</strong>");
    expect(html).not.toContain('type="password"');

    // The pending cookie opens nothing by itself.
    const admin = await exports.default.fetch(
      new Request(`${ORIGIN}/admin/packages`, { headers: { cookie: pending }, redirect: "manual" }),
    );
    expect(admin.status).toBe(303);
    const api = await call("GET", "/api/v1/whoami", { headers: { cookie: pending } });
    expect(api.status).toBe(401);
  });

  it("does not ask for a code when the password is wrong, and says the same as for an unknown login", async () => {
    const wrong = await post("/login", {
      mode: "password",
      login: "boss",
      password: `${PASSWORD}x`,
    });
    const unknown = await post("/login", { mode: "password", login: "nobody", password: PASSWORD });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.text()).toContain("The login or the password is not valid.");
    }
  });

  it("signs in with the code, once", async () => {
    const start = await post("/login", { mode: "password", login: "boss", password: PASSWORD });
    const pending = cookieOf(start, "sreg_pending");
    const withCookie = (fields: Record<string, string>) =>
      exports.default.fetch(
        new Request(`${ORIGIN}/login/code`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: pending,
            ...SAME_ORIGIN,
          },
          body: new URLSearchParams(fields),
          redirect: "manual",
        }),
      );

    const wrong = await withCookie({ code: "000000" });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("The one-time code is not valid.");
    expect(cookieOf(wrong, "sreg_session")).toBe("");

    const good = await withCookie({ code: await code(-1) });
    usedStep = totpStep(Date.now()) - 1;
    expect(good.status).toBe(303);
    expect(good.headers.get("location")).toBe("/");
    const session = cookieOf(good, "sreg_session");
    expect(session).toMatch(/^sreg_session=/);
    // The pending cookie is cleared.
    expect(good.headers.getSetCookie().join("\n")).toContain("sreg_pending=; ");
    const home = await exports.default.fetch(
      new Request(`${ORIGIN}/admin/packages`, { headers: { cookie: session } }),
    );
    const page = await home.text();
    expect(page).toContain("Signed in as <strong>boss</strong>");
    expect(page).toContain('aria-current="page">Packages</a>');

    // The same code does not work a second time.
    const replay = await withCookie({ code: await code(-1) });
    expect(replay.status).toBe(401);
    expect(usedStep).toBeLessThan(totpStep(Date.now()));
  });

  it("sends a stale pending sign-in back to the start", async () => {
    const res = await exports.default.fetch(
      new Request(`${ORIGIN}/login/code`, {
        headers: { cookie: "sreg_pending=forged.value" },
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("does not turn the password into a token", async () => {
    const res = await post("/login", { mode: "token", token: `boss:${PASSWORD}` });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("The token, or the login and password, are not valid.");
    const api = await call("GET", "/api/v1/whoami", {
      headers: { authorization: basic("boss", PASSWORD) },
    });
    expect(api.status).toBe(401);
  });
});
