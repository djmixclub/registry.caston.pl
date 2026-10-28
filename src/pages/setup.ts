/**
 * The setup checklist (docs/deployment.md "Settings"): which installation settings exist, from
 * `setupStatus` in `src/core/config.ts`, with a status badge (Set, Missing, Default), what each
 * one is for and, while a required or recommended one is missing, how to add it. It is shown
 * on the first run, alone while `SESSION_SECRET` is missing (nobody could sign in, so no admin
 * is created), and on the admin settings page. Values are never shown here: the settings page
 * passes the values it may show (plain variables) itself.
 */

import { missingRequired, type SetupItem } from "../core/config";
import { copyBlock } from "./components";
import { markup, type SafeHtml } from "./html";
import { centredLayout, type PageContext } from "./layout";

/** `docs/deployment.md` on GitHub, at one heading. */
export function deploymentHref(anchor: string): string {
  return `https://github.com/kduma-OSS/serverless-registry-worker/blob/main/docs/deployment.md#${anchor}`;
}

/** Where settings are added in the Cloudflare dashboard. */
const DASHBOARD_PATH = markup`<strong>Workers &amp; Pages</strong> → the Worker → <strong>Settings</strong> → <strong>Variables and Secrets</strong> → <strong>Add</strong>`;

/** The settings whose value can be any random string, so the page offers to generate one. */
const GENERATED = new Set(["SESSION_SECRET"]);

/**
 * A "Generate a value" button (shown by `public/app.js`, which fills a read-only field with 48
 * random bytes from `crypto.getRandomValues`, base64url) and the command that does the same
 * without scripts.
 */
export function secretGenerator(name: string): SafeHtml {
  return markup`<div class="secret-gen" data-secret-gen>
<button type="button" class="secondary small" data-generate hidden>Generate a value</button>
<div class="copyable" data-generated hidden>
<div class="copyable-head">
<div class="copyable-label">A random value for <code>${name}</code></div>
<button type="button" class="copy" data-copy>Copy</button>
</div>
<input type="text" class="mono" readonly spellcheck="false" aria-label="Generated value for ${name}" data-generated-value>
<p class="hint">Generated in your browser and never sent to the server. Save it as the secret <code>${name}</code>, then reload this page.</p>
</div>
<p class="hint">Or generate one in a terminal: <code>openssl rand -base64 48</code></p>
</div>`;
}

function badge(item: SetupItem): SafeHtml {
  if (item.set) return markup`<span class="status" data-status="set">Set</span>`;
  if (item.level === "optional")
    return markup`<span class="status" data-status="default">Default</span>`;
  return markup`<span class="status" data-status="missing">Missing</span>`;
}

function howTo(item: SetupItem): SafeHtml {
  const add = item.secret
    ? markup`<p>Add it as a <em>Secret</em> in the Cloudflare dashboard (${DASHBOARD_PATH}), or with Wrangler:</p>
${copyBlock(`npx wrangler secret put ${item.name}`)}`
    : markup`<p>Add it as a <em>Text</em> variable in the Cloudflare dashboard (${DASHBOARD_PATH}); Wrangler has no command for dashboard variables.</p>`;
  const token = item.name.startsWith("S3_")
    ? markup`<p>The S3 settings come from an R2 API token with <em>Object Read &amp; Write</em> on the registry's bucket only: <a href="${deploymentHref(item.docsAnchor)}" rel="noreferrer">create the R2 API token</a>.</p>`
    : markup`<p><a href="${deploymentHref(item.docsAnchor)}" rel="noreferrer">More about ${item.name}</a></p>`;
  return markup`<div class="setup-how">
${add}
${GENERATED.has(item.name) ? secretGenerator(item.name) : ""}
${token}
</div>`;
}

function row(item: SetupItem, value?: SafeHtml): SafeHtml {
  const missing = !item.set && item.level !== "optional";
  const shown = value === undefined ? "" : markup`<p class="setup-value">Value: ${value}</p>`;
  return markup`<li class="setup-item" data-status="${item.set ? "set" : missing ? "missing" : "default"}">
<div class="setup-head"><code class="setup-name">${item.name}</code> ${badge(item)} <span class="setup-level">${item.level}</span></div>
<p class="setup-purpose">${item.purpose}${missing ? markup` <strong>${item.howTo}</strong>` : ""}</p>
${shown}
${missing ? howTo(item) : ""}
</li>`;
}

/** Options of {@link setupChecklist}. */
export interface ChecklistOptions {
  /** What to show as the value of a setting, by name (the settings page's plain variables). */
  values?: Readonly<Record<string, SafeHtml>>;
  /** The page that "Check again" reloads. */
  recheck: string;
}

/** Every setting in one list, with a "Check again" link that reloads the page. */
export function setupChecklist(items: readonly SetupItem[], options: ChecklistOptions): SafeHtml {
  return markup`<ul class="setup-list">
${items.map((item) => row(item, options.values?.[item.name]))}
</ul>
<p class="setup-recheck"><a class="button secondary small" href="${options.recheck}">Check again</a></p>`;
}

/**
 * The checklist above the first-run form: one collapsed line while every required setting is
 * present, otherwise open with what is missing.
 */
export function firstRunSetup(items: readonly SetupItem[]): SafeHtml {
  const missing = missingRequired(items);
  const recommended = items.filter((i) => i.level === "recommended" && !i.set);
  if (missing.length === 0) {
    const note =
      recommended.length === 0
        ? ""
        : markup` · ${recommended.map((i) => markup`<code>${i.name}</code>`)} recommended`;
    return markup`<details class="setup-summary">
<summary><span class="status" data-status="set">OK</span> All required settings are present${note}</summary>
${setupChecklist(items, { recheck: "/" })}
</details>`;
  }
  return markup`<section class="setup-open" aria-labelledby="setup">
<h2 id="setup">Settings missing</h2>
<p class="hint">You can create the admin now; publishing and downloads fail until these are set.</p>
${setupChecklist(
  items.filter((i) => !i.set && i.level !== "optional"),
  { recheck: "/" },
)}
</section>`;
}

/** The first run while `SESSION_SECRET` is missing: only the checklist. */
export function setupPage(ctx: PageContext, items: readonly SetupItem[]): string {
  return centredLayout(
    ctx,
    "Set up",
    markup`<h1>Finish the setup</h1>
<p class="sub">This registry has no credentials yet, and the panel cannot sign anyone in until
<code>SESSION_SECRET</code> is set, so the first admin cannot be created yet. Add the missing
settings, then check again.</p>
${setupChecklist(
  items.filter((i) => i.level !== "optional"),
  { recheck: "/" },
)}`,
    { page: "setup", wide: true },
  );
}
