import { describe, expect, it } from "vitest";
import { composerAdapter } from "../../src/adapters/composer/index";
import type { Snippet } from "../../src/adapters/types";
import type { PackageView } from "../../src/core/packages";
import { consumerPage, NO_PACKAGES, sortPackages } from "../../src/pages/consumer";
import { placeholderSnippets } from "../../src/pages/snippets";

const ctx = {
  host: "packages.example.com",
  version: "1.0.0",
  user: { project: "shop", roles: ["read"] as const },
};
const BASE = "https://packages.example.com";

const view = (eco: PackageView["eco"], name: string, versions: [string, boolean][] = []) => ({
  eco,
  name,
  versions: versions.map(([version, yanked]) => ({
    version,
    published: "2026-10-01T00:00:00Z",
    yanked,
    files: [],
  })),
});

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

describe("sortPackages", () => {
  it("sorts by name ignoring case and a leading @, then by ecosystem", () => {
    const sorted = sortPackages([
      view("npm", "zeta"),
      view("composer", "Beta/x"),
      view("cargo", "alpha"),
      view("npm", "@scope/b"),
      view("composer", "alpha"),
      view("npm", "beta"),
    ]);
    expect(sorted.map((p) => `${p.eco}:${p.name}`)).toEqual([
      "cargo:alpha",
      "composer:alpha",
      "npm:beta",
      "composer:Beta/x",
      "npm:@scope/b",
      "npm:zeta",
    ]);
  });
});

describe("consumerPage", () => {
  const packages: PackageView[] = [
    view("npm", "@acme/ui", [
      ["2.0.0", true],
      ["1.0.0", false],
    ]),
    sdk,
    view("cargo", "Acme-Core", [["0.3.0", false]]),
  ];

  it("lists every package in one list sorted by name, without ecosystem sections", () => {
    const page = consumerPage(ctx, packages);
    expect(page).toContain("<h1>Your packages</h1>");
    expect(page).not.toContain("<h2>");
    expect(page.match(/<li class="pkg-row"/g)).toHaveLength(3);
    const order = ["Acme-Core", "acme/sdk", "@acme/ui"].map((name) =>
      page.indexOf(`<span class="pkg-name">${name}</span>`),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page).toContain(
      '<p class="consumer-lead" data-pkg-lead aria-live="polite">3 packages in 3 ecosystems.',
    );
  });

  it("shows the ecosystem badge, the number of versions and the latest version", () => {
    const page = consumerPage(ctx, packages);
    expect(page).toContain(
      '<li class="pkg-row" data-pkg-row data-eco="composer" data-name="acme/sdk">\n<a class="pkg-link" href="/packages/composer/acme%2Fsdk">\n<span class="eco-badge" data-eco="composer">Composer</span>\n<span class="pkg-name">acme/sdk</span>',
    );
    expect(page).toContain('<span class="eco-badge" data-eco="cargo">Cargo</span>');
    expect(page).toContain('href="/packages/npm/%40acme%2Fui"');
    expect(page).toContain('data-name="acme-core"');
    expect(page).toContain(
      '<span>2 versions</span><span class="pkg-latest">latest <span class="version">1.2.0</span></span>',
    );
    expect(page).toContain(
      '<span>1 version</span><span class="pkg-latest">latest <span class="version">0.3.0</span></span>',
    );
  });

  it("marks a yanked latest version only", () => {
    const page = consumerPage(ctx, packages);
    expect(page).toContain(
      '<span class="pkg-latest">latest <span class="version">2.0.0</span> <span class="badge warn">yanked</span></span>',
    );
    expect(page.match(/yanked/g)).toHaveLength(1);
  });

  it("keeps versions, dependencies and snippets for the package pages", () => {
    const page = consumerPage(ctx, packages);
    expect(page).not.toContain("1.1.0");
    expect(page).not.toContain("acme/http");
    expect(page).not.toContain("data-copy");
    expect(page).not.toContain("<details");
    expect(page).not.toContain("<code>");
  });

  it("renders a hidden, labelled filter bar with a chip per ecosystem present", () => {
    const page = consumerPage(ctx, packages);
    expect(page).toContain('<div class="pkg-filter" data-pkg-filter hidden>');
    expect(page).toContain('<label for="pkg-filter-name">Filter by name</label>');
    expect(page).toContain('<input type="search" id="pkg-filter-name" data-filter-name');
    expect(page).toContain('role="group" aria-label="Ecosystems"');
    const chips = [...page.matchAll(/data-filter-eco="(\w+)" aria-pressed="false">([^<]+)</g)];
    expect(chips.map((m) => m[2])).toEqual(["Cargo", "Composer", "npm"]);
    expect(page).toContain('data-pkg-empty role="status" hidden>No packages match the filter.');
  });

  it("leaves out the chips for one ecosystem and the filter bar for one package", () => {
    const one = consumerPage(ctx, [sdk, view("composer", "acme/log", [["1.0.0", false]])]);
    expect(one).toContain("data-pkg-filter");
    expect(one).not.toContain("data-filter-eco");
    expect(one).toContain("2 packages. Open a package");
    const single = consumerPage(ctx, [sdk]);
    expect(single).not.toContain("data-pkg-filter");
    expect(single).toContain("1 package. Open a package");
  });

  it("escapes package names", () => {
    const page = consumerPage(ctx, [{ ...sdk, name: "<img src=x>" }]);
    expect(page).toContain('<span class="pkg-name">&lt;img src=x&gt;</span>');
    expect(page).toContain('href="/packages/composer/%3Cimg%20src%3Dx%3E"');
    expect(page).not.toContain("<img");
  });

  it("explains the empty state", () => {
    const page = consumerPage(ctx, []);
    expect(NO_PACKAGES).toBe("No packages are granted to this credential yet.");
    expect(page).toContain(`<p>${NO_PACKAGES}</p>`);
    expect(page).not.toContain("data-pkg-list");
    expect(page).not.toContain("data-pkg-filter");
  });
});
