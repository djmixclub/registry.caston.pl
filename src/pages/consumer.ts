/**
 * The consumer view (kind `read`): every package of the credential's explicit grants in one
 * list sorted by name, each row a link to its package page (`src/pages/package.ts`) with the
 * ecosystem badge, the number of versions and the latest version (marked when yanked). A
 * filter bar (name and ecosystem) is rendered hidden and enabled by `public/app.js`, which
 * only hides rows and, while a filter is active, says how many rows are shown in the lead line;
 * without JavaScript the full list stays usable. The admin package list (`src/pages/admin.ts`)
 * is the same list with actions at the end of each row. With package groups
 * (`src/core/groups.ts`) the list is split into collapsible sections, "Ungrouped" first, and the
 * filter bar gets a chip per group; the admin's "organize" mode adds a checkbox to every row.
 */

import type { Eco } from "../adapters/types";
import {
  childrenOf,
  groupOf,
  groupPath,
  packageGroupKey,
  type Group,
  type PackageGroups,
} from "../core/groups";
import type { PackageSummary } from "../core/packages";
import { sortPackages } from "../core/sort";
import { ECO_NAMES, ecoBadge, packageHref, plural } from "./catalog";
import { markup, type SafeHtml } from "./html";
import { layout, type PageContext } from "./layout";

// The admin view imports these from here.
export { day, ECO_NAMES } from "./catalog";

/** The message shown when the credential has no package. */
export const NO_PACKAGES = "No packages are granted to this credential yet.";

export { sortPackages };

function latest(view: PackageSummary): SafeHtml {
  const top = view.versions[0];
  if (top === undefined) return markup``;
  const yanked = top.yanked ? markup` <span class="badge warn">yanked</span>` : "";
  return markup`<span class="pkg-latest">latest <span class="version">${top.version}</span>${yanked}</span>`;
}

/** Actions shown at the end of a package's row (the admin list). */
export type RowActions = (view: PackageSummary) => SafeHtml;

function row(
  view: PackageSummary,
  actions?: RowActions,
  groups: readonly string[] = [],
  select = false,
): SafeHtml {
  const link = markup`<a class="pkg-link" href="${packageHref(view.eco, view.name)}">
${ecoBadge(view.eco)}
<span class="pkg-name">${view.name}</span>
<span class="pkg-meta"><span>${plural(view.versions.length, "version")}</span>${latest(view)}</span>
</a>`;
  const end =
    actions === undefined ? "" : markup`\n<div class="pkg-actions">${actions(view)}</div>`;
  const start = select
    ? markup`<label class="pkg-select"><input type="checkbox" name="package" value="${packageGroupKey(view.eco, view.name)}" data-select-row aria-label="Select ${view.name}"></label>\n`
    : "";
  const boxed = actions !== undefined || select;
  const where = groups.length === 0 ? "" : markup` data-groups="${groups.join(" ")}"`;
  return markup`<li class="pkg-row${boxed ? " with-actions" : ""}${select ? " with-select" : ""}" data-pkg-row data-eco="${view.eco}" data-name="${view.name.toLowerCase()}"${where}>
${start}${link}${end}
</li>`;
}

/** The ecosystems present, sorted by display name. */
function ecosystemsOf(packages: readonly PackageSummary[]): Eco[] {
  return [...new Set(packages.map((p) => p.eco))].sort((a, b) =>
    ECO_NAMES[a].localeCompare(ECO_NAMES[b], "en"),
  );
}

/** A chip that narrows the list to one group (and what is inside it). */
interface GroupChip {
  id: string;
  label: string;
}

/**
 * The filter bar (with two or more packages): a labelled name filter, with two or more
 * ecosystems a toggle chip per ecosystem and with two or more groups a toggle chip per group.
 * Hidden until `public/app.js` enables it.
 */
function filterBar(
  packages: readonly PackageSummary[],
  groupChips: readonly GroupChip[] = [],
): SafeHtml {
  if (packages.length < 2) return markup``;
  const ecos = ecosystemsOf(packages);
  const chips =
    ecos.length < 2
      ? ""
      : markup`<div class="pkg-chips" role="group" aria-label="Ecosystems">
${ecos.map((eco) => markup`<button type="button" class="chip" data-filter-eco="${eco}" aria-pressed="false">${ECO_NAMES[eco]}</button>`)}
</div>`;
  const groups =
    groupChips.length < 2
      ? ""
      : markup`<div class="pkg-chips" role="group" aria-label="Groups">
${groupChips.map((chip) => markup`<button type="button" class="chip" data-filter-group="${chip.id}" aria-pressed="false">${chip.label}</button>`)}
</div>`;
  return markup`<div class="pkg-filter" data-pkg-filter hidden>
<div class="pkg-search">
<label for="pkg-filter-name">Filter by name</label>
<input type="search" id="pkg-filter-name" data-filter-name autocomplete="off" spellcheck="false">
</div>
${chips}
${groups}
</div>`;
}

/** The id of the pseudo group "Ungrouped" in `data-groups` and in the group chips. */
export const UNGROUPED = "_";

/** A group with the packages in it and its subgroups, for rendering. */
interface GroupNode {
  group: Group;
  /** The ids from the top group down to this one. */
  chain: string[];
  /** The packages directly in the group, sorted. */
  packages: PackageSummary[];
  children: GroupNode[];
  /** The packages in the group and below. */
  total: number;
}

/** The packages split by group; `null` when the list should not be grouped. */
interface Grouped {
  ungrouped: PackageSummary[];
  roots: GroupNode[];
}

function grouped(
  state: PackageGroups | undefined,
  sorted: readonly PackageSummary[],
  keepEmpty: boolean,
): Grouped | null {
  if (state === undefined || state.groups.length === 0) return null;
  const direct = new Map<string, PackageSummary[]>();
  const ungrouped: PackageSummary[] = [];
  for (const view of sorted) {
    const id = groupOf(state, view.eco, view.name);
    if (id === null) {
      ungrouped.push(view);
      continue;
    }
    const list = direct.get(id) ?? [];
    list.push(view);
    direct.set(id, list);
  }
  const build = (parent: string | null, above: string[]): GroupNode[] =>
    childrenOf(state, parent).flatMap((group) => {
      const chain = [...above, group.id];
      const children = build(group.id, chain);
      const packages = direct.get(group.id) ?? [];
      const total = packages.length + children.reduce((sum, c) => sum + c.total, 0);
      return total === 0 && !keepEmpty ? [] : [{ group, chain, packages, children, total }];
    });
  const roots = build(null, []);
  if (!keepEmpty && roots.length === 0) return null;
  return { ungrouped, roots };
}

function groupChipsOf(state: PackageGroups, split: Grouped): GroupChip[] {
  const chips: GroupChip[] = [];
  if (split.ungrouped.length > 0) chips.push({ id: UNGROUPED, label: "Ungrouped" });
  const walk = (nodes: readonly GroupNode[]): void => {
    for (const node of nodes) {
      if (node.total > 0) {
        const label = groupPath(state, node.group.id)
          .map((g) => g.name)
          .join(" › ");
        chips.push({ id: node.group.id, label });
      }
      walk(node.children);
    }
  };
  walk(split.roots);
  return chips;
}

/** `<details>` of one group: its name and number of packages, its rows, then its subgroups. */
function groupSection(
  node: GroupNode,
  rowOf: (view: PackageSummary, chain: string[]) => SafeHtml,
): SafeHtml {
  const rows =
    node.packages.length === 0
      ? ""
      : markup`<ul class="pkg-list">
${node.packages.map((view) => rowOf(view, node.chain))}
</ul>`;
  const nested: SafeHtml | "" =
    node.children.length === 0
      ? ""
      : markup`<div class="pkg-subgroups">
${node.children.map((child) => groupSection(child, rowOf))}
</div>`;
  const empty =
    node.total === 0
      ? markup`<p class="pkg-group-empty hint">No packages in this group yet.</p>`
      : "";
  return markup`<details class="pkg-group" id="group-${node.group.id}" open data-group-section>
<summary><span class="pkg-group-name">${node.group.name}</span> <span class="pkg-group-count">${node.total}</span></summary>
${rows}${nested}${empty}
</details>`;
}

/** Organize mode of the admin list: the form around the list and its toolbar. */
export interface Organize {
  /** Where the form posts. */
  action: string;
  /** The controls that act on the checked rows (inside the form, after the list). */
  toolbar: SafeHtml;
}

/** What {@link packageList} can add to the plain list. */
export interface ListOptions {
  /** Split the list by these groups. */
  groups?: PackageGroups;
  /** Keep groups without packages (the admin sees them to fill them). */
  keepEmptyGroups?: boolean;
  /** A checkbox on every row and a form around the list; the row `actions` are left out. */
  organize?: Organize;
}

/**
 * The sorted, filterable package list after a lead line (`N packages in M ecosystems.` and
 * `hint`), with `actions` at the end of each row when given.
 */
export function packageList(
  packages: readonly PackageSummary[],
  hint: string,
  actions?: RowActions,
  options: ListOptions = {},
): SafeHtml {
  const sorted = sortPackages(packages);
  const ecos = ecosystemsOf(sorted).length;
  const lead = `${plural(sorted.length, "package")}${ecos > 1 ? ` in ${ecos} ecosystems` : ""}. ${hint}`;
  const { organize } = options;
  const rowActions = organize === undefined ? actions : undefined;
  const select = organize !== undefined;
  const split = grouped(options.groups, sorted, options.keepEmptyGroups === true);
  let list: SafeHtml;
  let chips: GroupChip[] = [];
  if (split === null || options.groups === undefined) {
    list = markup`<ul class="pkg-list" data-pkg-list>
${sorted.map((view) => row(view, rowActions, [], select))}
</ul>`;
  } else {
    chips = groupChipsOf(options.groups, split);
    const rowOf = (view: PackageSummary, chain: string[]) => row(view, rowActions, chain, select);
    const ungrouped =
      split.ungrouped.length === 0
        ? ""
        : markup`<details class="pkg-group pkg-ungrouped" open data-group-section>
<summary><span class="pkg-group-name">Ungrouped</span> <span class="pkg-group-count">${split.ungrouped.length}</span></summary>
<ul class="pkg-list">
${split.ungrouped.map((view) => row(view, rowActions, [UNGROUPED], select))}
</ul>
</details>`;
    list = markup`<div class="pkg-grouped" data-pkg-list>
${ungrouped}
${split.roots.map((node) => groupSection(node, rowOf))}
</div>`;
  }
  const body = markup`${list}
<p class="pkg-none-match" data-pkg-empty role="status" hidden>No packages match the filter.</p>`;
  const content =
    organize === undefined
      ? body
      : markup`<form method="post" action="${organize.action}" class="organize" data-organize>
${body}
${organize.toolbar}
</form>`;
  return markup`<p class="consumer-lead" data-pkg-lead aria-live="polite">${lead}</p>
${filterBar(sorted, chips)}
${content}`;
}

/** The consumer view. */
export function consumerPage(
  ctx: PageContext,
  packages: readonly PackageSummary[],
  groups?: PackageGroups,
): string {
  const content =
    packages.length === 0
      ? markup`<div class="pkg-empty">
<p>${NO_PACKAGES}</p>
<p class="hint">Ask an administrator for access.</p>
</div>`
      : packageList(
          packages,
          "Open a package for its versions and the configuration to install it.",
          undefined,
          groups === undefined ? {} : { groups },
        );
  return layout(
    ctx,
    "Packages",
    markup`<div class="catalog">
<h1>Your packages</h1>
${content}
</div>`,
    { page: "packages" },
  );
}
