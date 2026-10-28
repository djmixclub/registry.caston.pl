/**
 * The settings page (`GET /admin/settings`, kind `admin`), read-only: the versions of the
 * Worker, the CLI and the storage schema, the update check (with `CHECK_UPDATES=true`) and the
 * setup checklist of every installation setting (`src/pages/setup.ts`), the plain variables
 * with their value or, while one is unset, the default the Worker uses.
 */

import type { SetupItem } from "../core/config";
import { updateStatus, type LatestRelease } from "../core/updates";
import { markup, type SafeHtml } from "./html";
import { DOCS_URL, layout, type PageContext } from "./layout";
import { setupChecklist } from "./setup";

/** One read-only setting. */
export interface Setting {
  name: string;
  /** The configured value; `""` when the variable is unset. */
  value: string;
  /** What the Worker uses while the variable is unset; absent when there is no default. */
  default?: string;
}

/** The data of the settings page. */
export interface AdminSettings {
  version: string;
  minClientVersion: string;
  schemaVersion: number;
  /** Every installation setting, present or not (never its value). */
  setup: SetupItem[];
  /** The plain variables whose value is shown, as they are configured. */
  vars: Setting[];
  /**
   * The update check, present when `CHECK_UPDATES` is `true`: the latest release, or `null`
   * when the check failed.
   */
  update?: { release: LatestRelease | null; errors: string[] };
}

/** Where docs/deployment.md explains the workflow that updates a repository. */
export const UPDATE_WORKFLOW_DOCS = `${DOCS_URL}/deployment.md#updating-with-a-workflow`;

/** The result of the update check, compared by semver with the running version. */
export function updateLine(
  version: string,
  release: LatestRelease | null,
  errors: readonly string[] = [],
): SafeHtml {
  if (release === null) {
    const details =
      errors.length === 0
        ? ""
        : markup`<ul class="hint">${errors.map((e) => markup`<li><code>${e}</code></li>`)}</ul>`;
    return markup`Could not check for new releases; the check is retried within an hour.${details}`;
  }
  const link = markup`<a href="${release.url}" rel="noreferrer">${release.tag}</a>`;
  switch (updateStatus(release.tag, version)) {
    case "available":
      return markup`<span class="badge warn">update</span> <strong>New release ${link} is available.</strong><p class="hint">To update, run the <strong>Update from upstream</strong> workflow in the <strong>Actions</strong> tab of your repository (<a href="${UPDATE_WORKFLOW_DOCS}" rel="noreferrer">how</a>).</p>`;
    case "current":
      return markup`Up to date.`;
    case "unknown":
      return markup`Latest release: ${link}.`;
  }
}

/** The update check as a block: a box for a new release or a failed check, a line otherwise. */
function updateBlock(version: string, update: { release: LatestRelease | null; errors: string[] }) {
  const state = update.release === null ? "failed" : updateStatus(update.release.tag, version);
  return markup`<div class="update update-${state}" role="status">
<div class="update-main">${updateLine(version, update.release, update.errors)}</div>
<a class="hint update-check" href="/admin/settings?check-updates=1">Check now</a>
</div>`;
}

/** A variable's value, or while it is unset the default the Worker uses, marked as such. */
function settingValue(v: Setting): SafeHtml {
  if (v.value !== "") return markup`<code>${v.value}</code>`;
  if (v.default === undefined) return markup`<span class="hint">not set</span>`;
  if (v.default === "") return markup`<span class="hint">empty (default)</span>`;
  return markup`<code>${v.default}</code> <span class="hint">(default)</span>`;
}

/** The settings page. */
export function settingsPage(ctx: PageContext, settings: AdminSettings): string {
  const rows: [string, string][] = [
    ["Worker version", settings.version],
    ["Minimum CLI version", settings.minClientVersion],
    ["Schema version", String(settings.schemaVersion)],
  ];
  const values = Object.fromEntries(settings.vars.map((v) => [v.name, settingValue(v)]));
  const update =
    settings.update === undefined ? "" : updateBlock(settings.version, settings.update);
  return layout(
    ctx,
    "Settings",
    markup`<div class="catalog wide">
<h1>Settings</h1>
<p class="consumer-lead">Read-only. Change the variables in the Cloudflare dashboard (Worker settings), not in the repository.</p>
<section class="section" aria-labelledby="versions">
<h2 id="versions">Versions</h2>
<div class="box"><table class="kv">
<tbody>${rows.map(([name, value]) => markup`<tr><th>${name}</th><td>${value}</td></tr>`)}</tbody>
</table>
${update}</div>
</section>
<section class="section" aria-labelledby="setup">
<h2 id="setup">Setup</h2>
<div class="box">
${setupChecklist(settings.setup, { values, recheck: "/admin/settings" })}
</div>
</section>
</div>`,
    { page: "settings", section: "settings" },
  );
}
