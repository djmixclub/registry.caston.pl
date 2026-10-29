/**
 * The admin side of package groups (`src/core/groups.ts`): the controls of the "Organize" mode
 * of `/admin/packages` (move the checked packages to a group, to none, or to a new one), the
 * group switcher of an admin's package page and the page `/admin/packages/groups` that creates,
 * renames, moves and deletes groups. Every control is a plain form post, so all of it works
 * without scripts.
 */

import {
  MAX_GROUP_NAME_LENGTH,
  descendantIds,
  flattenGroups,
  groupPath,
  parentChoices,
  type Group,
  type PackageGroups,
} from "../core/groups";
import { errorMessage } from "./components";
import { backLink, breadcrumbs, plural } from "./catalog";
import { markup, type SafeHtml } from "./html";
import { layout, type PageContext } from "./layout";

/** Where the forms of this module post. */
export const MOVE_ACTION = "/admin/packages/move";
export const GROUPS_PAGE = "/admin/packages/groups";

/** A group's name in a list of choices, indented by its level. */
function indented(group: Group, depth: number): string {
  return `${"   ".repeat(depth - 1)}${group.name}`;
}

/** `<option>`s of every group in tree order; `selected` is the id to preselect. */
function groupOptions(
  choices: readonly { group: Group; depth: number }[],
  selected: string | null = null,
): SafeHtml {
  return markup`${choices.map(
    ({ group, depth }) =>
      markup`<option value="${group.id}"${selected === group.id ? " selected" : ""}>${indented(group, depth)}</option>`,
  )}`;
}

/** "A › B › C": the names from the top group down to the group. */
export function groupLabel(state: PackageGroups, id: string): string {
  return groupPath(state, id)
    .map((g) => g.name)
    .join(" › ");
}

/**
 * The controls under the list in Organize mode: a counter and "select all shown" (scripts),
 * the group to move the checked packages to and, as an alternative, a new group to create for
 * them.
 */
export function organizeToolbar(state: PackageGroups): SafeHtml {
  return markup`<div class="organize-bar" data-organize-bar>
<p class="organize-count"><span data-select-count>0</span> selected <button type="button" class="secondary small" data-select-shown hidden>Select all shown</button> <button type="button" class="secondary small" data-select-none hidden>Clear</button></p>
<div class="organize-fields">
<div>
<label for="move-target">Move to</label>
<select name="target" id="move-target">
<option value="">Ungrouped</option>
${groupOptions(flattenGroups(state))}
</select>
</div>
<div>
<label for="move-new-name">…or a new group</label>
<input type="text" name="new_name" id="move-new-name" maxlength="${MAX_GROUP_NAME_LENGTH}" autocomplete="off" placeholder="Name of a new group">
</div>
<div>
<label for="move-new-parent">…inside</label>
<select name="new_parent" id="move-new-parent">
<option value="">The top level</option>
${groupOptions(parentChoices(state, null))}
</select>
</div>
<button type="submit">Move selected</button>
</div>
</div>`;
}

/** The group of an admin's package page, with a form to move the package to another one. */
export function packageGroupSwitcher(
  state: PackageGroups,
  key: string,
  current: string | null,
): SafeHtml {
  const where =
    current === null || groupPath(state, current).length === 0
      ? markup`<span class="muted">Ungrouped</span>`
      : markup`<a href="/admin/packages#group-${current}">${groupLabel(state, current)}</a>`;
  const choices = flattenGroups(state);
  return markup`<form method="post" action="${MOVE_ACTION}" class="group-switch">
<input type="hidden" name="package" value="${key}">
<input type="hidden" name="return" value="package">
<span class="group-switch-label">Group:</span> ${where}
<select name="target" aria-label="Move this package to">
<option value=""${current === null ? " selected" : ""}>Ungrouped</option>
${groupOptions(choices, current)}
</select>
<button type="submit" class="secondary small">Move</button>
</form>`;
}

/** What `/admin/packages/groups` shows. */
export interface GroupsPageData {
  state: PackageGroups;
  /** The number of packages directly in each group, by id. */
  counts: ReadonlyMap<string, number>;
  /** Set after a change. */
  notice?: string;
  /** Set when a change was refused. */
  error?: string;
}

function groupRow(
  state: PackageGroups,
  counts: GroupsPageData["counts"],
  group: Group,
  depth: number,
) {
  const href = `${GROUPS_PAGE}/${encodeURIComponent(group.id)}`;
  const inside = descendantIds(state, group.id);
  const own = counts.get(group.id) ?? 0;
  const total = inside.reduce((sum, id) => sum + (counts.get(id) ?? 0), own);
  const subgroups = inside.length === 0 ? "" : markup`, ${plural(inside.length, "subgroup")}`;
  const choices = parentChoices(state, group.id);
  return markup`<li class="group-row depth-${depth}" id="group-${group.id}">
<form method="post" action="${href}" class="group-edit">
<div class="group-edit-name">
<label for="name-${group.id}">Name</label>
<input type="text" id="name-${group.id}" name="name" value="${group.name}" maxlength="${MAX_GROUP_NAME_LENGTH}" required autocomplete="off">
</div>
<div class="group-edit-parent">
<label for="parent-${group.id}">Inside</label>
<select id="parent-${group.id}" name="parent">
<option value=""${group.parent === null ? " selected" : ""}>The top level</option>
${groupOptions(choices, group.parent)}
</select>
</div>
<button type="submit" class="secondary small">Save</button>
</form>
<p class="group-meta hint">${plural(total, "package")}${subgroups}. <a href="/admin/packages#group-${group.id}">Show in the list</a></p>
<form method="post" action="${href}/delete" class="group-delete">
<button type="submit" class="danger small" aria-label="Delete the group ${group.name}">Delete</button>
</form>
</li>`;
}

/** `GET /admin/packages/groups`. */
export function groupsPage(ctx: PageContext, data: GroupsPageData): string {
  const { state } = data;
  const notice =
    data.notice === undefined ? "" : markup`<p class="notice" role="status">${data.notice}</p>`;
  const rows = flattenGroups(state);
  const list =
    rows.length === 0
      ? markup`<div class="pkg-empty"><p>There are no groups yet.</p><p class="hint">Create one above, then use Organize on the package list to put packages in it.</p></div>`
      : markup`<ul class="group-list">
${rows.map(({ group, depth }) => groupRow(state, data.counts, group, depth))}
</ul>`;
  return layout(
    ctx,
    "Package groups",
    markup`<div class="catalog wide">
${breadcrumbs([{ label: "Packages", href: "/admin/packages" }, { label: "Groups" }])}
<h1>Package groups</h1>
<p class="consumer-lead">Groups only organise the package list in the panel and on the home page of read credentials. They change nothing about access. A package is in one group at most, and groups nest up to three levels.</p>
${notice}${errorMessage(data.error)}
<section class="section" aria-labelledby="new-group">
<h2 id="new-group">New group</h2>
<form method="post" action="${GROUPS_PAGE}" class="box group-new">
<div>
<label for="group-name">Name</label>
<input type="text" id="group-name" name="name" maxlength="${MAX_GROUP_NAME_LENGTH}" required autocomplete="off">
</div>
<div>
<label for="group-parent">Inside</label>
<select id="group-parent" name="parent">
<option value="">The top level</option>
${groupOptions(parentChoices(state, null))}
</select>
</div>
<button type="submit">Create group</button>
</form>
</section>
<section class="section" aria-labelledby="all-groups">
<h2 id="all-groups">Groups</h2>
<p class="hint">Deleting a group keeps its packages and subgroups: they move up one level.</p>
${list}
</section>
${backLink("/admin/packages", "All packages")}
</div>`,
    { page: "groups", section: "packages" },
  );
}
