import { describe, expect, it } from "vitest";
import type { Credential } from "../../src/core/auth";
import type { PackageView } from "../../src/core/packages";
import {
  adminPackagesPage,
  apiPath,
  awaitsPin,
  credentialHref,
  secretSummary,
} from "../../src/pages/admin";
import { setupStatus } from "../../src/core/config";
import {
  credentialPage,
  credentialsPage,
  credentialTab,
  newCredentialPage,
  type CredentialPageData,
} from "../../src/pages/credentials";
import { layout } from "../../src/pages/layout";
import { markup } from "../../src/pages/html";
import { packagePage } from "../../src/pages/package";
import { settingsPage } from "../../src/pages/settings";
import { versionPage } from "../../src/pages/version";

const ctx = {
  host: "packages.example.com",
  version: "1.0.0",
  user: { project: "root", kind: "admin" as const },
};
const NOW = new Date("2026-10-28T10:00:00Z");

const npmSdk: PackageView = {
  eco: "npm",
  name: "@acme/sdk",
  versions: [
    {
      version: "2.0.0",
      published: "2026-10-28T10:12:00Z",
      yanked: false,
      files: [{ name: "sdk-2.0.0.tgz", size: 2048, sha256: "a".repeat(64), role: "archive" }],
    },
    { version: "1.0.0", published: "2026-01-01T00:00:00Z", yanked: true, files: [] },
  ],
};

const shop: Credential = {
  project: "shop",
  kind: "read",
  roles: ["read"],
  auth: [
    {
      id: "3f9a1c0b7d2e",
      type: "key",
      scope: ["read"],
      created: "2026-10-28T09:00:00Z",
      expires: null,
    },
    {
      id: "a41d07e9c2b5",
      type: "key",
      scope: ["read"],
      created: "2026-06-01T08:30:00Z",
      expires: "2026-11-11T00:00:00Z",
    },
    {
      id: "c08e5b1f9a27",
      type: "gh",
      scope: ["read"],
      repository: "acme/shop",
      ref: null,
      workflow: null,
      repository_id: "123",
      repository_owner_id: null,
      environment: "release",
      created: "2026-06-01T08:30:00Z",
      expires: "2026-10-01T00:00:00Z",
    },
  ],
  grants: [{ eco: "composer", package: "acme/*", versions: "^1.0", transitive: false }],
  read_grants: [{ eco: "composer", package: "acme/*", versions: "^1.0", transitive: false }],
  publish_grants: [],
};

const root: Credential = {
  project: "root",
  kind: "admin",
  roles: ["admin"],
  auth: [
    {
      id: "0123456789ab",
      type: "key",
      scope: ["admin"],
      created: "2026-10-28T09:00:00Z",
      expires: null,
    },
  ],
  grants: [],
  read_grants: [],
  publish_grants: [],
};

function detail(credential: Credential, extra: Partial<CredentialPageData> = {}): string {
  return credentialPage(ctx, {
    credential,
    ecosystems: ["composer", "npm"],
    now: NOW,
    login: credential.project,
    ...extra,
  });
}

describe("helpers", () => {
  it("encodes API paths segment by segment", () => {
    expect(apiPath("packages", "npm", "@acme/sdk", "1.0.0")).toBe(
      "/api/v1/packages/npm/%40acme%2Fsdk/1.0.0",
    );
  });

  it("links credentials, keeping the project new apart from the create form", () => {
    expect(credentialHref("shop")).toBe("/admin/credentials/shop");
    expect(credentialHref("new")).toBe("/admin/credentials/%6Eew");
  });

  it("summarises the active secrets and the nearest expiry", () => {
    expect(secretSummary(shop, NOW)).toEqual({
      active: 2,
      nearestExpiry: "2026-11-11T00:00:00Z",
    });
    expect(secretSummary(root, NOW)).toEqual({ active: 1, nearestExpiry: null });
  });
});

describe("admin navigation", () => {
  it("links the admin sections and marks the current one", () => {
    const page = layout(ctx, "T", markup``, { section: "credentials" });
    expect(page).toContain(
      '<nav class="site-nav" aria-label="Administration"><a href="/admin/packages">Packages</a><a href="/admin/credentials" aria-current="page">Credentials</a><a href="/admin/settings">Settings</a></nav>',
    );
    expect(page).toContain('<a class="brand" href="/admin/packages">');
    expect(page).toContain('action="/logout"');
  });

  it("is shown to admins only", () => {
    const reader = { ...ctx, user: { project: "shop", kind: "read" as const } };
    expect(layout(reader, "T", markup``, { section: "packages" })).not.toContain("site-nav");
  });

  it("names the page for app.js", () => {
    expect(layout(ctx, "T", markup``, { page: "credential" })).toContain(
      '<body data-page="credential">',
    );
  });
});

describe("package list", () => {
  const page = adminPackagesPage(ctx, [npmSdk, { ...npmSdk, eco: "composer", name: "zeta/a" }]);

  it("is the sorted, filterable list with links to the package pages", () => {
    expect(page).toContain('aria-current="page">Packages</a>');
    expect(page).toContain("<h1>Packages</h1>");
    expect(page).toContain('<a class="pkg-link" href="/packages/npm/%40acme%2Fsdk">');
    expect(page.indexOf("%40acme%2Fsdk")).toBeLessThan(page.indexOf("zeta%2Fa"));
    expect(page).toContain("data-pkg-filter hidden");
    expect(page).toContain('<body data-page="packages">');
  });

  it("offers reindex and a typed delete at the end of each row", () => {
    expect(page).toContain('<li class="pkg-row with-actions"');
    expect(page).toContain(
      'data-api-method="POST" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk/reindex"',
    );
    expect(page).toMatch(
      /data-api-method="DELETE" data-api-url="\/api\/v1\/packages\/npm\/%40acme%2Fsdk" data-confirm="[^"]+" data-confirm-name="@acme\/sdk"/,
    );
    // Versions are managed on the package page.
    expect(page).not.toContain("/yank");
  });

  it("explains an empty registry", () => {
    expect(adminPackagesPage(ctx, [])).toContain("No packages have been published yet.");
  });
});

describe("package page for admins", () => {
  const page = packagePage(ctx, { view: npmSdk, snippets: [], admin: true });

  it("links back to the admin list", () => {
    expect(page).toContain('<li><a href="/admin/packages">Packages</a></li>');
    expect(page).toContain('<p class="back"><a href="/admin/packages">← All packages</a></p>');
  });

  it("offers yank and delete per version", () => {
    expect(page).toContain(
      'data-api-method="POST" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk/2.0.0/yank"',
    );
    expect(page).not.toContain("1.0.0/yank");
    expect(page).toContain(
      'data-api-method="DELETE" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk/1.0.0"',
    );
  });

  it("keeps the actions of every version in one aligned cell", () => {
    const cells = page.match(/<span class="row-actions version-actions"[^>]*>/g) ?? [];
    expect(cells).toHaveLength(npmSdk.versions.length);
    expect(cells[0]).toContain('role="group" aria-label="Actions"');
    // The yanked 1.0.0 keeps an invisible stand-in where "Yank" would be.
    expect(page).toContain(
      '<span class="button secondary small action-placeholder" aria-hidden="true">Yank</span><button type="button" class="danger small" data-api-method="DELETE" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk/1.0.0"',
    );
    expect(page.match(/action-placeholder/g)).toHaveLength(1);
  });

  it("goes back to the list after deleting the only version", () => {
    const one = packagePage(ctx, {
      view: { ...npmSdk, versions: npmSdk.versions.slice(0, 1) },
      snippets: [],
      admin: true,
    });
    expect(one).toMatch(
      /data-api-url="[^"]+\/2\.0\.0" data-confirm="[^"]+" data-api-next="\/admin\/packages"/,
    );
    expect(page).not.toMatch(/2\.0\.0" data-confirm="[^"]+" data-api-next/);
  });

  it("offers reindex and deleting the package by typing its name", () => {
    expect(page).toContain(
      'data-api-method="POST" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk/reindex"',
    );
    expect(page).toContain(
      '<form class="box danger-box" data-api-form="delete" data-api-method="DELETE" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk" data-confirm-name="@acme/sdk" data-api-next="/admin/packages">',
    );
    expect(page).toContain("Type <code>@acme/sdk</code> to confirm");
    expect(page).toContain('<button type="submit" class="danger" disabled>Delete package</button>');
  });

  it("shows no actions to consumers", () => {
    const reader = { ...ctx, user: { project: "shop", kind: "read" as const } };
    const out = packagePage(reader, { view: npmSdk, snippets: [] });
    expect(out).not.toContain("data-api");
    expect(out).not.toContain("Danger zone");
    expect(out).toContain('<li><a href="/">Packages</a></li>');
  });

  it("links the version page back to the admin list", () => {
    const out = versionPage(ctx, {
      eco: "npm",
      name: "@acme/sdk",
      version: "2.0.0",
      published: "2026-10-28T10:12:00Z",
      yanked: false,
      files: [],
    });
    expect(out).toContain('<li><a href="/admin/packages">Packages</a></li>');
  });
});

describe("credential list", () => {
  const page = credentialsPage(ctx, [shop, root], NOW);

  it("lists projects sorted, with kind, active secrets, nearest expiry and grants", () => {
    expect(page).toContain(
      '<tr data-pkg-row data-name="shop">\n<td><a class="row-link" href="/admin/credentials/shop">shop</a></td>\n<td><span class="badge kind" data-kind="read">read</span></td>\n<td class="num">2</td>\n<td class="nowrap"><time datetime="2026-11-11T00:00:00Z">2026-11-11</time></td>\n<td class="num">1</td>',
    );
    expect(page).toContain(
      '<td><span class="badge kind" data-kind="admin">admin</span></td>\n<td class="num">1</td>\n<td class="nowrap"><span class="hint">never</span></td>',
    );
    expect(page.indexOf("credentials/root")).toBeLessThan(page.indexOf("credentials/shop"));
  });

  it("has a filter and a prominent button to create a credential", () => {
    expect(page).toContain("data-pkg-filter hidden");
    expect(page).toContain("Filter by project");
    expect(page).toContain('<a class="button" href="/admin/credentials/new">New credential</a>');
    expect(page).toContain('<body data-page="credentials">');
  });
});

describe("new credential form", () => {
  const page = newCredentialPage(ctx, { ecosystems: ["composer", "npm"] });

  it("loads the script of the grants as text", () => {
    expect(page).toContain('<script src="/grants.js" defer></script>');
    expect(page).toContain("data-grants-toggle");
  });

  it("posts to the panel with project, kind and grants", () => {
    expect(page).toContain(
      '<form class="box form" method="post" action="/admin/credentials/new" data-credential-form>',
    );
    expect(page).toContain('name="project"');
    expect(page).toContain('<input type="radio" name="kind" id="kind-read" value="read" checked>');
    expect(page).toContain('<input type="radio" name="kind" id="kind-admin" value="admin">');
    expect(page).toContain('<template id="grant-row">');
    expect(page).toContain('<option value="npm">npm</option>');
    expect(page).toContain('<input type="hidden" name="grant" value="0" data-grant-key>');
    expect(page).toContain(
      '<input type="checkbox" name="grant_transitive" value="0" data-field="transitive" checked>',
    );
    expect(page).not.toContain("data-api-form");
  });

  it("explains the kinds", () => {
    expect(page).toContain("<dt>publish</dt><dd>Publishes new versions");
  });

  it("offers a password only for admin credentials", () => {
    expect(page).toContain(
      '<div data-password="kind:admin" hidden>\n<label>Password (optional, at least 12 characters) <input type="password" name="password" minlength="12" autocomplete="new-password" spellcheck="false" disabled></label>',
    );
    const admin = newCredentialPage(ctx, {
      ecosystems: ["composer"],
      values: { project: "ops", kind: "admin", grants: [] },
    });
    expect(admin).toContain('<div data-password="kind:admin">');
    expect(admin).toMatch(/<fieldset class="plain" data-grants[^>]* hidden>/);
  });

  it("shows the error and the values again", () => {
    const again = newCredentialPage(ctx, {
      ecosystems: ["composer", "npm"],
      error: "This credential already exists.",
      values: {
        project: '"><x',
        kind: "publish",
        grants: [{ eco: "npm", package: "@acme/*", versions: "^2", transitive: false }],
      },
    });
    expect(again).toContain('<p class="error" role="alert">This credential already exists.</p>');
    expect(again).toContain('value="&quot;&gt;&lt;x"');
    expect(again).toContain('value="publish" checked');
    expect(again).toContain('data-grants data-grant-kind="publish"');
    expect(again).toContain('<option value="npm" selected>npm</option>');
    expect(again).toContain('value="@acme/*"');
    expect(again).toContain(
      '<input type="checkbox" name="grant_transitive" value="0" data-field="transitive"> transitive',
    );
  });
});

describe("credential page", () => {
  const page = detail(shop);
  const grantsTab = detail(shop, { tab: "grants" });
  const secretsTab = detail(shop, { tab: "secrets" });
  const dangerTab = detail(shop, { tab: "danger" });

  it("shows one tab at a time under a tab bar, the overview by default", () => {
    expect(page).toContain(
      '<nav class="tabs" aria-label="Credential"><a href="/admin/credentials/shop?tab=overview" aria-current="page">Overview</a><a href="/admin/credentials/shop?tab=grants">Grants <span class="tab-count">1</span></a><a href="/admin/credentials/shop?tab=secrets">Secrets <span class="tab-count">3</span></a><a href="/admin/credentials/shop?tab=danger">Danger zone</a></nav>',
    );
    const headings = ["Overview</h2>", "Grants</h2>", "Secrets</h2>", "Danger zone</h2>"];
    const tabs = [page, grantsTab, secretsTab, dangerTab];
    tabs.forEach((tab, i) => {
      headings.forEach((h, j) => expect(tab.includes(h), `${i} ${h}`).toBe(i === j));
      expect(tab).toContain('<body data-page="credential">');
      expect(tab).toContain('<li><a href="/admin/credentials">Credentials</a></li>');
      expect(tab).toContain("<h1>shop ");
    });
    expect(grantsTab).toContain('href="/admin/credentials/shop?tab=grants" aria-current="page"');
    expect(dangerTab).toContain("<title>shop · Danger zone · packages.example.com</title>");
  });

  it("falls back to the overview for an unknown tab", () => {
    expect(credentialTab("secrets")).toBe("secrets");
    expect(credentialTab("nope")).toBe("overview");
    expect(credentialTab(null)).toBe("overview");
  });

  it("links the overview to the other tabs with their counts", () => {
    expect(page).toContain(
      '<li><a href="/admin/credentials/shop?tab=grants"><strong>1 grant</strong><span>Edit the grants</span></a></li>',
    );
    expect(page).toContain(
      '<li><a href="/admin/credentials/shop?tab=secrets"><strong>2 active of 3 secrets</strong>',
    );
    expect(page).toContain('href="/admin/credentials/shop?tab=secrets&amp;add=1"');
    expect(page).toContain(
      '<a href="/admin/credentials/shop?tab=danger"><strong>Danger zone</strong><span>Delete this credential</span>',
    );
    expect(detail(root)).toContain("<strong>No grants (admin)</strong>");
    expect(detail(root)).toContain('<a href="/admin/credentials/root?tab=grants">Grants</a>');
  });

  it("shows an overview of the credential", () => {
    expect(page).toContain("<div><dt>Login</dt><dd><code>shop</code></dd></div>");
    expect(page).toContain(
      '<div><dt>Created</dt><dd><time datetime="2026-06-01T08:30:00Z">2026-06-01</time></dd></div>',
    );
    expect(page).toContain("<div><dt>Active secrets</dt><dd>2 of 3</dd></div>");
    expect(page).toContain("<code>3f9a1c0b7d2e</code> <code>a41d07e9c2b5</code>");
  });

  it("edits the grants with prefilled rows", () => {
    expect(grantsTab).toContain(
      'data-api-form="grants" data-api-method="PATCH" data-api-url="/api/v1/credentials/shop"',
    );
    expect(grantsTab).toContain('value="acme/*"');
    expect(grantsTab).toContain('value="^1.0"');
    expect(grantsTab).toContain('<option value="composer" selected>Composer</option>');
    expect(grantsTab).toContain('<template id="grant-row">');
    expect(page).not.toContain('<template id="grant-row">');
    expect(grantsTab).toContain(
      '<fieldset class="plain" data-grants data-grant-kind="read" aria-labelledby="grants">',
    );
  });

  it("offers the grants as text, hidden until the script shows the toggle", () => {
    expect(grantsTab).toContain('<script src="/grants.js" defer></script>');
    expect(grantsTab).toContain("<div data-grants-text-pane hidden>");
    expect(grantsTab).toContain(
      '<button type="button" class="secondary small" data-grants-toggle hidden>',
    );
    expect(grantsTab).toContain("<code>eco:package[:versions[:transitive]]</code>");
    // The script is only loaded where grants are edited.
    expect(page).not.toContain("/grants.js");
    expect(secretsTab).not.toContain("/grants.js");
  });

  it("has no grants for admin credentials, but a password for their keys", () => {
    const out = detail(root, { tab: "grants" });
    expect(out).toContain("Admin credentials have no grants");
    expect(out).not.toContain('data-api-form="grants"');
    expect(detail(root, { tab: "secrets" })).toContain('<div data-password="type:key">');
    expect(secretsTab).not.toContain("data-password");
  });

  it("marks transitive so that it is hidden for publish grants", () => {
    const out = detail({ ...shop, project: "ci", kind: "publish" }, { tab: "grants" });
    expect(out).toContain('data-grants data-grant-kind="publish" aria-labelledby="grants"');
    expect(out).toContain("<span data-transitive> Transitive:");
  });

  it("lists the secrets with an expire action for active ones", () => {
    const page = secretsTab;
    expect(page).toContain(
      '<td class="nowrap" data-label="Expires"><time datetime="2026-11-11T00:00:00Z" title="2026-11-11T00:00:00Z">2026-11-11</time></td>',
    );
    // Every cell but the action names its column for the stacked cards of narrow screens.
    expect(page).toContain('<td data-label="ID"><code>3f9a1c0b7d2e</code></td>');
    expect(page).toContain(
      '<td class="nowrap secret-action"><form class="inline-form expire-form"',
    );
    expect(page).toContain('data-api-url="/api/v1/credentials/shop/secrets/3f9a1c0b7d2e"');
    // "Expire…" (shown by app.js) reveals the date and the confirm, shown inline without it.
    expect(page).toContain(
      '<button type="button" class="danger small" data-expire-open hidden>Expire…</button>\n<span class="expire-fields" data-expire-fields>\n<input type="date" name="expires" aria-label="Expire 3f9a1c0b7d2e on (empty: now)">\n<button type="submit" class="danger small">Expire</button>',
    );
    // The expired gh entry has no expire action.
    expect(page).not.toContain("/secrets/c08e5b1f9a27");
    expect(page).toContain('<span class="badge warn">expired</span>');
    expect(page).toContain(
      "<code>acme/shop</code> · ref any · workflow any · repository id <code>123</code> · environment <code>release</code>",
    );
  });

  it("adds secrets with a form post behind a collapsed button", () => {
    const page = secretsTab;
    expect(page).toContain(
      '<details class="add-secret" id="add-secret">\n<summary class="button"><span class="when-closed">Add a secret</span>',
    );
    expect(detail(shop, { tab: "secrets", addSecret: true })).toContain(
      '<details class="add-secret" id="add-secret" open>',
    );
    expect(page.indexOf('class="add-secret"')).toBeLessThan(
      page.indexOf('<table class="secrets">'),
    );
    expect(page).toContain(
      '<form class="box form" method="post" aria-label="Add a secret" action="/admin/credentials/shop/secrets" data-secret-form>',
    );
    expect(page).toContain('<input type="radio" name="type" id="type-key" value="key" checked>');
    expect(page).toContain("<div data-gh-fields hidden>");
    for (const field of [
      "repository",
      "repository_id",
      "repository_owner_id",
      "ref",
      "workflow",
      "environment",
      "expires",
    ]) {
      expect(page).toContain(`name="${field}"`);
    }
    expect(page).toContain("prefer the ref <code>refs/tags/v*</code> or a workflow");
    expect(page).toContain(
      '<button type="button" class="secondary small" data-gh-lookup>Look up</button>',
    );
    expect(page).toContain(
      '<label class="inline"><input type="checkbox" name="pin_on_first_use" checked> Pin repository ids on first use</label>',
    );
  });

  it("shows a refused secret form again with its error and values", () => {
    const out = detail(shop, {
      secretError: "`repository` must be owner/repo.",
      secretValues: {
        type: "gh",
        repository: "bad",
        repository_id: "",
        repository_owner_id: "",
        ref: "refs/tags/v*",
        workflow: "",
        environment: "",
        pin_on_first_use: false,
        expires: "2027-01-01",
      },
    });
    expect(out).toContain('<p class="error" role="alert">`repository` must be owner/repo.</p>');
    // The refused form is shown on the secrets tab, unfolded.
    expect(out).toContain('href="/admin/credentials/shop?tab=secrets" aria-current="page"');
    expect(out).toContain('<details class="add-secret" id="add-secret" open>');
    expect(out).toContain('value="gh" checked');
    expect(out).toContain("<div data-gh-fields>");
    expect(out).toContain(
      'name="repository" placeholder="owner/repo or owner/*" spellcheck="false" value="bad"',
    );
    expect(out).toContain('<input type="checkbox" name="pin_on_first_use"> Pin');
    expect(out).toContain('name="expires" value="2027-01-01"');
  });

  it("deletes the credential by typing its name, then opens the list", () => {
    expect(page).not.toContain('data-api-form="delete"');
    expect(dangerTab).toContain(
      'data-api-form="delete" data-api-method="DELETE" data-api-url="/api/v1/credentials/shop" data-confirm-name="shop" data-api-next="/admin/credentials"',
    );
  });

  it("posts the secrets of the project new past the create form", () => {
    expect(detail({ ...shop, project: "new" }, { tab: "secrets" })).toContain(
      'action="/admin/credentials/%6Eew/secrets"',
    );
  });

  it("shows every claim value of a gh secret in code style", () => {
    const out = detail(
      {
        ...shop,
        auth: [
          {
            id: "d19f2a6c4e80",
            type: "gh",
            scope: ["read"],
            repository: "acme/shop",
            ref: "refs/tags/v*",
            workflow: ".github/workflows/release.yml",
            repository_id: null,
            repository_owner_id: "42",
            environment: null,
            created: "2026-06-01T08:30:00Z",
            expires: null,
          },
        ],
      },
      { tab: "secrets" },
    );
    expect(out).toContain(
      "<code>acme/shop</code> · ref <code>refs/tags/v*</code> · workflow <code>.github/workflows/release.yml</code> · owner id <code>42</code>",
    );
  });

  it("notes the gh secrets that wait for their ids to be pinned", () => {
    const gh = shop.auth[2];
    if (gh?.type !== "gh") throw new Error("fixture");
    const waiting = { ...gh, repository_id: null, pin_on_first_use: true };
    expect(awaitsPin(waiting)).toBe(true);
    expect(awaitsPin({ ...waiting, repository_owner_id: "7" })).toBe(false);
    expect(awaitsPin({ ...waiting, pin_on_first_use: false })).toBe(false);
    expect(awaitsPin(gh)).toBe(false);
    const out = detail({ ...shop, auth: [{ ...waiting, expires: null }] }, { tab: "secrets" });
    expect(out).toContain(
      'environment <code>release</code> · <span class="hint nowrap">pinned on first use</span>',
    );
    expect(secretsTab).not.toContain("pinned on first use</span>");
  });

  it("escapes credential data", () => {
    const out = detail(
      { ...shop, grants: [{ eco: "npm", package: '"><script>', versions: "*", transitive: true }] },
      { tab: "grants" },
    );
    expect(out).toContain('value="&quot;&gt;&lt;script&gt;"');
    expect(out).not.toContain('"><script>');
  });
});

describe("settings page", () => {
  const setup = setupStatus({
    SESSION_SECRET: "x",
    S3_ENDPOINT: "https://r2.example",
    S3_ACCESS_KEY_ID: "id",
    S3_SECRET_ACCESS_KEY: "",
    ECOSYSTEMS: "composer,npm",
  });
  const page = settingsPage(ctx, {
    version: "1.0.0",
    minClientVersion: "0.1.0",
    schemaVersion: 1,
    setup,
    vars: [
      { name: "ECOSYSTEMS", value: "composer,npm", default: "composer,npm,cargo" },
      { name: "MAX_UPLOAD_BYTES", value: "", default: "536870912" },
      { name: "TOKEN_PREFIX", value: "", default: "" },
      { name: "PUBLIC_URL", value: "" },
    ],
  });

  it("shows the versions read-only", () => {
    expect(page).toContain('aria-current="page">Settings</a>');
    expect(page).toContain("<tr><th>Worker version</th><td>1.0.0</td></tr>");
    expect(page).toContain("<tr><th>Minimum CLI version</th><td>0.1.0</td></tr>");
    expect(page).toContain("<tr><th>Schema version</th><td>1</td></tr>");
    expect(page).not.toContain("data-api");
  });

  it("lists every setting with its status, and plain values with defaults for unset ones", () => {
    expect(page).toContain('<h2 id="setup">Setup</h2>');
    expect(page.match(/class="setup-item"/g)).toHaveLength(setup.length);
    expect(page).toContain(
      '<code class="setup-name">ECOSYSTEMS</code> <span class="status" data-status="set">Set</span>',
    );
    expect(page).toContain("Value: <code>composer,npm</code>");
    expect(page).toContain(
      '<code class="setup-name">MAX_UPLOAD_BYTES</code> <span class="status" data-status="default">Default</span>',
    );
    expect(page).toContain('Value: <code>536870912</code> <span class="hint">(default)</span>');
    expect(page).toContain('Value: <span class="hint">empty (default)</span>');
    expect(page).toContain(
      '<code class="setup-name">S3_SECRET_ACCESS_KEY</code> <span class="status" data-status="missing">Missing</span>',
    );
    expect(page).toContain('href="/admin/settings">Check again</a>');
  });

  it("explains how to add what is missing", () => {
    expect(page).toContain("<pre><code>npx wrangler secret put S3_SECRET_ACCESS_KEY</code></pre>");
    expect(page).toContain("deployment.md#r2-api-token-s3_");
    expect(page).toContain("Wrangler has no command for dashboard variables.");
    // The present SESSION_SECRET needs no generator.
    expect(page).not.toContain("data-secret-gen");
  });
});

describe("admin page width", () => {
  it("is the same wide column on every admin page, so the left edge does not move", () => {
    const pages = [
      adminPackagesPage(ctx, [npmSdk]),
      credentialsPage(ctx, [shop, root], NOW),
      newCredentialPage(ctx, { ecosystems: ["composer"] }),
      detail(shop),
      settingsPage(ctx, {
        version: "1.0.0",
        minClientVersion: "0.1.0",
        schemaVersion: 1,
        setup: [],
        vars: [],
      }),
    ];
    for (const page of pages) expect(page).toContain('<main>\n<div class="catalog wide">');
  });
});
