import { describe, expect, it } from "vitest";
import { composerAdapter } from "../../src/adapters/composer/index";
import type { Snippet } from "../../src/adapters/types";
import type { PackageView } from "../../src/core/packages";
import { consumerPage } from "../../src/pages/consumer";
import { placeholderSnippets } from "../../src/pages/snippets";

const ctx = {
  host: "packages.example.com",
  version: "1.0.0",
  user: { project: "shop", kind: "read" as const },
};
const BASE = "https://packages.example.com";

const sdk: PackageView = {
  eco: "composer",
  name: "acme/sdk",
  versions: [
    { version: "1.2.0", published: "2026-10-28T10:12:00Z", yanked: false, files: [] },
    { version: "1.1.0", published: "2026-09-01T08:00:00Z", yanked: true, files: [] },
  ],
  dependencies: [{ name: "acme/http", constraints: ["^1.1"], versions: ["1.4.0", "1.1.0"] }],
};

describe("placeholderSnippets", () => {
  it("replaces the token in every composer variant", () => {
    const snippets = placeholderSnippets(composerAdapter, BASE, "shop", ["acme/sdk"]);
    const bodies = snippets.map((s) => s.body).join("\n");
    expect(bodies).toContain('"packages.example.com": "<token>"');
    expect(bodies).toContain('"username": "shop"');
    expect(bodies).toContain('"password": "<secret>"');
    expect(bodies).toContain("https://<token>@packages.example.com/composer");
    expect(bodies).toContain("composer require acme/sdk");
    expect(bodies).not.toContain("SREG");
  });

  it("keeps the token prefix in the login", () => {
    const snippets = placeholderSnippets(composerAdapter, BASE, "srg_shop", []);
    const bodies = snippets.map((s) => s.body).join("\n");
    expect(bodies).toContain('"username": "srg_shop"');
    expect(bodies).toContain("https://<token>@packages.example.com/composer");
  });

  it("replaces base64 and URL-encoded tokens", () => {
    const adapter = {
      clientConfig: (_base: string, token: string): Snippet[] => [
        { title: "a", filename: "a", language: "ini", body: `_auth=${btoa(token)}` },
        { title: "b", filename: "b", language: "ini", body: `u=${encodeURIComponent(token)}` },
      ],
    };
    const [a, b] = placeholderSnippets(adapter, BASE, "shop", []);
    expect(a?.body).toBe("_auth=<base64 of the token>");
    expect(b?.body).toBe("u=<token>");
  });
});

describe("consumerPage", () => {
  const snippets = placeholderSnippets(composerAdapter, BASE, "shop", ["acme/sdk"]);

  it("lists the granted packages with their versions, yanked ones marked", () => {
    const page = consumerPage(ctx, [{ eco: "composer", packages: [sdk], snippets }]);
    expect(page).toContain("<h2>Composer</h2>");
    expect(page).toContain("<h3>acme/sdk</h3>");
    expect(page).toContain("<code>1.2.0</code> <time");
    expect(page).toContain('<code>1.1.0</code> <span class="badge warn">yanked</span>');
  });

  it("collapses the transitively opened dependencies", () => {
    const page = consumerPage(ctx, [{ eco: "composer", packages: [sdk], snippets: [] }]);
    expect(page).toContain('<details class="dependencies">');
    expect(page).not.toContain("<details open");
    expect(page).toContain("<summary>Dependencies (1)</summary>");
    expect(page).toContain("<td>acme/http</td><td><code>^1.1</code> </td><td>1.4.0, 1.1.0</td>");

    const none = consumerPage(ctx, [
      { eco: "composer", packages: [{ ...sdk, dependencies: [] }], snippets: [] },
    ]);
    expect(none).toContain("<summary>Dependencies (0)</summary>");
    expect(none).toContain("None in this registry.");
  });

  it("shows the snippets with copy buttons and the placeholder note", () => {
    const page = consumerPage(ctx, [{ eco: "composer", packages: [sdk], snippets }]);
    expect(page.match(/data-copy/g)).toHaveLength(snippets.length);
    expect(page).toContain("replace <code>&lt;token&gt;</code> with your token");
    expect(page).toContain("<code>&lt;secret&gt;</code> with the part after its colon");
    expect(page).toContain("https://&lt;token&gt;@packages.example.com/composer");
  });

  it("escapes package names and dependency data", () => {
    const evil: PackageView = {
      ...sdk,
      name: "<img src=x>",
      dependencies: [{ name: "<b>", constraints: ["<1"], versions: ["<v>"] }],
    };
    const page = consumerPage(ctx, [{ eco: "composer", packages: [evil], snippets: [] }]);
    expect(page).toContain("<h3>&lt;img src=x&gt;</h3>");
    expect(page).toContain("<td>&lt;b&gt;</td><td><code>&lt;1</code> </td><td>&lt;v&gt;</td>");
    expect(page).not.toContain("<img");
  });

  it("explains empty states", () => {
    expect(consumerPage(ctx, [])).toContain("This credential has no grants yet.");
    expect(consumerPage(ctx, [{ eco: "npm", packages: [], snippets: [] }])).toContain(
      "No packages are published under your grants yet.",
    );
  });
});
