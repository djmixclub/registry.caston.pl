/**
 * The credential pages (kind `admin`): the list (`GET /admin/credentials`), the create form
 * (`GET /admin/credentials/new`, posted to the same path) and one credential
 * (`GET /admin/credentials/<project>`) in server-rendered tabs (`?tab=`): the overview, the
 * grants, the secrets with the collapsed "add a secret" form (posted to `…/secrets`) and the
 * danger zone. Creating a credential or a `key` secret answers with the one-time token page
 * (`src/pages/token.ts`); editing grants, expiring a secret and deleting the credential are
 * `fetch` calls to `/api/v1` made by `public/app.js`.
 */

import type { Eco } from "../adapters/types";
import type { AuthEntry, Credential, Kind } from "../core/auth";
import type { Grant } from "../core/grants";
import { apiPath, awaitsPin, credentialHref, dangerZone, isActiveAt, secretSummary } from "./admin";
import { breadcrumbs, day, ECO_NAMES, plural } from "./catalog";
import { attr, errorMessage, passwordFields, segmented } from "./components";
import { SLUG_PATTERN } from "./firstRun";
import { markup, type SafeHtml } from "./html";
import { layout, type PageContext } from "./layout";

/** The roles that carry grants. */
export type GrantRole = "read" | "publish";

export const GRANT_ROLES: readonly GrantRole[] = ["read", "publish"];

/** What the create form's kind switch offers: one role, both, or `admin`. */
export type CreateKind = GrantRole | "both" | "admin";

/** The roles a kind of the create form stands for. */
export function rolesOfKind(kind: CreateKind): Kind[] {
  return kind === "both" ? ["read", "publish"] : [kind];
}

/** What each kind of credential may do, shown with the kind switch of the create form. */
export const KIND_HELP: Readonly<Record<CreateKind, string>> = {
  read: "Installs packages: sees the packages of its grants and, for transitive grants, their dependencies in this registry.",
  publish:
    "Publishes new versions of the packages of its grants, usually from CI. It cannot install or list packages.",
  both: "Both roles with separate grants. Every secret is limited to read, publish or both, so a token committed to a consumer's repository can stay read-only.",
  admin: "Manages packages and credentials in this panel and through the API. It has no grants.",
};

/** The values of the create form, kept when it is shown again after an error. */
export interface CredentialFormValues {
  project: string;
  kind: CreateKind;
  /** The grants of each role; only the roles of `kind` are sent. */
  grants: Record<GrantRole, Grant[]>;
  /** The scope chosen for the first token of a credential with both roles. */
  scope: GrantRole[];
}

/** The values of the "add a secret" form, kept when it is shown again after an error. */
export interface SecretFormValues {
  type: "key" | "gh";
  /** The roles the secret may use; asked only when the credential holds both. */
  scope: GrantRole[];
  repository: string;
  repository_id: string;
  repository_owner_id: string;
  ref: string;
  workflow: string;
  environment: string;
  pin_on_first_use: boolean;
  expires: string;
}

const NEW_GRANT: Grant = { eco: "composer", package: "", versions: "*", transitive: true };

/** The script of the text view of the grants (`public/grants.js`), loaded where grants are edited. */
const GRANTS_SCRIPT = "/grants.js";

const FORM_ERROR = markup`<p class="error" role="alert" data-form-error hidden></p>`;

// ---------------------------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------------------------

/**
 * One grant row. Its fields carry `name`s for the create form, which is posted as is: every
 * row sends `grant` (its key), `grant_eco`, `grant_package` and `grant_versions`, and a ticked
 * `grant_transitive` sends the row's key, so an unticked box (which sends nothing) still pairs
 * with its row. `data-field` names the same fields for the JSON that `app.js` builds when the
 * grants of a credential are saved. The template row has an empty key; `app.js` gives every
 * added row a fresh one.
 */
export function grantRow(
  ecosystems: readonly Eco[],
  grant?: Grant,
  key = "",
  prefix = "",
): SafeHtml {
  const options = ecosystems.map(
    (eco) =>
      markup`<option value="${eco}"${attr("selected", grant?.eco === eco)}>${ECO_NAMES[eco]}</option>`,
  );
  const transitive = grant === undefined || grant.transitive !== false;
  return markup`<div class="grant-row" data-grant-row>
<input type="hidden" name="${prefix}grant" value="${key}" data-grant-key>
<select name="${prefix}grant_eco" data-field="eco" aria-label="Ecosystem">${options}</select>
<input type="text" name="${prefix}grant_package" data-field="package" aria-label="Package" placeholder="acme/* or a package name" spellcheck="false" value="${grant?.package ?? ""}">
<input type="text" name="${prefix}grant_versions" data-field="versions" aria-label="Versions" placeholder="*" spellcheck="false" value="${grant?.versions ?? "*"}">
<label class="inline" data-transitive><input type="checkbox" name="${prefix}grant_transitive" value="${key}" data-field="transitive"${attr("checked", transitive)}> transitive</label>
<button type="button" class="danger small" data-remove-grant>Remove</button>
</div>`;
}

/**
 * The grant rows of a form for the grants of one `role`. `transitive` only means something for
 * `read`, so the stylesheet hides it (`[data-transitive]`) inside a `publish` fieldset. In a
 * form that holds both lists the field names carry the role as a prefix (`read_grant_eco`),
 * which `app.js` and `grants.js` also give to the rows they add. The fieldset is named by the
 * heading `headingId` of the page or of the form.
 */
function grantsFieldset(
  ecosystems: readonly Eco[],
  grants: readonly Grant[],
  role: GrantRole,
  headingId: string,
  hidden = false,
): SafeHtml {
  const rows = grants.map((g, i) => grantRow(ecosystems, g, String(i), `${role}_`));
  return markup`<fieldset class="plain" data-grants data-grant-kind="${role}" data-grant-role="${role}" aria-labelledby="${headingId}"${attr("hidden", hidden)}>
<p class="hint">Package: an exact name or a pattern ending in <code>*</code>. Versions: a constraint in the ecosystem's syntax, <code>*</code> for all.<span data-transitive> Transitive: also open the package's dependencies in this registry.</span></p>
<div class="grants-tools"><button type="button" class="secondary small" data-grants-toggle hidden>Edit as text</button></div>
<div data-grants-rows-pane>
<div data-grant-rows>${rows}</div>
<button type="button" class="secondary small" data-add-grant>Add grant</button>
</div>
<div data-grants-text-pane hidden>
<p class="error" role="alert" data-grants-text-error hidden></p>
<textarea class="grants-text" data-grants-text rows="8" aria-label="Grants as text" spellcheck="false" placeholder="npm:@acme/sdk:^2.0"></textarea>
<p class="hint">One grant per line: <code>eco:package[:versions[:transitive]]</code>, as in <code>sreg</code>. Versions default to <code>*</code>.<span data-transitive> Add <code>:false</code> to leave the dependencies closed.</span> Empty lines and lines starting with <code>#</code> are ignored.</p>
</div>
</fieldset>`;
}

/** The checkboxes of a secret's scope: `read` and `publish`, those in `checked` ticked. */
function scopeChoices(checked: readonly GrantRole[]): SafeHtml {
  return markup`${GRANT_ROLES.map((role) => markup`<label class="inline"><input type="checkbox" name="scope" value="${role}"${attr("checked", checked.includes(role))}> ${role}</label> `)}`;
}

function grantTemplate(ecosystems: readonly Eco[]): SafeHtml {
  return markup`<template id="grant-row">${grantRow(ecosystems)}</template>`;
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

/** The roles of a credential as badges. */
function roleBadges(roles: readonly Kind[]): SafeHtml {
  return markup`${roles.map((role) => markup`<span class="badge kind" data-kind="${role}">${role}</span> `)}`;
}

/** The number of grants of each role a credential holds, as `read 2 · publish 1`. */
function grantCounts(credential: Credential): SafeHtml | number {
  const held = GRANT_ROLES.filter((role) => credential.roles.includes(role));
  if (held.length === 0) return markup`<span class="hint">—</span>`;
  const count = (role: GrantRole) => roleGrantsOf(credential, role).length;
  if (held.length === 1) return count(held[0] ?? "read");
  return markup`${held.map((role) => `${role} ${count(role)}`).join(" · ")}`;
}

/** The grants of one role of a credential. */
function roleGrantsOf(credential: Credential, role: GrantRole): Grant[] {
  return role === "read" ? credential.read_grants : credential.publish_grants;
}

/** The roles a secret may use, as badges. */
function scopeBadges(entry: AuthEntry): SafeHtml {
  return roleBadges(entry.scope);
}

function listRow(credential: Credential, now: Date): SafeHtml {
  const { project } = credential;
  const { active, nearestExpiry } = secretSummary(credential, now);
  const expiry =
    nearestExpiry === null
      ? markup`<span class="hint">never</span>`
      : markup`<time datetime="${nearestExpiry}">${day(nearestExpiry)}</time>`;
  const grants = grantCounts(credential);
  return markup`<tr data-pkg-row data-name="${project}">
<td><a class="row-link" href="${credentialHref(project)}">${project}</a></td>
<td>${roleBadges(credential.roles)}</td>
<td class="num">${active}</td>
<td class="nowrap">${expiry}</td>
<td class="num">${grants}</td>
</tr>`;
}

/** `GET /admin/credentials`: every credential in a table with a filter by project. */
export function credentialsPage(
  ctx: PageContext,
  credentials: readonly Credential[],
  now: Date,
): string {
  const sorted = [...credentials].sort((a, b) => (a.project < b.project ? -1 : 1));
  const filter =
    sorted.length < 2
      ? ""
      : markup`<div class="pkg-filter" data-pkg-filter hidden>
<div class="pkg-search">
<label for="pkg-filter-name">Filter by project</label>
<input type="search" id="pkg-filter-name" data-filter-name autocomplete="off" spellcheck="false">
</div>
</div>`;
  const table =
    sorted.length === 0
      ? markup`<div class="pkg-empty"><p>No credentials yet.</p></div>`
      : markup`<div class="box table-box"><table class="credentials">
<thead><tr><th>Project</th><th>Roles</th><th class="num">Active secrets</th><th>Nearest expiry</th><th class="num">Grants</th></tr></thead>
<tbody data-pkg-list>
${sorted.map((c) => listRow(c, now))}
</tbody>
</table></div>
<p class="pkg-none-match" data-pkg-empty role="status" hidden>No credentials match the filter.</p>`;
  return layout(
    ctx,
    "Credentials",
    markup`<div class="catalog wide">
<div class="page-head">
<h1>Credentials</h1>
<a class="button" href="/admin/credentials/new">New credential</a>
</div>
<p class="consumer-lead" data-pkg-lead data-noun="credential" aria-live="polite">${plural(sorted.length, "credential")}. Open one to edit its grants and secrets.</p>
${filter}
${table}
</div>`,
    { page: "credentials", section: "credentials" },
  );
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

/** What the create form needs. */
export interface NewCredentialData {
  ecosystems: Eco[];
  error?: string;
  values?: CredentialFormValues;
}

/** `GET /admin/credentials/new`: the create form alone. */
export function newCredentialPage(ctx: PageContext, data: NewCredentialData): string {
  const { ecosystems } = data;
  const first = ecosystems[0] ?? NEW_GRANT.eco;
  const values = data.values ?? {
    project: "",
    kind: "read",
    grants: { read: [], publish: [] },
    scope: [],
  };
  const grantsOf = (role: GrantRole) => {
    const list = values.grants[role];
    return list.length > 0 ? list : [{ ...NEW_GRANT, eco: first }];
  };
  const admin = values.kind === "admin";
  const roles = rolesOfKind(values.kind);
  const kindLabels: Record<CreateKind, string> = {
    read: "read",
    publish: "publish",
    both: "read + publish",
    admin: "admin",
  };
  const kinds = (["read", "publish", "both", "admin"] as const).map((kind) => ({
    value: kind,
    label: kindLabels[kind],
  }));
  const help = (["read", "publish", "both", "admin"] as const).map(
    (kind) => markup`<div><dt>${kindLabels[kind]}</dt><dd>${KIND_HELP[kind]}</dd></div>`,
  );
  const sections = GRANT_ROLES.map((role) => {
    const shown = roles.includes(role);
    return markup`<h2 class="form-heading" id="new-${role}-grants"${attr("hidden", !shown)} data-grants-heading data-role="${role}">${role === "read" ? "Read grants" : "Publish grants"}</h2>
${grantsFieldset(ecosystems, grantsOf(role), role, `new-${role}-grants`, !shown)}`;
  });
  return layout(
    ctx,
    "New credential",
    markup`<div class="catalog wide">
${breadcrumbs([{ label: "Credentials", href: "/admin/credentials" }, { label: "New credential" }])}
<h1>New credential</h1>
<p class="consumer-lead">A credential is a project with its roles, their grants and its secrets. It starts with one token, generated by the registry and shown once.</p>
<form class="box form" method="post" action="/admin/credentials/new" data-credential-form>
${errorMessage(data.error)}
<label for="project">Project</label>
<input id="project" name="project" type="text" required pattern="${SLUG_PATTERN}" autocomplete="off" spellcheck="false" placeholder="e.g. shop-frontend" value="${values.project}">
<p class="hint">Lower-case letters, digits and dashes, 2 to 63 characters; the login of its tokens.</p>
<fieldset class="plain" data-kind>
<legend>Kind</legend>
${segmented("kind", "Kind", kinds, values.kind)}
<dl class="kind-help">${help}</dl>
</fieldset>
${passwordFields("kind:admin", admin)}
<fieldset class="plain" data-scope${attr("hidden", values.kind !== "both")}>
<legend>First token may</legend>
${scopeChoices(values.scope)}
<p class="hint">Choose at least one. Further tokens get their own scope; a token committed to a consumer's repository should be <code>read</code> only.</p>
</fieldset>
${sections}
<button type="submit">Create credential</button>
</form>
${grantTemplate(ecosystems)}
</div>`,
    { page: "credential-new", section: "credentials", scripts: [GRANTS_SCRIPT] },
  );
}

// ---------------------------------------------------------------------------------------------
// One credential
// ---------------------------------------------------------------------------------------------

/** A claim value of a `gh` entry in code style, or `any` when the claim is not checked. */
function claimValue(value: string | null | undefined): SafeHtml {
  return typeof value === "string" ? markup`<code>${value}</code>` : markup`any`;
}

function claims(entry: AuthEntry): SafeHtml {
  if (entry.type === "key") return markup`<span class="hint">—</span>`;
  const optional: [string, string | null | undefined][] = [
    ["repository id", entry.repository_id],
    ["owner id", entry.repository_owner_id],
    ["environment", entry.environment],
  ];
  const extra = optional
    .filter((pair): pair is [string, string] => typeof pair[1] === "string")
    .map(([label, value]) => markup` · ${label} ${claimValue(value)}`);
  const pin = awaitsPin(entry)
    ? markup` · <span class="hint nowrap">pinned on first use</span>`
    : "";
  return markup`${claimValue(entry.repository)} · ref ${claimValue(entry.ref)} · workflow ${claimValue(entry.workflow)}${extra}${pin}`;
}

function secretRow(project: string, entry: AuthEntry, now: Date): SafeHtml {
  const active = isActiveAt(entry, now);
  const expires =
    entry.expires === null
      ? markup`<span class="hint">never</span>`
      : markup`<time datetime="${entry.expires}" title="${entry.expires}">${day(entry.expires)}</time>`;
  // Without scripts the date and "Expire" are shown inline; `app.js` hides them behind
  // "Expire…" until it is pressed.
  const action = active
    ? markup`<form class="inline-form expire-form" data-api-form="expire" data-api-method="DELETE" data-api-url="${apiPath("credentials", project, "secrets", entry.id)}" data-confirm="Expire the secret ${entry.id} of ${project}?" data-expire-form>
<button type="button" class="danger small" data-expire-open hidden>Expire…</button>
<span class="expire-fields" data-expire-fields>
<input type="date" name="expires" aria-label="Expire ${entry.id} on (empty: now)">
<button type="submit" class="danger small">Expire</button>
<button type="button" class="link small" data-expire-cancel hidden>Cancel</button>
</span>
</form>`
    : markup`<span class="badge warn">expired</span>`;
  return markup`<tr>
<td data-label="Type"><span class="badge">${entry.type}</span></td>
<td data-label="ID"><code>${entry.id}</code></td>
<td data-label="Scope">${scopeBadges(entry)}</td>
<td class="nowrap" data-label="Created"><time datetime="${entry.created}">${day(entry.created)}</time></td>
<td class="nowrap" data-label="Expires">${expires}</td>
<td class="claims" data-label="Claims">${claims(entry)}</td>
<td class="nowrap secret-action">${action}</td>
</tr>`;
}

function overview(credential: Credential, login: string, now: Date): SafeHtml {
  const { active, nearestExpiry } = secretSummary(credential, now);
  const created = credential.auth
    .map((e) => e.created)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const ids = credential.auth
    .filter((e) => isActiveAt(e, now))
    .map((e) => markup`<code>${e.id}</code> `);
  const facts: [string, SafeHtml | string][] = [
    ["Roles", roleBadges(credential.roles)],
    ["Login", markup`<code>${login}</code>`],
    [
      "Created",
      created === undefined ? "—" : markup`<time datetime="${created}">${day(created)}</time>`,
    ],
    ["Active secrets", `${active} of ${credential.auth.length}`],
    ["Nearest expiry", nearestExpiry === null ? "never" : day(nearestExpiry)],
    ["Active secret IDs", ids.length === 0 ? "—" : markup`${ids}`],
  ];
  const href = credentialHref(credential.project);
  const isAdmin = credential.roles.includes("admin");
  const grants = isAdmin
    ? "No grants (admin)"
    : GRANT_ROLES.filter((role) => credential.roles.includes(role))
        .map((role) => plural(roleGrantsOf(credential, role).length, `${role} grant`))
        .join(" · ");
  const links: [string, string, string][] = [
    [
      `${href}?tab=grants`,
      grants,
      isAdmin ? "Admin credentials see everything" : "Edit the grants and roles",
    ],
    [
      `${href}?tab=secrets`,
      `${active} active of ${plural(credential.auth.length, "secret")}`,
      "Expire secrets",
    ],
    [`${href}?tab=secrets&add=1`, "New secret", "Add a key or GitHub Actions secret"],
    [`${href}?tab=danger`, "Danger zone", "Delete this credential"],
  ];
  return markup`<section class="section" aria-labelledby="overview">
<h2 id="overview">Overview</h2>
<div class="box"><dl class="facts">
${facts.map(([name, value]) => markup`<div><dt>${name}</dt><dd>${value}</dd></div>`)}
</dl></div>
<ul class="overview-links">
${links.map(([to, title, text]) => markup`<li><a href="${to}"><strong>${title}</strong><span>${text}</span></a></li>`)}
</ul>
</section>`;
}

function grantsSection(credential: Credential, ecosystems: readonly Eco[]): SafeHtml {
  const { project } = credential;
  if (credential.roles.includes("admin")) {
    return markup`<section class="section" aria-labelledby="grants">
<h2 id="grants">Grants</h2>
<div class="box"><p class="hint">Admin credentials have no grants: they see and manage everything.</p></div>
</section>`;
  }
  const url = apiPath("credentials", project);
  const forms = GRANT_ROLES.filter((role) => credential.roles.includes(role)).map(
    (
      role,
    ) => markup`<h3 id="${role}-grants">${role === "read" ? "Read grants" : "Publish grants"}</h3>
<form class="box" data-api-form="grants" data-api-method="PATCH" data-api-url="${url}" data-grants-field="${role}_grants">
${grantsFieldset(ecosystems, roleGrantsOf(credential, role), role, `${role}-grants`)}
${FORM_ERROR}
<div class="form-actions"><button type="submit">Save ${role} grants</button></div>
</form>`,
  );
  const roles = GRANT_ROLES.map(
    (role) =>
      markup`<label class="inline"><input type="checkbox" name="roles" value="${role}"${attr("checked", credential.roles.includes(role))}> ${role}</label> `,
  );
  return markup`<section class="section" aria-labelledby="grants">
<h2 id="grants">Grants</h2>
${forms}
<h3 id="roles">Roles</h3>
<form class="box" data-api-form="roles" data-api-method="PATCH" data-api-url="${url}">
<p>${roles}</p>
<p class="hint">Adding a role never widens the secrets the credential already has: they keep the roles they had, and new secrets choose their scope. A role cannot be removed while an active secret has nothing else.</p>
${FORM_ERROR}
<div class="form-actions"><button type="submit">Save roles</button></div>
</form>
</section>`;
}

function secretsSection(credential: Credential, now: Date, add: SafeHtml): SafeHtml {
  const rows = credential.auth.map((e) => secretRow(credential.project, e, now));
  return markup`<section class="section" aria-labelledby="secrets">
<h2 id="secrets">Secrets</h2>
${add}
<div class="box table-box"><table class="secrets">
<thead><tr><th>Type</th><th>ID</th><th>Scope</th><th>Created</th><th>Expires</th><th>Claims</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
</section>`;
}

const NO_SECRET_VALUES: SecretFormValues = {
  type: "key",
  scope: [],
  repository: "",
  repository_id: "",
  repository_owner_id: "",
  ref: "",
  workflow: "",
  environment: "",
  pin_on_first_use: true,
  expires: "",
};

/**
 * The "add a secret" form, collapsed behind a primary "Add a secret" button (a `<details>`, so
 * it works without scripts); `open` after `?add=1` and when a refused form is shown again.
 */
function addSecretSection(
  credential: Credential,
  values: SecretFormValues,
  error: string | undefined,
  open: boolean,
): SafeHtml {
  const gh = values.type === "gh";
  const types = [
    { value: "key", label: "Key" },
    { value: "gh", label: "GitHub Actions" },
  ];
  const password = credential.roles.includes("admin") ? passwordFields("type:key", !gh) : "";
  const scope =
    credential.roles.length > 1
      ? markup`<fieldset class="plain" data-secret-scope>
<legend>May</legend>
${scopeChoices(values.scope)}
<p class="hint">Choose at least one. A token committed to a consumer's repository should be <code>read</code> only.</p>
</fieldset>`
      : "";
  return markup`<details class="add-secret" id="add-secret"${attr("open", open)}>
<summary class="button"><span class="when-closed">Add a secret</span><span class="when-open">Close the form</span></summary>
<form class="box form" method="post" aria-label="Add a secret" action="${credentialHref(credential.project)}/secrets" data-secret-form>
${errorMessage(error)}
<fieldset class="plain" data-secret-type>
<legend>Type</legend>
${segmented("type", "Type", types, values.type)}
<p class="hint">Key: a new token, shown once. GitHub Actions: workflows of a repository sign in with their OIDC token, so there is no secret to store.</p>
</fieldset>
${password}
${scope}
<div data-gh-fields${attr("hidden", !gh)}>
<label for="repository">Repository</label>
<div class="input-with-button">
<input type="text" id="repository" name="repository" placeholder="owner/repo or owner/*" spellcheck="false" value="${values.repository}">
<button type="button" class="secondary small" data-gh-lookup>Look up</button>
</div>
<p class="hint">Look up fills in the repository and owner ids from GitHub (public repositories). Leave them empty to pin them on first use instead, for example for a private repository.</p>
<p class="error" role="alert" data-lookup-error hidden></p>
<div class="field-pair">
<div><label for="repository_id">Repository ID (optional)</label><input type="text" id="repository_id" name="repository_id" inputmode="numeric" pattern="[0-9]+" spellcheck="false" value="${values.repository_id}"></div>
<div><label for="repository_owner_id">Repository owner ID (optional)</label><input type="text" id="repository_owner_id" name="repository_owner_id" inputmode="numeric" pattern="[0-9]+" spellcheck="false" value="${values.repository_owner_id}"></div>
</div>
<label class="inline"><input type="checkbox" name="pin_on_first_use"${attr("checked", values.pin_on_first_use)}> Pin repository ids on first use</label>
<p class="hint">When the ids are left empty, the first token that matches by name stores the repository id and owner id, and later tokens must match them.</p>
<label for="ref">Ref (optional glob, empty: any)</label>
<input type="text" id="ref" name="ref" placeholder="refs/tags/v*" spellcheck="false" value="${values.ref}">
<label for="workflow">Workflow (optional path in the repository, empty: any)</label>
<input type="text" id="workflow" name="workflow" placeholder=".github/workflows/release.yml" spellcheck="false" value="${values.workflow}">
<label for="environment">Environment (optional, empty: any)</label>
<input type="text" id="environment" name="environment" spellcheck="false" value="${values.environment}">
<p class="hint">For secrets that may <code>publish</code> prefer the ref <code>refs/tags/v*</code> or a workflow, so that only the release workflow can publish.</p>
</div>
<label for="expires">Expires (empty: never)</label>
<input type="date" id="expires" name="expires" value="${values.expires}">
<div class="form-actions"><button type="submit">Add secret</button></div>
</form>
</details>`;
}

/** The tabs of a credential page (`?tab=`), in display order; the first is the default. */
export const CREDENTIAL_TABS = ["overview", "grants", "secrets", "danger"] as const;

export type CredentialTab = (typeof CREDENTIAL_TABS)[number];

const TAB_TITLES: Readonly<Record<CredentialTab, string>> = {
  overview: "Overview",
  grants: "Grants",
  secrets: "Secrets",
  danger: "Danger zone",
};

/** The tab named by `?tab=`; the overview for anything else. */
export function credentialTab(value: string | null): CredentialTab {
  return CREDENTIAL_TABS.find((tab) => tab === value) ?? "overview";
}

/** What the page of one credential needs. */
export interface CredentialPageData {
  credential: Credential;
  ecosystems: Eco[];
  now: Date;
  /** The login of its tokens (`TOKEN_PREFIX` + project). */
  login: string;
  /** The tab shown; default `overview`. A refused "add a secret" form shows `secrets`. */
  tab?: CredentialTab;
  /** Open the "add a secret" form (`?tab=secrets&add=1`). */
  addSecret?: boolean;
  /** A refused "add a secret" form: its error and the values to show again. */
  secretError?: string;
  secretValues?: SecretFormValues;
}

/** The tab bar under the heading: plain links, the current one marked. */
function tabBar(credential: Credential, current: CredentialTab): SafeHtml {
  const href = credentialHref(credential.project);
  const counts: Partial<Record<CredentialTab, number>> = {
    grants: credential.roles.includes("admin")
      ? undefined
      : credential.read_grants.length + credential.publish_grants.length,
    secrets: credential.auth.length,
  };
  const links = CREDENTIAL_TABS.map((tab) => {
    const count = counts[tab];
    const badge = count === undefined ? "" : markup` <span class="tab-count">${count}</span>`;
    return markup`<a href="${href}?tab=${tab}"${tab === current ? markup` aria-current="page"` : ""}>${TAB_TITLES[tab]}${badge}</a>`;
  });
  return markup`<nav class="tabs" aria-label="Credential">${links}</nav>`;
}

/** `GET /admin/credentials/<project>`: the heading, the tab bar and the chosen tab. */
export function credentialPage(ctx: PageContext, data: CredentialPageData): string {
  const { credential, ecosystems, now } = data;
  const { project } = credential;
  const refused = data.secretError !== undefined;
  const tab = refused ? "secrets" : (data.tab ?? "overview");
  let body: SafeHtml;
  switch (tab) {
    case "overview":
      body = overview(credential, data.login, now);
      break;
    case "grants":
      body = markup`${grantsSection(credential, ecosystems)}
${credential.roles.includes("admin") ? "" : grantTemplate(ecosystems)}`;
      break;
    case "secrets": {
      const values = data.secretValues ?? NO_SECRET_VALUES;
      const open = refused || data.addSecret === true;
      body = secretsSection(
        credential,
        now,
        addSecretSection(credential, values, data.secretError, open),
      );
      break;
    }
    case "danger":
      body = dangerZone({
        title: "Delete this credential",
        text: "All its tokens and GitHub Actions secrets stop working at once. The last admin credential cannot be deleted.",
        method: "DELETE",
        url: apiPath("credentials", project),
        name: project,
        button: "Delete credential",
        next: "/admin/credentials",
      });
      break;
  }
  return layout(
    ctx,
    `${project} · ${TAB_TITLES[tab]}`,
    markup`<div class="catalog wide">
${breadcrumbs([{ label: "Credentials", href: "/admin/credentials" }, { label: project }])}
<header class="pkg-header credential-header">
<h1>${project} ${roleBadges(credential.roles)}</h1>
</header>
${tabBar(credential, tab)}
<div class="tab-panel">
${body}
</div>
</div>`,
    {
      page: "credential",
      section: "credentials",
      scripts: tab === "grants" ? [GRANTS_SCRIPT] : [],
    },
  );
}
