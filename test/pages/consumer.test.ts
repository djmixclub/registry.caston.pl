import { describe, expect, it } from "vitest";
import { composerAdapter } from "../../src/adapters/composer/index";
import type { Snippet } from "../../src/adapters/types";
import type { PackageView } from "../../src/core/packages";
import { assignPackages, createGroup, NO_GROUPS, type PackageGroups } from "../../src/core/groups";
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
  it("ignores everything but letters and digits when sorting", () => {
    const sorted = sortPackages([
      view("npm", "foo-bar"),
      view("npm", "foo.baz"),
      view("npm", "foobaa"),
      view("npm", "foo/bat"),
    ]);
    expect(sorted.map((p) => p.name)).toEqual(["foobaa", "foo-bar", "foo/bat", "foo.baz"]);
  });

  it("sorts by name ignoring case and punctuation, then by ecosystem", () => {
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
    // The only disclosure is a filter selector, none of the package page's.
    expect(page.replace(/<details class="multi"[^>]*>/g, "")).not.toContain("<details");
    expect(page).not.toContain("<code>");
  });

  it("renders a hidden, labelled filter bar with a multiple-choice selector of the ecosystems", () => {
    const page = consumerPage(ctx, packages);
    expect(page).toContain('<div class="pkg-filter" data-pkg-filter hidden>');
    expect(page).toContain('<label for="pkg-filter-name">Filter by name</label>');
    expect(page).toContain('<input type="search" id="pkg-filter-name" data-filter-name');
    expect(page).toContain('<details class="multi" data-filter-multi="eco">');
    expect(page).toContain('<span class="multi-caption" id="multi-eco-caption">Ecosystem</span>');
    const options = [
      ...page.matchAll(
        /<input type="checkbox" value="(\w+)" data-multi-option data-label="([^"]+)"><span class="multi-name">[^<]+<\/span><span class="multi-count">(\d+)</g,
      ),
    ];
    expect(options.map((m) => [m[1], m[2], m[3]])).toEqual([
      ["cargo", "Cargo", "1"],
      ["composer", "Composer", "1"],
      ["npm", "npm", "1"],
    ]);
    expect(page).not.toContain("data-filter-group");
    expect(page).toContain('data-pkg-empty role="status" hidden>No packages match the filter.');
  });

  it("leaves out the ecosystem selector for one ecosystem and the filter bar for one package", () => {
    const one = consumerPage(ctx, [sdk, view("composer", "acme/log", [["1.0.0", false]])]);
    expect(one).toContain("data-pkg-filter");
    expect(one).not.toContain("data-filter-multi");
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

describe("grouped lists", () => {
  const packages = [
    view("npm", "@acme/ui", [["1.0.0", false]]),
    view("npm", "@acme/core", [["1.0.0", false]]),
    view("composer", "acme/sdk", [["1.0.0", false]]),
    view("cargo", "loose", [["0.1.0", false]]),
  ];

  /** `Acme` > `Web` holds `@acme/ui`; `Acme` holds `@acme/core`; `acme/sdk` and `loose` are loose. */
  function groups(): PackageGroups {
    let state = createGroup(NO_GROUPS, "Acme", null, "aaaa");
    state = createGroup(state, "Web", "aaaa", "bbbb");
    state = createGroup(state, "Empty", null, "cccc");
    state = assignPackages(state, ["npm:@acme/core"], "aaaa");
    return assignPackages(state, ["npm:@acme/ui"], "bbbb");
  }

  const at = (page: string, text: string) => page.indexOf(text);

  it("is the plain list without groups, or while none of the visible packages is in one", () => {
    const plain = consumerPage(ctx, packages);
    expect(plain).not.toContain("pkg-group");
    expect(plain).toContain('<ul class="pkg-list" data-pkg-list>');
    expect(consumerPage(ctx, packages, NO_GROUPS)).toBe(plain);
    const other = assignPackages(groups(), [], null);
    const elsewhere = consumerPage(ctx, [view("cargo", "loose")], other);
    expect(elsewhere).not.toContain("pkg-group");
  });

  it("puts Ungrouped first, then the groups with their subgroups, and hides empty groups", () => {
    const page = consumerPage(ctx, packages, groups());
    const ungrouped = at(page, "pkg-ungrouped");
    const acme = at(page, 'id="group-aaaa"');
    const web = at(page, 'id="group-bbbb"');
    expect(ungrouped).toBeGreaterThan(0);
    expect(acme).toBeGreaterThan(ungrouped);
    expect(web).toBeGreaterThan(acme);
    expect(page).not.toContain('id="group-cccc"');
    expect(page).toContain(
      '<summary><span class="pkg-group-name">Ungrouped</span> <span class="pkg-group-count">2</span></summary>',
    );
    // A group counts what is in its subgroups too.
    expect(page).toContain(
      '<summary><span class="pkg-group-name">Acme</span> <span class="pkg-group-count">2</span></summary>',
    );
    expect(page).toContain('<div class="pkg-subgroups">');
    // Rows know the chain of groups they are in, for the group selector.
    expect(page).toContain('data-name="@acme/ui" data-groups="aaaa bbbb"');
    expect(page).toContain('data-name="@acme/core" data-groups="aaaa"');
    expect(page).toContain('data-name="loose" data-groups="_"');
  });

  it("offers a multiple-choice selector of the groups with packages, indented by level, with counts", () => {
    const page = consumerPage(ctx, packages, groups());
    expect(page).toContain('<details class="multi" data-filter-multi="group">');
    expect(page).toContain('<span class="multi-caption" id="multi-group-caption">Group</span>');
    const option = (value: string, label: string, count: number, depth: number) =>
      `<label class="multi-option depth-${depth}"><input type="checkbox" value="${value}" data-multi-option data-label="${label}"><span class="multi-name">${label}</span><span class="multi-count">${count}</span></label>`;
    expect(page).toContain(option("_", "Ungrouped", 2, 1));
    expect(page).toContain(option("aaaa", "Acme", 2, 1));
    expect(page).toContain(option("bbbb", "Web", 1, 2));
    expect(page).not.toContain('value="cccc"');
    // The groups come first, in tree order, the ecosystems after them.
    expect(page.indexOf('data-filter-multi="group"')).toBeLessThan(
      page.indexOf('data-filter-multi="eco"'),
    );
    expect(page.indexOf(option("_", "Ungrouped", 2, 1))).toBeLessThan(
      page.indexOf(option("aaaa", "Acme", 2, 1)),
    );
    expect(page.indexOf(option("aaaa", "Acme", 2, 1))).toBeLessThan(
      page.indexOf(option("bbbb", "Web", 1, 2)),
    );
  });

  it("shows no Ungrouped section when every package is in a group", () => {
    const page = consumerPage(ctx, [view("npm", "@acme/ui")], groups());
    expect(page).not.toContain("pkg-ungrouped");
    expect(page).toContain('id="group-aaaa"');
  });
});

describe("the ecosystem selector", () => {
  it("lists the ecosystems by display name, ignoring case", () => {
    const all = (["swift", "npm", "maven", "nuget", "generic", "composer", "cargo"] as const).map(
      (eco) => view(eco, `${eco}-pkg`, [["1.0.0", false]]),
    );
    const page = consumerPage(ctx, all);
    const values = [...page.matchAll(/data-multi-option data-label="([^"]+)"/g)].map((m) => m[1]);
    expect(values).toEqual(["Cargo", "Composer", "Generic", "Maven", "npm", "NuGet", "Swift"]);
    expect(page).toContain("7 packages in 7 ecosystems.");
  });
});
