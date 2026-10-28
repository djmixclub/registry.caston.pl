import { describe, expect, it } from "vitest";
import { composerAdapter } from "../../src/adapters/composer/index";
import { npmAdapter } from "../../src/adapters/npm/index";
import type { PackageView } from "../../src/core/packages";
import { humanSize, packageHref, snippetBlock, versionHref } from "../../src/pages/catalog";
import { packagePage } from "../../src/pages/package";
import { placeholderSnippets } from "../../src/pages/snippets";

const ctx = {
  host: "packages.example.com",
  version: "1.0.0",
  user: { project: "shop", kind: "read" as const },
};
const BASE = "https://packages.example.com";
const file = { name: "a.zip", size: 10, sha256: "0".repeat(64) };

const sdk: PackageView = {
  eco: "composer",
  name: "acme/sdk",
  versions: [
    { version: "1.2.0", published: "2026-10-28T10:12:00Z", yanked: false, files: [file] },
    { version: "1.1.0", published: "2026-09-01T08:00:00Z", yanked: true, files: [file, file] },
  ],
  dependencies: [{ name: "acme/http", constraints: ["^1.1"], versions: ["1.4.0", "1.1.0"] }],
};
const snippets = placeholderSnippets(composerAdapter, BASE, "shop", ["acme/sdk"]);

describe("catalog helpers", () => {
  it("links package and version pages with the name as one segment", () => {
    expect(packageHref("npm", "@acme/ui")).toBe("/packages/npm/%40acme%2Fui");
    expect(versionHref("composer", "acme/sdk", "1.0.0-beta+1")).toBe(
      "/packages/composer/acme%2Fsdk/1.0.0-beta%2B1",
    );
  });

  it("formats sizes", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(1023)).toBe("1023 B");
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(12 * 1024 * 1024)).toBe("12 MB");
  });

  it("puts the title, the file name and the copy button in the snippet header", () => {
    const install = snippetBlock({
      title: "Install",
      filename: "terminal",
      language: "shell",
      body: "x",
    }).value;
    expect(install).toContain(
      '<div class="snippet-head">\n<span class="snippet-title">Install</span>\n<span class="snippet-file">terminal</span>\n<button type="button" class="copy" data-copy>Copy</button>\n</div>\n<pre><code>x</code></pre>',
    );
    const named = snippetBlock({
      title: "auth.json (bearer)",
      filename: "auth.json",
      language: "json",
      body: "{}",
    }).value;
    expect(named).not.toContain("snippet-file");
  });
});

describe("packagePage", () => {
  it("shows breadcrumbs, the badge, the name and the latest version", () => {
    const page = packagePage(ctx, { view: sdk, snippets });
    expect(page).toContain("<title>acme/sdk · packages.example.com</title>");
    expect(page).toContain(
      '<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/">Packages</a></li><li aria-current="page">acme/sdk</li></ol></nav>',
    );
    expect(page).toContain('<span class="eco-badge" data-eco="composer">Composer</span>');
    expect(page).toContain("<h1>acme/sdk</h1>");
    expect(page).toContain('2 versions · latest <span class="version">1.2.0</span></p>');
    expect(page).toContain('<p class="back"><a href="/">← All packages</a></p>');
  });

  it("links every version with its date, yanked marker and file count", () => {
    const page = packagePage(ctx, { view: sdk, snippets });
    expect(page).toContain(
      '<a class="version" href="/packages/composer/acme%2Fsdk/1.2.0">1.2.0</a>\n\n<span class="version-meta"><time datetime="2026-10-28T10:12:00Z">2026-10-28</time> · 1 file</span>',
    );
    expect(page).toContain(
      '<a class="version" href="/packages/composer/acme%2Fsdk/1.1.0">1.1.0</a>\n<span class="badge warn">yanked</span>\n<span class="version-meta"><time datetime="2026-09-01T08:00:00Z">2026-09-01</time> · 2 files</span>',
    );
  });

  it("collapses the dependencies the grant opens and links them", () => {
    const page = packagePage(ctx, { view: sdk, snippets });
    expect(page).toContain('<details class="dependencies">\n<summary>Dependencies (1)</summary>');
    expect(page).not.toContain("<details open");
    expect(page).toContain(
      '<a href="/packages/composer/acme%2Fhttp">acme/http</a>\n<span class="dep-meta">^1.1 → 1.4.0, 1.1.0</span>',
    );
    for (const dependencies of [[], undefined]) {
      const none = packagePage(ctx, { view: { ...sdk, dependencies }, snippets });
      expect(none).not.toContain("<details");
      expect(none).not.toContain("Dependencies (");
    }
  });

  it("shows this package's snippets with copy buttons and the placeholder note once", () => {
    const page = packagePage(ctx, { view: sdk, snippets });
    expect(page.match(/data-copy/g)).toHaveLength(snippets.length);
    expect(page.match(/class="placeholder-note"/g)).toHaveLength(1);
    expect(page).toContain("replace <code>&lt;token&gt;</code> with your token");
    expect(page).toContain("<code>&lt;secret&gt;</code> with the part after its colon");
    expect(page).toContain("https://&lt;token&gt;@packages.example.com/composer");
    expect(page).toContain("composer require acme/sdk");
    expect(page.indexOf("Versions</h2>")).toBeLessThan(page.indexOf("Configuration</h2>"));
  });

  it("names only this package in npm snippets", () => {
    const ui: PackageView = { eco: "npm", name: "@acme/ui", versions: sdk.versions };
    const npm = placeholderSnippets(npmAdapter, BASE, "shop", ["@acme/ui"]);
    const page = packagePage(ctx, { view: ui, snippets: npm });
    expect(page).toContain("@acme:registry=https://packages.example.com/npm/");
    expect(page).toContain("npm install @acme/ui");
    expect(page).toContain("<code>&lt;base64 of the token&gt;</code> with its base64 encoding");
  });

  it("leaves out the configuration without snippets and notes transitive access", () => {
    const page = packagePage(ctx, { view: sdk, snippets: [], transitive: true });
    expect(page).not.toContain("Configuration</h2>");
    expect(page).toContain("Available as a dependency of a package granted to this credential.");
  });

  it("shows the latest version's generic meta as a table, nested values as JSON", () => {
    const tools: PackageView = { eco: "generic", name: "tools", versions: sdk.versions };
    const meta = { channel: "stable", build: { commit: "<abc>", number: 7 }, beta: false };
    const page = packagePage(ctx, { view: tools, snippets: [], meta });
    expect(page).toContain('<h2 id="metadata">Metadata</h2>');
    expect(page).toContain('From the latest version, <span class="version">1.2.0</span>.');
    expect(page).toContain('<tr><th scope="row">channel</th><td>stable</td></tr>');
    expect(page).toContain(
      '<tr><th scope="row">build</th><td><code class="meta-json">{\n  &quot;commit&quot;: &quot;&lt;abc&gt;&quot;,\n  &quot;number&quot;: 7\n}</code></td></tr>',
    );
    expect(page).toContain('<th scope="row">beta</th><td><code class="meta-json">false</code>');
    expect(page.indexOf("Versions</h2>")).toBeLessThan(page.indexOf("Metadata</h2>"));
    for (const empty of [{}, undefined]) {
      const none = packagePage(ctx, { view: tools, snippets: [], meta: empty });
      expect(none).not.toContain("Metadata");
    }
  });

  it("escapes package names and dependency data", () => {
    const evil: PackageView = {
      ...sdk,
      name: "<img src=x>",
      dependencies: [{ name: "<b>", constraints: ["<1"], versions: ["<v>"] }],
    };
    const page = packagePage(ctx, { view: evil, snippets: [] });
    expect(page).toContain("<h1>&lt;img src=x&gt;</h1>");
    expect(page).toContain('<span class="dep-meta">&lt;1 → &lt;v&gt;</span>');
    expect(page).not.toContain("<img");
    expect(page).not.toContain("<b>");
  });
});
