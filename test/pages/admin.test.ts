import { describe, expect, it } from "vitest";
import type { Credential } from "../../src/core/auth";
import type { PackageView } from "../../src/core/packages";
import {
  adminPage,
  adminTab,
  apiPath,
  awaitsPin,
  formatBytes,
  secretSummary,
} from "../../src/pages/admin";

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
  auth: [
    { id: "3f9a1c0b7d2e", type: "key", created: "2026-10-28T09:00:00Z", expires: null },
    {
      id: "a41d07e9c2b5",
      type: "key",
      created: "2026-06-01T08:30:00Z",
      expires: "2026-11-11T00:00:00Z",
    },
    {
      id: "c08e5b1f9a27",
      type: "gh",
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
};

const root: Credential = {
  project: "root",
  kind: "admin",
  auth: [{ id: "0123456789ab", type: "key", created: "2026-10-28T09:00:00Z", expires: null }],
  grants: [],
};

describe("helpers", () => {
  it("picks the tab", () => {
    expect(adminTab("credentials")).toBe("credentials");
    expect(adminTab("settings")).toBe("settings");
    expect(adminTab(null)).toBe("packages");
    expect(adminTab("<x>")).toBe("packages");
  });

  it("encodes API paths segment by segment", () => {
    expect(apiPath("packages", "npm", "@acme/sdk", "1.0.0")).toBe(
      "/api/v1/packages/npm/%40acme%2Fsdk/1.0.0",
    );
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
  });

  it("summarises the active secrets and the nearest expiry", () => {
    expect(secretSummary(shop, NOW)).toEqual({
      active: 2,
      nearestExpiry: "2026-11-11T00:00:00Z",
    });
    expect(secretSummary(root, NOW)).toEqual({ active: 1, nearestExpiry: null });
  });
});

describe("packages tab", () => {
  const page = adminPage(ctx, { tab: "packages", packages: [npmSdk] });

  it("marks the current tab", () => {
    expect(page).toContain('<a href="/?tab=packages" aria-current="page">Packages</a>');
    expect(page).toContain('<a href="/?tab=credentials">Credentials</a>');
  });

  it("offers yank, delete and reindex with confirmations", () => {
    expect(page).toContain(
      'data-api-method="POST" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk/2.0.0/yank"',
    );
    expect(page).not.toContain("1.0.0/yank");
    expect(page).toContain('<span class="badge warn">yanked</span>');
    expect(page).toContain(
      'data-api-method="DELETE" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk/1.0.0"',
    );
    expect(page).toContain(
      'data-api-method="POST" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk/reindex"',
    );
    expect(page).toContain("1 (2.0 KiB)");
  });

  it("gives every package table the same fixed columns", () => {
    const two = adminPage(ctx, { tab: "packages", packages: [npmSdk, { ...npmSdk, name: "x" }] });
    expect(two.match(/<table class="version-table">/g)).toHaveLength(2);
  });

  it("asks to type the name before deleting a package", () => {
    expect(page).toMatch(
      /data-api-method="DELETE" data-api-url="\/api\/v1\/packages\/npm\/%40acme%2Fsdk" data-confirm="[^"]+" data-confirm-name="@acme\/sdk"/,
    );
  });

  it("explains an empty registry", () => {
    expect(adminPage(ctx, { tab: "packages", packages: [] })).toContain(
      "No packages have been published yet.",
    );
  });
});

describe("credentials tab", () => {
  const page = adminPage(ctx, {
    tab: "credentials",
    credentials: [root, shop],
    ecosystems: ["composer", "npm"],
    now: NOW,
  });

  it("lists projects with active secrets and the nearest expiry", () => {
    expect(page).toContain(
      '<td><a href="#credential-shop">shop</a></td>\n<td>read</td>\n<td>2</td>\n<td>2026-11-11</td>',
    );
    expect(page).toContain(
      '<td><a href="#credential-root">root</a></td>\n<td>admin</td>\n<td>1</td>\n<td>never</td>',
    );
  });

  it("has a create form whose grants are hidden for admin by app.js", () => {
    expect(page).toContain(
      'data-api-form="credential" data-api-method="POST" data-api-url="/api/v1/credentials"',
    );
    expect(page).toContain('<input type="radio" name="kind" value="read" checked>');
    expect(page).toContain('<input type="radio" name="kind" value="admin">');
    expect(page).toContain('<template id="grant-row">');
    expect(page).toContain('<option value="npm">npm</option>');
  });

  it("edits the grants of non-admin credentials with prefilled rows", () => {
    expect(page).toContain(
      'data-api-form="grants" data-api-method="PATCH" data-api-url="/api/v1/credentials/shop"',
    );
    expect(page).toContain('value="acme/*"');
    expect(page).toContain('value="^1.0"');
    expect(page).toContain('<option value="composer" selected>Composer</option>');
    expect(page).not.toContain('data-api-url="/api/v1/credentials/root" data-api-form');
    expect(page).toContain("Admin credentials have no grants.");
  });

  it("names the grants of a credential once", () => {
    const card = page.slice(page.indexOf('id="credential-shop"'));
    expect(card).toContain('<h3 id="grants-shop">Grants</h3>');
    expect(card).toContain(
      '<fieldset class="plain" data-grants data-grant-kind="read" aria-labelledby="grants-shop">',
    );
    expect(card.slice(0, card.indexOf("</details>"))).not.toContain("<legend>Grants</legend>");
    // The create form has no heading of its own and keeps its legend.
    expect(page).toContain(
      '<fieldset data-grants data-grant-kind="read">\n<legend>Grants</legend>',
    );
  });

  it("offers a password only for admin credentials", () => {
    // The create form shows it while the kind is admin (app.js), so it starts hidden.
    expect(page).toContain(
      '<div data-password="kind:admin" hidden>\n<label>Password (optional, at least 12 characters) <input type="password" name="password" minlength="12" autocomplete="new-password" spellcheck="false" disabled></label>',
    );
    const card = (project: string) => {
      const start = page.indexOf(`id="credential-${project}"`);
      return page.slice(start, page.indexOf("</details>", start));
    };
    expect(card("root")).toContain('<div data-password="type:key">');
    expect(card("root")).toContain('name="password_repeat"');
    expect(card("shop")).not.toContain("data-password");
  });

  it("marks transitive so that it is hidden for publish grants", () => {
    const ci: Credential = { ...shop, project: "ci", kind: "publish" };
    const out = adminPage(ctx, {
      tab: "credentials",
      credentials: [ci],
      ecosystems: ["composer"],
      now: NOW,
    });
    expect(out).toContain('data-grants data-grant-kind="publish" aria-labelledby="grants-ci"');
    expect(out).toContain(
      '<label class="inline" data-transitive><input type="checkbox" data-field="transitive">',
    );
    expect(out).toContain("<span data-transitive> Transitive:");
  });

  it("adds and expires secrets and deletes projects", () => {
    expect(page).toContain('data-api-url="/api/v1/credentials/shop/secrets"');
    expect(page).toContain('data-api-url="/api/v1/credentials/shop/secrets/3f9a1c0b7d2e"');
    // The expired gh entry has no expire action.
    expect(page).not.toContain("/secrets/c08e5b1f9a27");
    // Dates keep to one line; the details column takes the remaining width.
    expect(page).toContain('<table class="secrets-table">');
    expect(page).toContain('<td class="nowrap">2026-06-01</td>');
    expect(page).toContain('<td class="secret-details">static key</td>');
    expect(page).toContain(
      "<code>acme/shop</code> · ref any · workflow any · repository id <code>123</code> · environment <code>release</code>",
    );
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
    expect(page).toContain('<input type="radio" name="type" value="key" checked>');
    expect(page).toContain(
      'data-api-method="DELETE" data-api-url="/api/v1/credentials/shop" data-confirm=',
    );
    expect(page).toContain("data-token-dialog");
  });

  it("shows every claim value of a gh secret in code style", () => {
    const pinned: Credential = {
      ...shop,
      auth: [
        {
          id: "d19f2a6c4e80",
          type: "gh",
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
    };
    const out = adminPage(ctx, {
      tab: "credentials",
      credentials: [pinned],
      ecosystems: ["composer"],
      now: NOW,
    });
    expect(out).toContain(
      "<code>acme/shop</code> · ref <code>refs/tags/v*</code> · workflow <code>.github/workflows/release.yml</code> · owner id <code>42</code>",
    );
  });

  it("offers pinning the repository ids on first use, checked by default", () => {
    expect(page).toContain(
      '<label class="inline"><input type="checkbox" name="pin_on_first_use" checked> Pin repository ids on first use</label>',
    );
    expect(page).toContain(
      "When the ids are left empty, the first token that matches by name stores the repository id and owner id, and later tokens must match them.",
    );
  });

  it("notes the gh secrets that wait for their ids to be pinned", () => {
    const gh = shop.auth[2];
    if (gh?.type !== "gh") throw new Error("fixture");
    const waiting = { ...gh, repository_id: null, pin_on_first_use: true };
    expect(awaitsPin(waiting)).toBe(true);
    expect(awaitsPin({ ...waiting, repository_owner_id: "7" })).toBe(false);
    const unpinned = { ...waiting, pin_on_first_use: false };
    expect(awaitsPin(unpinned)).toBe(false);
    expect(awaitsPin(gh)).toBe(false);
    const out = adminPage(ctx, {
      tab: "credentials",
      credentials: [{ ...shop, auth: [{ ...waiting, expires: null }] }],
      ecosystems: ["composer"],
      now: NOW,
    });
    expect(out).toContain(
      'environment <code>release</code> · <span class="hint nowrap">pinned on first use</span>',
    );
    expect(page).not.toContain("pinned on first use</span>");
  });

  it("escapes credential data", () => {
    const evil: Credential = {
      ...shop,
      grants: [{ eco: "npm", package: '"><script>', versions: "*", transitive: true }],
    };
    const out = adminPage(ctx, {
      tab: "credentials",
      credentials: [evil],
      ecosystems: ["npm"],
      now: NOW,
    });
    expect(out).toContain('value="&quot;&gt;&lt;script&gt;"');
    expect(out).not.toContain('"><script>');
  });
});

describe("settings tab", () => {
  it("shows the versions and the variables read-only, with defaults for unset ones", () => {
    const page = adminPage(ctx, {
      tab: "settings",
      settings: {
        version: "1.0.0",
        minClientVersion: "0.1.0",
        schemaVersion: 1,
        vars: [
          { name: "ECOSYSTEMS", value: "composer,npm", default: "composer,npm,cargo" },
          { name: "MAX_UPLOAD_BYTES", value: "", default: "536870912" },
          { name: "TOKEN_PREFIX", value: "", default: "" },
          { name: "SOMETHING", value: "" },
        ],
      },
    });
    expect(page).toContain("<tr><th>Worker version</th><td>1.0.0</td></tr>");
    expect(page).toContain("<tr><th>Minimum CLI version</th><td>0.1.0</td></tr>");
    expect(page).toContain("<tr><th>Schema version</th><td>1</td></tr>");
    expect(page).toContain("<th><code>ECOSYSTEMS</code></th><td><code>composer,npm</code></td>");
    expect(page).toContain(
      '<th><code>MAX_UPLOAD_BYTES</code></th><td><code>536870912</code> <span class="hint">(default)</span>',
    );
    expect(page).toContain(
      '<th><code>TOKEN_PREFIX</code></th><td><span class="hint">empty (default)</span>',
    );
    expect(page).toContain('<th><code>SOMETHING</code></th><td><span class="hint">not set</span>');
    expect(page).not.toContain("data-api");
  });
});
