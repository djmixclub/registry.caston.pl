import { describe, expect, it } from "vitest";
import type { LoginSession } from "../../src/core/login";
import {
  authorizeApprovePage,
  authorizeDonePage,
  authorizeSignInPage,
} from "../../src/pages/authorize";
import { loginSecretPage } from "../../src/pages/token";

const ctx = { host: "registry.test", version: "9.9.9" };
const pull: LoginSession = { purpose: "pull", nonce: "n", exp: 0 };
const publish: LoginSession = {
  purpose: "publish",
  nonce: "n",
  exp: 0,
  scopes: [{ eco: "composer", package: "acme/<lib>", version: "1.0.0" }],
};
const checks = (allowed: boolean) => (publish.scopes ?? []).map((scope) => ({ scope, allowed }));

describe("authorize sign-in page", () => {
  it("describes a download and posts the sign-in form", () => {
    const html = authorizeSignInPage(ctx, "abc.def", pull, []);
    expect(html).toContain("download packages");
    expect(html).toContain('action="/authorize/abc.def/login"');
    expect(html).toContain('name="project"');
    expect(html).toContain('name="password" type="password"');
    expect(html).toContain('name="code"');
  });

  it("lists the versions of a publish, escaped", () => {
    const html = authorizeSignInPage(ctx, "x", publish, checks(true));
    expect(html).toContain("<strong>acme/&lt;lib&gt;</strong>");
    expect(html).toContain("<code>1.0.0</code>");
    expect(html).not.toContain("acme/<lib>");
  });

  it("shows an error and keeps the login but never a password", () => {
    const html = authorizeSignInPage(ctx, "x", pull, [], { error: "No.", project: 'a"b' });
    expect(html).toContain('<p class="error" role="alert">No.</p>');
    expect(html).toContain('value="a&quot;b"');
    expect(html).not.toContain('type="password" value');
  });
});

describe("authorize approval page", () => {
  const base = { id: "id", project: "shop", session: pull, checks: [] };

  it("offers Approve, Refuse and the extended validity", () => {
    const html = authorizeApprovePage(ctx, { ...base, extendedHours: 24 });
    expect(html).toContain('action="/authorize/id/approve"');
    expect(html).toContain('action="/authorize/id/deny"');
    expect(html).toContain('action="/authorize/id/switch"');
    expect(html).toContain('name="extended"');
    expect(html).toContain("24 hours instead of 1 hour");
    expect(html).toContain("Signed in as <strong>shop</strong>");
  });

  it("leaves the extended validity out when not offered", () => {
    expect(authorizeApprovePage(ctx, base)).not.toContain('name="extended"');
  });

  it("marks operations the grants do not allow and offers no approval", () => {
    const html = authorizeApprovePage(ctx, {
      ...base,
      session: publish,
      checks: checks(false),
      problem: "This credential's grants do not allow every operation listed above.",
    });
    expect(html).toContain("not allowed");
    expect(html).toContain("grants do not allow");
    expect(html).not.toContain("/approve");
    expect(html).toContain("/deny");
  });

  it("asks for a new code before approving", () => {
    const html = authorizeApprovePage(ctx, {
      ...base,
      session: publish,
      checks: checks(true),
      needsCode: true,
    });
    expect(html).toContain('action="/authorize/id/totp"');
    expect(html).toContain("new one-time code");
    expect(html).not.toContain("/approve");
  });

  it("shows an error above the form", () => {
    const html = authorizeApprovePage(ctx, { ...base, error: "Try again." });
    expect(html).toContain('<p class="error" role="alert">Try again.</p>');
  });
});

describe("authorize done page and login secret page", () => {
  it("says what was decided", () => {
    expect(authorizeDonePage(ctx, true)).toContain("<h1>Approved</h1>");
    expect(authorizeDonePage(ctx, false)).toContain("<h1>Refused</h1>");
  });

  it("shows the password and the one-time code enrolment", () => {
    const html = loginSecretPage(ctx, {
      project: "shop",
      password: "pw<>",
      totp: { secret: "ABCDEF", otpauthUri: "otpauth://totp/x?secret=ABCDEF" },
      next: { href: "/admin/credentials/shop", label: "Back" },
    });
    expect(html).toContain("<code>pw&lt;&gt;</code>");
    expect(html).toContain("otpauth://totp/x?secret=ABCDEF");
    expect(html).toContain("<code>ABCDEF</code>");
    const plain = loginSecretPage(ctx, {
      project: "shop",
      password: "pw",
      next: { href: "/", label: "Back" },
    });
    expect(plain).not.toContain("otpauth");
  });
});
