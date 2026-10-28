/**
 * Pieces shared by the package list, the package page and the version page: links to the
 * panel's package routes, the ecosystem badge, breadcrumbs, the configuration snippets with
 * their placeholder note, and small text helpers.
 */

import type { Eco, Snippet } from "../adapters/types";
import { markup, type SafeHtml } from "./html";
import { BASE64_PLACEHOLDER, SECRET_PLACEHOLDER, TOKEN_PLACEHOLDER } from "./snippets";

/** Display names of the ecosystems. */
export const ECO_NAMES: Readonly<Record<Eco, string>> = {
  composer: "Composer",
  npm: "npm",
  cargo: "Cargo",
  generic: "Generic",
  nuget: "NuGet",
  swift: "Swift",
  maven: "Maven",
};

/** `YYYY-MM-DD` of an RFC 3339 timestamp. */
export function day(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** `1 version`, `2 versions`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `/packages/<eco>/<name>`, the name encoded as one segment (`/` as `%2F`). */
export function packageHref(eco: Eco, name: string): string {
  return `/packages/${eco}/${encodeURIComponent(name)}`;
}

/** `/packages/<eco>/<name>/<version>`. */
export function versionHref(eco: Eco, name: string, version: string): string {
  return `${packageHref(eco, name)}/${encodeURIComponent(version)}`;
}

/** `/packages/<eco>/<name>/<version>/files/<file>`: the panel's download route. */
export function fileHref(eco: Eco, name: string, version: string, file: string): string {
  return `${versionHref(eco, name, version)}/files/${encodeURIComponent(file)}`;
}

/** The small ecosystem tag shown before a package name. */
export function ecoBadge(eco: Eco): SafeHtml {
  return markup`<span class="eco-badge" data-eco="${eco}">${ECO_NAMES[eco]}</span>`;
}

/** One step of the breadcrumbs; the last one has no `href`. */
export interface Crumb {
  label: string;
  href?: string;
}

/** `Packages › name › version`, the current page last and not a link. */
export function breadcrumbs(crumbs: readonly Crumb[]): SafeHtml {
  const items = crumbs.map((c) =>
    c.href === undefined
      ? markup`<li aria-current="page">${c.label}</li>`
      : markup`<li><a href="${c.href}">${c.label}</a></li>`,
  );
  return markup`<nav class="crumbs" aria-label="Breadcrumb"><ol>${items}</ol></nav>`;
}

/** The link back to the page one level up. */
export function backLink(href: string, label: string): SafeHtml {
  return markup`<p class="back"><a href="${href}">← ${label}</a></p>`;
}

/** The one-line note about the placeholders the snippets use. */
export function placeholderNote(snippets: readonly Snippet[]): SafeHtml {
  const text = snippets.map((s) => s.body).join("\n");
  const parts = [markup`replace <code>${TOKEN_PLACEHOLDER}</code> with your token`];
  if (text.includes(SECRET_PLACEHOLDER)) {
    parts.push(markup`<code>${SECRET_PLACEHOLDER}</code> with the part after its colon`);
  }
  if (text.includes(BASE64_PLACEHOLDER)) {
    parts.push(markup`<code>${BASE64_PLACEHOLDER}</code> with its base64 encoding`);
  }
  const joined = parts.flatMap((part, i) =>
    i === 0 ? [part] : [i === parts.length - 1 ? markup` and ` : markup`, `, part],
  );
  return markup`<p class="placeholder-note">In the snippets below, ${joined}.</p>`;
}

/**
 * One snippet: a header row with the title, the file name (unless the title already names
 * it) and a "Copy" button (wired up by `public/app.js` through `.copyable` and `data-copy`),
 * the description when there is one, then the text.
 */
export function snippetBlock(snippet: Snippet): SafeHtml {
  const file = snippet.title.includes(snippet.filename)
    ? ""
    : markup`<span class="snippet-file">${snippet.filename}</span>`;
  const description =
    snippet.description === undefined
      ? ""
      : markup`<p class="snippet-desc">${snippet.description}</p>
`;
  return markup`<div class="snippet copyable">
<div class="snippet-head">
<span class="snippet-title">${snippet.title}</span>
${file}
<button type="button" class="copy" data-copy>Copy</button>
</div>
${description}<pre><code>${snippet.body}</code></pre>
</div>`;
}

/** The variants of a group in order of first appearance, each with its snippets. */
function variantsOf(snippets: readonly Snippet[]): [string, Snippet[]][] {
  const variants = new Map<string, Snippet[]>();
  for (const s of snippets) {
    const variant = s.variant ?? s.title;
    variants.set(variant, [...(variants.get(variant) ?? []), s]);
  }
  return [...variants];
}

/**
 * The alternatives of one group as a segmented chooser that works without JavaScript: one
 * visually hidden radio per variant before the tabs (their labels) and the panes, so that the
 * stylesheet shows the pane of the checked radio (the first one by default). `public/app.js`
 * only keeps choosers of the same group in step and remembers the choice. Without the
 * stylesheet every pane is shown, one after the other.
 */
function chooser(group: string, snippets: readonly Snippet[], id: string): SafeHtml {
  const variants = variantsOf(snippets);
  const radios = variants.map(
    ([variant], i) =>
      markup`<input type="radio" class="chooser-radio" name="${id}" id="${id}-${i + 1}" value="${variant}"${i === 0 ? markup` checked` : ""}>`,
  );
  const tabs = variants.map(
    ([variant], i) => markup`<label for="${id}-${i + 1}">${variant}</label>`,
  );
  const panes = variants.map(
    ([variant, items]) => markup`<div class="chooser-pane" data-variant="${variant}">
${items.map(snippetBlock)}
</div>`,
  );
  return markup`<fieldset class="chooser" data-chooser="${group}">
<legend class="chooser-label">${group}</legend>
${radios}
<div class="chooser-tabs">${tabs}</div>
<div class="chooser-panes">
${panes}
</div>
</fieldset>`;
}

/**
 * Snippets in their order: those without a group as framed blocks, each group as one
 * {@link chooser} where its first snippet is. `idPrefix` keeps the radio names of the
 * choosers of one page apart.
 */
export function snippetList(snippets: readonly Snippet[], idPrefix: string): SafeHtml {
  const out: SafeHtml[] = [];
  const done = new Set<string>();
  for (const snippet of snippets) {
    const { group } = snippet;
    if (group === undefined) {
      out.push(snippetBlock(snippet));
    } else if (!done.has(group)) {
      done.add(group);
      const members = snippets.filter((s) => s.group === group);
      out.push(chooser(group, members, `${idPrefix}-${done.size}`));
    }
  }
  return markup`${out}`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `512 B`, `1.5 KB`, `12 MB` (powers of 1024). */
export function humanSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${shown} ${UNITS[unit]}`;
}

/** One value of a metadata table: strings as text, anything else as (indented) JSON. */
function metaValue(value: unknown): SafeHtml {
  if (typeof value === "string") return markup`${value}`;
  return markup`<code class="meta-json">${JSON.stringify(value, null, 2) ?? String(value)}</code>`;
}

/**
 * A "Metadata" section with the key/value pairs of a generic version's `meta` (`note` is shown
 * under the heading); nothing when there are none.
 */
export function metadataSection(
  meta: Readonly<Record<string, unknown>> | undefined,
  note?: SafeHtml,
): SafeHtml {
  const entries = Object.entries(meta ?? {});
  if (entries.length === 0) return markup``;
  return markup`<section class="pkg-section" aria-labelledby="metadata">
<h2 id="metadata">Metadata</h2>
${note ?? ""}
<div class="files-wrap"><table class="meta-table">
<tbody>
${entries.map(([key, value]) => markup`<tr><th scope="row">${key}</th><td>${metaValue(value)}</td></tr>`)}
</tbody>
</table></div>
</section>`;
}
