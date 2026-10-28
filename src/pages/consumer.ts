/**
 * The consumer view (kind `read`): the packages of the credential's explicit grants grouped
 * by ecosystem, with the versions the grants cover (yanked ones marked) and, collapsed under
 * each package, the dependencies its grant opens transitively; under each ecosystem the
 * ready-to-paste client configuration with a copy button per snippet.
 */

import type { Eco, Snippet } from "../adapters/types";
import type { PackageDependency, PackageView } from "../core/packages";
import { copyBlock } from "./components";
import { markup, type SafeHtml } from "./html";
import { layout, type PageContext } from "./layout";
import { BASE64_PLACEHOLDER, SECRET_PLACEHOLDER, TOKEN_PLACEHOLDER } from "./snippets";

/** Display names of the ecosystems. */
export const ECO_NAMES: Readonly<Record<Eco, string>> = {
  composer: "Composer",
  npm: "npm",
  cargo: "Cargo",
  generic: "Generic",
  nuget: "NuGet",
};

/** One ecosystem of the consumer view. */
export interface ConsumerSection {
  eco: Eco;
  packages: PackageView[];
  snippets: Snippet[];
}

/** `YYYY-MM-DD` of an RFC 3339 timestamp. */
export function day(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function versionList(view: PackageView): SafeHtml {
  const items = view.versions.map(
    (v) =>
      markup`<li><code>${v.version}</code>${v.yanked ? markup` <span class="badge warn">yanked</span>` : ""} <time datetime="${v.published}">${day(v.published)}</time></li>`,
  );
  return markup`<ul class="versions">${items}</ul>`;
}

function dependencyRows(dependencies: readonly PackageDependency[]): SafeHtml {
  if (dependencies.length === 0) return markup`<p class="hint">None in this registry.</p>`;
  const rows = dependencies.map(
    (d) =>
      markup`<tr><td>${d.name}</td><td>${d.constraints.map((c) => markup`<code>${c}</code> `)}</td><td>${d.versions.join(", ")}</td></tr>`,
  );
  return markup`<div class="table-wrap"><table>
<thead><tr><th>Package</th><th>Constraints</th><th>Versions</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

function packageBlock(view: PackageView): SafeHtml {
  const dependencies = view.dependencies ?? [];
  return markup`<article class="package">
<h3>${view.name}</h3>
${versionList(view)}
<details class="dependencies">
<summary>Dependencies (${dependencies.length})</summary>
${dependencyRows(dependencies)}
</details>
</article>`;
}

/** The one-line note about the placeholders the snippets of a section use. */
function placeholderNote(snippets: readonly Snippet[]): SafeHtml {
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
  return markup`<p class="hint">In the snippets, ${joined}.</p>`;
}

function snippetBlock(snippets: readonly Snippet[]): SafeHtml {
  if (snippets.length === 0) return markup``;
  const blocks = snippets.map((s) => copyBlock(s.body, s.title));
  return markup`<h3>Configuration</h3>
${placeholderNote(snippets)}
${blocks}`;
}

function section(s: ConsumerSection): SafeHtml {
  const packages =
    s.packages.length === 0
      ? markup`<p class="hint">No packages are published under your grants yet.</p>`
      : s.packages.map(packageBlock);
  return markup`<section class="card eco" id="${s.eco}">
<h2>${ECO_NAMES[s.eco]}</h2>
${packages}
${snippetBlock(s.snippets)}
</section>`;
}

/** The consumer view. */
export function consumerPage(ctx: PageContext, sections: readonly ConsumerSection[]): string {
  const content =
    sections.length === 0
      ? markup`<section class="card"><p>This credential has no grants yet. Ask an administrator for access.</p></section>`
      : sections.map(section);
  return layout(
    ctx,
    "Packages",
    markup`<h1>Your packages</h1>
${content}`,
  );
}
