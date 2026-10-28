import { describe, expect, it } from "vitest";
import { SafeHtml, escapeHtml, markup } from "../../src/pages/html";
import { CONTENT_SECURITY_POLICY, htmlResponse, layout } from "../../src/pages/layout";

describe("escapeHtml", () => {
  it("escapes the five significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
    expect(escapeHtml("plain text")).toBe("plain text");
  });
});

describe("markup", () => {
  it("escapes interpolated values and keeps safe fragments", () => {
    const inner = markup`<b>${"<i>"}</b>`;
    const out = markup`<p title="${'"quoted"'}">${inner}${"&"}</p>`;
    expect(out).toBeInstanceOf(SafeHtml);
    expect(out.value).toBe('<p title="&quot;quoted&quot;"><b>&lt;i&gt;</b>&amp;</p>');
  });

  it("concatenates arrays and skips empty values", () => {
    const items = ["<a>", "b"].map((x) => markup`<li>${x}</li>`);
    const out = markup`<ul>${items}${null}${undefined}${false}${0}</ul>`;
    expect(out.value).toBe("<ul><li>&lt;a&gt;</li><li>b</li>0</ul>");
  });
});

describe("layout", () => {
  const ctx = { host: "packages.example.com", version: "1.2.3" };

  it("renders the document shell", () => {
    const page = layout(ctx, "Title", markup`<p>content</p>`);
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).toContain('<meta name="viewport"');
    expect(page).toContain('<link rel="stylesheet" href="/app.css">');
    expect(page).toContain('<script src="/app.js" defer></script>');
    expect(page).toContain('<a class="brand" href="/">packages.example.com</a>');
    expect(page).toContain("Serverless Registry 1.2.3");
    expect(page).toContain("<p>content</p>");
    expect(page).not.toContain("/logout");
  });

  it("has no inline scripts, styles or event handlers", () => {
    const page = layout(ctx, "Title", markup``);
    expect(page).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(page).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
  });

  it("shows the signed-in user with a logout form", () => {
    const user = { project: "<shop>", kind: "read" } as const;
    const page = layout({ ...ctx, user }, "Title", markup``);
    expect(page).toContain("<strong>&lt;shop&gt;</strong>");
    expect(page).toContain('<form class="signed-in" method="post" action="/logout">');
  });

  it("escapes the host and the title", () => {
    const page = layout({ host: "<host>", version: "1" }, "<t>", markup``);
    expect(page).toContain("<title>&lt;t&gt; · &lt;host&gt;</title>");
  });
});

describe("htmlResponse", () => {
  it("carries the security headers", () => {
    const res = htmlResponse("<!doctype html>", 401, { "x-extra": "1" });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).toMatch(/^default-src 'self'/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-extra")).toBe("1");
  });
});
