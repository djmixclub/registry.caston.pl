import { describe, expect, it } from "vitest";
import { firstRunDonePage, firstRunPage } from "../../src/pages/firstRun";
import { loginPage } from "../../src/pages/login";
import { messagePage } from "../../src/pages/message";
import { publishPage } from "../../src/pages/publish";
import { loginAuthorization } from "../../src/panel";

const ctx = { host: "packages.example.com", version: "1.0.0" };

describe("loginPage", () => {
  it("posts the token form to /login", () => {
    const page = loginPage(ctx);
    expect(page).toContain('<form method="post" action="/login"');
    expect(page).toMatch(/<input id="token" name="token" type="password"[^>]*>/);
    expect(page).toContain('value="token" checked');
    expect(page).not.toContain('class="error"');
    // The password fields start hidden and disabled; app.js toggles them.
    expect(page).toMatch(/<div data-login-mode="password" hidden>/);
    expect(page).toMatch(/<input id="login"[^>]* disabled>/);
  });

  it("shows an error and keeps the login, escaped, in password mode", () => {
    const page = loginPage(ctx, { error: "Wrong <credentials>", mode: "password", login: '"x' });
    expect(page).toContain('<p class="error" role="alert">Wrong &lt;credentials&gt;</p>');
    expect(page).toContain('value="password" checked');
    expect(page).toContain('value="&quot;x"');
    expect(page).toMatch(/<div data-login-mode="token" hidden>/);
    expect(page).toMatch(/<input id="token"[^>]* disabled>/);
  });
});

describe("loginAuthorization", () => {
  it("sends a token as Bearer", () => {
    expect(loginAuthorization(new URLSearchParams({ token: " shop:abc " }))).toBe(
      "Bearer shop:abc",
    );
    expect(loginAuthorization(new URLSearchParams({ token: "" }))).toBeNull();
  });

  it("sends a token with non-ASCII characters as Basic", () => {
    const token = "root:caf\u00e9-\u2713-long-secret";
    const header = loginAuthorization(new URLSearchParams({ token })) ?? "";
    expect(header.startsWith("Basic ")).toBe(true);
    const bytes = Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(token);
  });

  it("sends a login and password as Basic", () => {
    const form = new URLSearchParams({ mode: "password", login: "shop", password: "abc" });
    expect(loginAuthorization(form)).toBe(`Basic ${btoa("shop:abc")}`);
    expect(loginAuthorization(new URLSearchParams({ mode: "password", login: "shop" }))).toBeNull();
  });
});

describe("firstRunPage", () => {
  it("shows the create-admin form", () => {
    const page = firstRunPage(ctx);
    expect(page).toContain('<form method="post" action="/first-run">');
    expect(page).toContain('name="project"');
    expect(page).toContain("Create the first admin");
  });

  it("escapes the error and the prefilled project", () => {
    const page = firstRunPage(ctx, { error: "<bad>", project: '"><script>' });
    expect(page).toContain("&lt;bad&gt;");
    expect(page).toContain('value="&quot;&gt;&lt;script&gt;"');
    expect(page).not.toContain('"><script>');
  });

  it("shows the token once with a copy button", () => {
    const page = firstRunDonePage(ctx, "admin", "admin:k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e");
    expect(page).toContain("<pre><code>admin:k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e</code></pre>");
    // The button sits above the text, not over it.
    expect(page).toMatch(/data-copy>Copy<\/button>\n<\/div>\n<pre><code>admin:/);
    expect(page).not.toContain("/first-run");
  });
});

describe("other pages", () => {
  it("tells publish credentials that they can only publish", () => {
    expect(publishPage({ ...ctx, user: { project: "ci", kind: "publish" } })).toContain(
      "This credential can only publish.",
    );
  });

  it("escapes messages", () => {
    expect(messagePage(ctx, "<t>", "<m>")).toContain("<p>&lt;m&gt;</p>");
  });
});
