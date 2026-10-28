/**
 * The settings page (`GET /admin/settings`, kind `admin`), read-only: the versions of the
 * Worker, the CLI and the storage schema, the update check (with `CHECK_UPDATES=true`) and the
 * Worker variables, each with its value or, while it is unset, the default the Worker uses.
 */

import { updateStatus, type LatestRelease } from "../core/updates";
import { markup, type SafeHtml } from "./html";
import { layout, type PageContext } from "./layout";

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
  /** Worker variables, shown as they are configured. */
  vars: Setting[];
  /**
   * The update check, present when `CHECK_UPDATES` is `true`: the latest release, or `null`
   * when the check failed.
   */
  update?: { release: LatestRelease | null };
}

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
  const vars = settings.vars.map(
    (v) => markup`<tr><th><code>${v.name}</code></th><td>${settingValue(v)}</td></tr>`,
  );
  const update =
    settings.update === undefined
      ? ""
      : markup`<p class="update">${updateLine(settings.version, settings.update.release)}</p>`;
  return layout(
    ctx,
    "Settings",
    markup`<div class="catalog">
<h1>Settings</h1>
<p class="consumer-lead">Read-only. Change the variables in the Cloudflare dashboard (Worker settings), not in the repository.</p>
<section class="section" aria-labelledby="versions">
<h2 id="versions">Versions</h2>
<div class="box"><table class="kv">
<tbody>${rows.map(([name, value]) => markup`<tr><th>${name}</th><td>${value}</td></tr>`)}</tbody>
</table>
${update}</div>
</section>
<section class="section" aria-labelledby="variables">
<h2 id="variables">Variables</h2>
<div class="box"><table class="kv">
<tbody>${vars}</tbody>
</table></div>
</section>
</div>`,
    { page: "settings", section: "settings" },
  );
}
