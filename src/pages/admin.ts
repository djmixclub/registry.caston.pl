/**
 * The admin view (kind `admin`), rendered with its initial data: the tabs "Packages" (yank,
 * delete a version, reindex, delete a package), "Credentials" (list, create, edit grants, add
 * and expire secrets, delete) and "Settings" (read-only). Every mutation is a `fetch` to
 * `/api/v1` made by `public/app.js` from the `data-api-*` attributes rendered here, followed by
 * a reload of the page.
 */

import type { Eco } from "../adapters/types";
import type { AuthEntry, Credential } from "../core/auth";
import type { Grant } from "../core/grants";
import type { PackageView } from "../core/packages";
import { updateStatus, type LatestRelease } from "../core/updates";
import { attr, copyBlock } from "./components";
import { day, ECO_NAMES } from "./consumer";
import { markup, type SafeHtml } from "./html";
import { layout, type PageContext } from "./layout";
import { SLUG_PATTERN } from "./firstRun";

/** The tabs of the admin view, in display order. */
export const ADMIN_TABS = ["packages", "credentials", "settings"] as const;

export type AdminTab = (typeof ADMIN_TABS)[number];

const TAB_TITLES: Readonly<Record<AdminTab, string>> = {
  packages: "Packages",
  credentials: "Credentials",
  settings: "Settings",
};

/** The tab named by a `?tab=` value; `packages` for anything else. */
export function adminTab(value: string | null): AdminTab {
  return (ADMIN_TABS as readonly string[]).includes(value ?? "") ? (value as AdminTab) : "packages";
}

/** One read-only setting. */
export interface Setting {
  name: string;
  value: string;
}

/** The data of the Settings tab. */
export interface AdminSettings {
  version: string;
  minClientVersion: string;
  schemaVersion: number;
  /** Worker variables, shown as they are configured. */
  vars: Setting[];
  /**
   * The update check, present when `CHECK_UPDATES` is `true`: the latest release, or `null`
   * when the check failed.
   */
  update?: { release: LatestRelease | null };
}

/** The data of the admin view; only the selected tab's data is needed. */
export type AdminData =
  | { tab: "packages"; packages: PackageView[] }
  | { tab: "credentials"; credentials: Credential[]; ecosystems: Eco[]; now: Date }
  | { tab: "settings"; settings: AdminSettings };

/** An `/api/v1` path with every segment percent-encoded (docs/api.md 1.3). */
export function apiPath(...segments: string[]): string {
  return `/api/v1/${segments.map(encodeURIComponent).join("/")}`;
}

/** A button that `app.js` turns into an API call, after a confirmation. */
function apiButton(
  label: string,
  method: string,
  url: string,
  confirm: { message: string; typeName?: string },
  style = "secondary small",
): SafeHtml {
  const typed =
    confirm.typeName === undefined ? "" : markup` data-confirm-name="${confirm.typeName}"`;
  return markup`<button type="button" class="${style}" data-api-method="${method}" data-api-url="${url}" data-confirm="${confirm.message}"${typed}>${label}</button>`;
}

function tabs(current: AdminTab): SafeHtml {
  const links = ADMIN_TABS.map(
    (tab) =>
      markup`<a href="/?tab=${tab}"${tab === current ? markup` aria-current="page"` : ""}>${TAB_TITLES[tab]}</a>`,
  );
  return markup`<nav class="tabs" aria-label="Panel">${links}</nav>`;
}

// ---------------------------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------------------------

function versionRow(view: PackageView, v: PackageView["versions"][number]): SafeHtml {
  const base = ["packages", view.eco, view.name, v.version];
  const label = `${view.name} ${v.version}`;
  const yank = v.yanked
    ? ""
    : apiButton("Yank", "POST", `${apiPath(...base)}/yank`, {
        message: `Yank ${label}? It disappears from the indexes; lockfiles keep working.`,
      });
  const remove = apiButton(
    "Delete",
    "DELETE",
    apiPath(...base),
    { message: `Delete ${label} and its files? Lockfiles that use it stop working.` },
    "danger small",
  );
  const size = v.files.reduce((sum, f) => sum + f.size, 0);
  return markup`<tr>
<td><code>${v.version}</code>${v.yanked ? markup` <span class="badge warn">yanked</span>` : ""}</td>
<td><time datetime="${v.published}">${day(v.published)}</time></td>
<td>${v.files.length} (${formatBytes(size)})</td>
<td class="actions">${yank} ${remove}</td>
</tr>`;
}

/** A byte count for people: `512 B`, `1.5 KiB`, `3.0 MiB`. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} ${units[0]}` : `${value.toFixed(1)} ${units[unit]}`;
}

function packageCard(view: PackageView): SafeHtml {
  const reindex = apiButton(
    "Reindex",
    "POST",
    `${apiPath("packages", view.eco, view.name)}/reindex`,
    {
      message: `Rebuild the index of ${view.name} from its manifests?`,
    },
  );
  const remove = apiButton(
    "Delete package",
    "DELETE",
    apiPath("packages", view.eco, view.name),
    {
      message: `Type ${view.name} to delete the package with all its versions.`,
      typeName: view.name,
    },
    "danger small",
  );
  return markup`<article class="package">
<div class="package-head">
<h3><span class="badge">${ECO_NAMES[view.eco]}</span> ${view.name}</h3>
<div class="actions">${reindex} ${remove}</div>
</div>
<div class="table-wrap"><table>
<thead><tr><th>Version</th><th>Published</th><th>Files</th><th>Actions</th></tr></thead>
<tbody>${view.versions.map((v) => versionRow(view, v))}</tbody>
</table></div>
</article>`;
}

function packagesTab(packages: readonly PackageView[]): SafeHtml {
  const content =
    packages.length === 0
      ? markup`<p class="hint">No packages have been published yet.</p>`
      : packages.map(packageCard);
  return markup`<section class="card">
<h2>Packages</h2>
${content}
</section>`;
}

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

function isActiveAt(entry: Pick<AuthEntry, "expires">, now: Date): boolean {
  if (entry.expires === null) return true;
  const expires = Date.parse(entry.expires);
  return !Number.isNaN(expires) && expires > now.getTime();
}

/** The number of active auth entries and the nearest `expires` among them (`null` = never). */
export function secretSummary(
  credential: Pick<Credential, "auth">,
  now: Date,
): { active: number; nearestExpiry: string | null } {
  const active = credential.auth.filter((e) => isActiveAt(e, now));
  const expiries = active
    .map((e) => e.expires)
    .filter((e): e is string => e !== null)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return { active: active.length, nearestExpiry: expiries[0] ?? null };
}

function grantRow(ecosystems: readonly Eco[], grant?: Grant): SafeHtml {
  const options = ecosystems.map(
    (eco) =>
      markup`<option value="${eco}"${attr("selected", grant?.eco === eco)}>${ECO_NAMES[eco]}</option>`,
  );
  const transitive = grant === undefined || grant.transitive !== false;
  return markup`<div class="grant-row" data-grant-row>
<select data-field="eco" aria-label="Ecosystem">${options}</select>
<input type="text" data-field="package" aria-label="Package" placeholder="acme/* or a package name" spellcheck="false" value="${grant?.package ?? ""}">
<input type="text" data-field="versions" aria-label="Versions" placeholder="*" spellcheck="false" value="${grant?.versions ?? "*"}">
<label class="inline"><input type="checkbox" data-field="transitive"${attr("checked", transitive)}> transitive</label>
<button type="button" class="danger small" data-remove-grant>Remove</button>
</div>`;
}

function grantsFieldset(ecosystems: readonly Eco[], grants: readonly Grant[]): SafeHtml {
  return markup`<fieldset data-grants>
<legend>Grants</legend>
<p class="hint">Package: an exact name or a pattern ending in <code>*</code>. Versions: a constraint in the ecosystem's syntax, <code>*</code> for all. Transitive (read only): also open the package's dependencies in this registry.</p>
<div data-grant-rows>${grants.map((g) => grantRow(ecosystems, g))}</div>
<button type="button" class="secondary small" data-add-grant>Add grant</button>
</fieldset>`;
}

const FORM_ERROR = markup`<p class="error" role="alert" data-form-error hidden></p>`;

function createForm(ecosystems: readonly Eco[]): SafeHtml {
  const kinds = (["read", "publish", "admin"] as const).map(
    (kind) =>
      markup`<label><input type="radio" name="kind" value="${kind}"${attr("checked", kind === "read")}> ${kind}</label>`,
  );
  return markup`<section class="card">
<h2>Create a credential</h2>
<form data-api-form="credential" data-api-method="POST" data-api-url="/api/v1/credentials">
<label>Project <input type="text" name="project" required pattern="${SLUG_PATTERN}" autocomplete="off" spellcheck="false"></label>
<fieldset data-kind>
<legend>Kind</legend>
${kinds}
</fieldset>
${grantsFieldset(ecosystems, [{ eco: ecosystems[0] ?? "composer", package: "", versions: "*", transitive: true }])}
${FORM_ERROR}
<button type="submit">Create credential</button>
</form>
</section>`;
}

function secretDetails(entry: AuthEntry): SafeHtml {
  if (entry.type === "key") return markup`static key`;
  const optional: [string, string | null | undefined][] = [
    ["repository id", entry.repository_id],
    ["owner id", entry.repository_owner_id],
    ["environment", entry.environment],
  ];
  const extra = optional
    .filter((pair): pair is [string, string] => typeof pair[1] === "string")
    .map(([label, value]) => markup` · ${label} <code>${value}</code>`);
  return markup`<code>${entry.repository}</code> · ref ${entry.ref ?? "any"} · workflow ${entry.workflow ?? "any"}${extra}`;
}

function secretRow(project: string, entry: AuthEntry, now: Date): SafeHtml {
  const active = isActiveAt(entry, now);
  const expires =
    entry.expires === null
      ? "never"
      : markup`<time datetime="${entry.expires}">${entry.expires}</time>`;
  const action = active
    ? markup`<form class="inline-form" data-api-form="expire" data-api-method="DELETE" data-api-url="${apiPath("credentials", project, "secrets", entry.id)}" data-confirm="Expire the secret ${entry.id} of ${project}?">
<input type="date" name="expires" aria-label="Expire on (empty: now)">
<button type="submit" class="danger small">Expire</button>
</form>`
    : markup`<span class="badge warn">expired</span>`;
  return markup`<tr>
<td><code>${entry.id}</code></td>
<td>${entry.type}</td>
<td>${secretDetails(entry)}</td>
<td>${day(entry.created)}</td>
<td>${expires}</td>
<td>${action}</td>
</tr>`;
}

function secretForm(project: string): SafeHtml {
  return markup`<form data-api-form="secret" data-api-method="POST" data-api-url="${apiPath("credentials", project, "secrets")}">
<h3>Add a secret</h3>
<fieldset data-secret-type>
<legend>Type</legend>
<label><input type="radio" name="type" value="key" checked> key (a new token, shown once)</label>
<label><input type="radio" name="type" value="gh"> gh (GitHub Actions OIDC)</label>
</fieldset>
<div data-gh-fields hidden>
<label>Repository <input type="text" name="repository" placeholder="owner/repo or owner/*" spellcheck="false"></label>
<label>Repository ID (optional) <input type="text" name="repository_id" inputmode="numeric" pattern="[0-9]+" spellcheck="false"></label>
<label>Repository owner ID (optional) <input type="text" name="repository_owner_id" inputmode="numeric" pattern="[0-9]+" spellcheck="false"></label>
<label>Ref (optional glob, empty: any) <input type="text" name="ref" placeholder="refs/tags/v*" spellcheck="false"></label>
<label>Workflow (optional path in the repository, empty: any) <input type="text" name="workflow" placeholder=".github/workflows/release.yml" spellcheck="false"></label>
<label>Environment (optional, empty: any) <input type="text" name="environment" spellcheck="false"></label>
<p class="hint">For <code>publish</code> credentials prefer the ref <code>refs/tags/v*</code> or a workflow, so that only the release workflow can publish.</p>
</div>
<label>Expires (empty: never) <input type="date" name="expires"></label>
${FORM_ERROR}
<button type="submit" class="secondary">Add secret</button>
</form>`;
}

function credentialCard(credential: Credential, ecosystems: readonly Eco[], now: Date): SafeHtml {
  const { project, kind } = credential;
  const grants =
    kind === "admin"
      ? markup`<p class="hint">Admin credentials have no grants.</p>`
      : markup`<form data-api-form="grants" data-api-method="PATCH" data-api-url="${apiPath("credentials", project)}">
${grantsFieldset(ecosystems, credential.grants)}
${FORM_ERROR}
<button type="submit" class="secondary">Save grants</button>
</form>`;
  const remove = apiButton(
    "Delete project",
    "DELETE",
    apiPath("credentials", project),
    { message: `Delete the credential ${project}? All its tokens stop working.` },
    "danger",
  );
  return markup`<details class="card credential" id="credential-${project}">
<summary><strong>${project}</strong> <span class="badge">${kind}</span></summary>
<h3>Grants</h3>
${grants}
<h3>Secrets</h3>
<div class="table-wrap"><table>
<thead><tr><th>ID</th><th>Type</th><th>Details</th><th>Created</th><th>Expires</th><th></th></tr></thead>
<tbody>${credential.auth.map((e) => secretRow(project, e, now))}</tbody>
</table></div>
${secretForm(project)}
<h3>Delete</h3>
${remove}
</details>`;
}

function credentialsTab(
  credentials: readonly Credential[],
  ecosystems: readonly Eco[],
  now: Date,
): SafeHtml {
  const rows = credentials.map((c) => {
    const { active, nearestExpiry } = secretSummary(c, now);
    return markup`<tr>
<td><a href="#credential-${c.project}">${c.project}</a></td>
<td>${c.kind}</td>
<td>${active}</td>
<td>${nearestExpiry === null ? "never" : day(nearestExpiry)}</td>
</tr>`;
  });
  return markup`<section class="card">
<h2>Credentials</h2>
<div class="table-wrap"><table>
<thead><tr><th>Project</th><th>Kind</th><th>Active secrets</th><th>Nearest expiry</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
</section>
${createForm(ecosystems)}
${credentials.map((c) => credentialCard(c, ecosystems, now))}
<template id="grant-row">${grantRow(ecosystems)}</template>
<dialog class="card" data-token-dialog>
<h2>New token</h2>
<p>This token is shown <strong>only once</strong>. Copy it now.</p>
${copyBlock("")}
<button type="button" data-reload>Done</button>
</dialog>`;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

/** The result of the update check, compared by semver with the running version. */
export function updateLine(version: string, release: LatestRelease | null): SafeHtml {
  if (release === null) {
    return markup`Could not check for new releases; the check is retried within an hour.`;
  }
  const link = markup`<a href="${release.url}" rel="noreferrer">${release.tag}</a>`;
  switch (updateStatus(release.tag, version)) {
    case "available":
      return markup`<span class="badge warn">update</span> New release ${link} is available.`;
    case "current":
      return markup`Up to date (latest release ${link}).`;
    case "unknown":
      return markup`Latest release: ${link}.`;
  }
}

function settingsTab(settings: AdminSettings): SafeHtml {
  const rows: [string, SafeHtml | string][] = [
    ["Worker version", settings.version],
    ["Minimum CLI version", settings.minClientVersion],
    ["Schema version", String(settings.schemaVersion)],
  ];
  const vars = settings.vars.map(
    (v) =>
      markup`<tr><th><code>${v.name}</code></th><td>${v.value === "" ? markup`<span class="hint">not set</span>` : markup`<code>${v.value}</code>`}</td></tr>`,
  );
  return markup`<section class="card">
<h2>Settings</h2>
<div class="table-wrap"><table>
<tbody>${rows.map(([name, value]) => markup`<tr><th>${name}</th><td>${value}</td></tr>`)}</tbody>
</table></div>
${settings.update === undefined ? "" : markup`<p class="update">${updateLine(settings.version, settings.update.release)}</p>`}
<h3>Variables</h3>
<p class="hint">Change these in the Cloudflare dashboard (Worker settings), not in the repository.</p>
<div class="table-wrap"><table>
<tbody>${vars}</tbody>
</table></div>
</section>`;
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

function tabContent(data: AdminData): SafeHtml {
  switch (data.tab) {
    case "packages":
      return packagesTab(data.packages);
    case "credentials":
      return credentialsTab(data.credentials, data.ecosystems, data.now);
    case "settings":
      return settingsTab(data.settings);
  }
}

/** The admin view with the selected tab. */
export function adminPage(ctx: PageContext, data: AdminData): string {
  return layout(
    ctx,
    TAB_TITLES[data.tab],
    markup`${tabs(data.tab)}
${tabContent(data)}`,
  );
}
