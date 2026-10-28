/**
 * The package page (`GET /packages/<eco>/<name>`): the ecosystem badge and name, the versions
 * the credential may see (each a link to its version page, with the publication date, the
 * yanked marker and the number of files), the dependencies its grant opens transitively
 * (collapsed; omitted when there are none) and the ready-to-paste configuration for this
 * package with copy buttons.
 */

import type { Snippet } from "../adapters/types";
import type { PackageDependency, PackageView } from "../core/packages";
import {
  backLink,
  breadcrumbs,
  day,
  ecoBadge,
  packageHref,
  placeholderNote,
  plural,
  snippetBlock,
  versionHref,
} from "./catalog";
import { markup, type SafeHtml } from "./html";
import { layout, type PageContext } from "./layout";

/** What the package page shows. */
export interface PackagePageData {
  /** The package with the versions the credential may see, highest first. */
  view: PackageView;
  /** `adapter.clientConfig` for this package, with placeholders instead of the token. */
  snippets: Snippet[];
  /** The package is visible only through the dependencies of another package's grant. */
  transitive?: boolean;
}

function versionList(view: PackageView): SafeHtml {
  const items = view.versions.map(
    (v) => markup`<li class="version-row">
<a class="version" href="${versionHref(view.eco, view.name, v.version)}">${v.version}</a>
${v.yanked ? markup`<span class="badge warn">yanked</span>` : ""}
<span class="version-meta"><time datetime="${v.published}">${day(v.published)}</time> · ${plural(v.files.length, "file")}</span>
</li>`,
  );
  return markup`<section class="pkg-section" aria-labelledby="versions">
<h2 id="versions">Versions</h2>
<ul class="version-list">
${items}
</ul>
</section>`;
}

/** The collapsed dependencies of a package; nothing when it has none in this registry. */
function dependencies(view: PackageView): SafeHtml {
  const deps: readonly PackageDependency[] = view.dependencies ?? [];
  if (deps.length === 0) return markup``;
  const items = deps.map(
    (d) => markup`<li>
<a href="${packageHref(view.eco, d.name)}">${d.name}</a>
<span class="dep-meta">${d.constraints.join(", ")} → ${d.versions.join(", ")}</span>
</li>`,
  );
  return markup`<details class="dependencies">
<summary>Dependencies (${deps.length})</summary>
<p class="hint">Packages this grant also opens, with the constraints that lead to them and the versions you may install.</p>
<ul class="dep-list">
${items}
</ul>
</details>`;
}

function configuration(snippets: readonly Snippet[]): SafeHtml {
  if (snippets.length === 0) return markup``;
  return markup`<section class="pkg-section" aria-labelledby="configuration">
<h2 id="configuration">Configuration</h2>
${placeholderNote(snippets)}
${snippets.map(snippetBlock)}
</section>`;
}

/** The package page. */
export function packagePage(ctx: PageContext, data: PackagePageData): string {
  const { view } = data;
  const top = view.versions[0];
  const latest =
    top === undefined
      ? ""
      : markup` · latest <span class="version">${top.version}</span>${top.yanked ? markup` <span class="badge warn">yanked</span>` : ""}`;
  const via = data.transitive
    ? markup`<p class="hint">Available as a dependency of a package granted to this credential.</p>`
    : "";
  return layout(
    ctx,
    view.name,
    markup`<div class="catalog">
${breadcrumbs([{ label: "Packages", href: "/" }, { label: view.name }])}
<header class="pkg-header">
${ecoBadge(view.eco)}
<h1>${view.name}</h1>
<p class="pkg-meta">${plural(view.versions.length, "version")}${latest}</p>
${via}
</header>
${versionList(view)}
${dependencies(view)}
${configuration(data.snippets)}
${backLink("/", "All packages")}
</div>`,
  );
}
