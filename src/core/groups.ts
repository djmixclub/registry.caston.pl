/**
 * Package groups: labels the admin panel and the consumers' home page use to organise the
 * package list. They change nothing else: no grant, index, protocol or `/api/v1` response knows
 * about them. The whole state is one KV value (`pkg-groups`), global to the installation.
 *
 * Groups form a tree at most {@link MAX_GROUP_DEPTH} levels deep; a package belongs to at most
 * one group (the map `packages` keeps that structurally), or to none ("Ungrouped"). Siblings
 * are listed by name, like packages.
 */

import { isEco, type Eco } from "../adapters/types";
import type { Env } from "../env";
import { ValidationError } from "./errors";
import { IsolateCache } from "./isolatecache";
import { compareNames, sortKey } from "./sort";

/** The KV key of the groups. */
export const GROUPS_KEY = "pkg-groups";

/** The levels of nesting: a group at the top is level 1. */
export const MAX_GROUP_DEPTH = 3;

/** The most groups an installation can have. */
export const MAX_GROUPS = 200;

/** The longest name of a group, in characters. */
export const MAX_GROUP_NAME_LENGTH = 60;

/** One group; `parent` is `null` at the top. */
export interface Group {
  id: string;
  name: string;
  parent: string | null;
}

/** The groups and the group of each package that has one, by {@link packageGroupKey}. */
export interface PackageGroups {
  groups: Group[];
  packages: Record<string, string>;
}

/** No group at all. */
export const NO_GROUPS: PackageGroups = { groups: [], packages: {} };

/** The identifier of a package in `PackageGroups.packages` and in forms: `<eco>:<name>`. */
export function packageGroupKey(eco: Eco, name: string): string {
  // NuGet and Swift names compare without regard to case, and the listing's casing follows the
  // newest manifest, so the key must not.
  const stored = eco === "nuget" || eco === "swift" ? name.toLowerCase() : name;
  return `${eco}:${stored}`;
}

/** The ecosystem and name of a key made by {@link packageGroupKey}, or `null`. */
export function parsePackageGroupKey(key: string): { eco: Eco; name: string } | null {
  const at = key.indexOf(":");
  if (at < 1) return null;
  const eco = key.slice(0, at);
  const name = key.slice(at + 1);
  return isEco(eco) && name !== "" ? { eco, name } : null;
}

// ---------------------------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------------------------

const GROUP_ID = /^[a-z0-9]{4,32}$/;

/** The groups and assignments of a stored value that are consistent; the rest is dropped. */
export function normalizeGroups(value: unknown): PackageGroups {
  if (typeof value !== "object" || value === null) return { groups: [], packages: {} };
  const raw = value as { groups?: unknown; packages?: unknown };
  const seen = new Map<string, Group>();
  if (Array.isArray(raw.groups)) {
    for (const item of raw.groups) {
      if (typeof item !== "object" || item === null) continue;
      const { id, name, parent } = item as Record<string, unknown>;
      if (typeof id !== "string" || !GROUP_ID.test(id) || seen.has(id)) continue;
      if (typeof name !== "string" || name === "" || name.length > MAX_GROUP_NAME_LENGTH) continue;
      seen.set(id, { id, name, parent: typeof parent === "string" ? parent : null });
    }
  }
  // A parent that is missing, a cycle or a chain deeper than allowed: the group moves to the top.
  const groups = [...seen.values()];
  for (const group of groups) {
    let depth = 1;
    let at: Group | undefined = group;
    const path = new Set<string>([group.id]);
    while (at?.parent != null) {
      const next: Group | undefined = seen.get(at.parent);
      if (next === undefined || path.has(next.id) || depth >= MAX_GROUP_DEPTH) {
        group.parent = null;
        break;
      }
      path.add(next.id);
      depth++;
      at = next;
    }
  }
  const packages: Record<string, string> = {};
  if (typeof raw.packages === "object" && raw.packages !== null) {
    for (const [key, id] of Object.entries(raw.packages)) {
      if (typeof id === "string" && seen.has(id) && parsePackageGroupKey(key) !== null) {
        packages[key] = id;
      }
    }
  }
  return { groups, packages };
}

const groupsCache = new IsolateCache<PackageGroups>();

/** Forgets the isolate's copy of the groups (tests). */
export function resetGroupsCache(): void {
  groupsCache.clear();
}

export interface ReadGroupsOptions {
  /** Current time in ms since the epoch, for the cache's TTL. */
  now?: number;
  /** Skip the isolate cache (read-modify-write paths); the result is cached again. */
  fresh?: boolean;
}

/**
 * The groups; none when the value is missing or unreadable. Served from the isolate cache for
 * up to 60 seconds unless `fresh`; {@link writeGroups} updates it.
 */
export async function readGroups(
  env: Pick<Env, "AUTH">,
  options: ReadGroupsOptions = {},
): Promise<PackageGroups> {
  const now = options.now ?? Date.now();
  const cached = options.fresh ? undefined : groupsCache.get(GROUPS_KEY, now);
  if (cached !== undefined) return cached;
  const text = await env.AUTH.get(GROUPS_KEY, "text");
  let groups: PackageGroups = { groups: [], packages: {} };
  if (text !== null) {
    try {
      groups = normalizeGroups(JSON.parse(text));
    } catch {
      groups = { groups: [], packages: {} };
    }
  }
  groupsCache.set(GROUPS_KEY, groups, now);
  return groups;
}

/** Writes the groups (no TTL) and caches them in this isolate. */
export async function writeGroups(env: Pick<Env, "AUTH">, groups: PackageGroups): Promise<void> {
  const text = JSON.stringify(groups);
  await env.AUTH.put(GROUPS_KEY, text);
  groupsCache.set(GROUPS_KEY, normalizeGroups(JSON.parse(text)));
}

// ---------------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------------

/** The group with this id. */
export function findGroup(state: PackageGroups, id: string): Group | undefined {
  return state.groups.find((g) => g.id === id);
}

/** The groups from the top down to this one; empty when the id is unknown. */
export function groupPath(state: PackageGroups, id: string): Group[] {
  const path: Group[] = [];
  let at = findGroup(state, id);
  while (at !== undefined && path.length < MAX_GROUP_DEPTH) {
    path.unshift(at);
    at = at.parent === null ? undefined : findGroup(state, at.parent);
  }
  return path;
}

/** The level of a group: 1 at the top. */
export function groupDepth(state: PackageGroups, id: string): number {
  return groupPath(state, id).length;
}

/** The ids of the group's descendants, children first. */
export function descendantIds(state: PackageGroups, id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const at = queue.shift();
    for (const g of state.groups) {
      if (g.parent === at) {
        out.push(g.id);
        queue.push(g.id);
      }
    }
  }
  return out;
}

/** How many levels the group and its descendants take: 1 for a group without children. */
export function groupHeight(state: PackageGroups, id: string): number {
  const children = state.groups.filter((g) => g.parent === id);
  return 1 + Math.max(0, ...children.map((c) => groupHeight(state, c.id)));
}

/** The children of a group (`null`: the top level), sorted by name. */
export function childrenOf(state: PackageGroups, parent: string | null): Group[] {
  return state.groups
    .filter((g) => g.parent === parent)
    .sort((a, b) => compareNames(a.name, b.name));
}

/** The group a package is in, or `null`. */
export function groupOf(state: PackageGroups, eco: Eco, name: string): string | null {
  return state.packages[packageGroupKey(eco, name)] ?? null;
}

/** Every group in tree order (parents before their children, siblings by name) with its level. */
export function flattenGroups(state: PackageGroups): { group: Group; depth: number }[] {
  const out: { group: Group; depth: number }[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const group of childrenOf(state, parent)) {
      out.push({ group, depth });
      walk(group.id, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}

/**
 * The groups a group (`id`) can be put in, or with `id` `null` a new group can be created in:
 * not itself or what is inside it, and not so deep that the nesting limit is passed.
 */
export function parentChoices(
  state: PackageGroups,
  id: string | null,
): { group: Group; depth: number }[] {
  const levels = id === null ? 1 : groupHeight(state, id);
  const inside = id === null ? [] : [id, ...descendantIds(state, id)];
  return flattenGroups(state).filter(
    ({ group, depth }) => !inside.includes(group.id) && depth + levels <= MAX_GROUP_DEPTH,
  );
}

// ---------------------------------------------------------------------------------------------
// Changes (pure: each returns the new state or throws a ValidationError)
// ---------------------------------------------------------------------------------------------

function invalid(message: string): ValidationError {
  return new ValidationError("invalid_request", message);
}

/** A group name: trimmed, inner whitespace collapsed; at most {@link MAX_GROUP_NAME_LENGTH}. */
export function cleanGroupName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name === "") throw invalid("Give the group a name.");
  if (name.length > MAX_GROUP_NAME_LENGTH) {
    throw invalid(`A group name has at most ${MAX_GROUP_NAME_LENGTH} characters.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name))
    throw invalid("A group name cannot hold control characters.");
  return name;
}

function checkSiblings(state: PackageGroups, name: string, parent: string | null, self?: string) {
  const key = sortKey(name) || name.toLowerCase();
  const clash = state.groups.some(
    (g) =>
      g.parent === parent && g.id !== self && (sortKey(g.name) || g.name.toLowerCase()) === key,
  );
  if (clash) throw invalid(`There is already a group called ${name} here.`);
}

function checkParent(state: PackageGroups, parent: string | null, levels: number): void {
  if (parent === null) return;
  if (findGroup(state, parent) === undefined) throw invalid("That group does not exist.");
  if (groupDepth(state, parent) + levels > MAX_GROUP_DEPTH) {
    throw invalid(`Groups can be nested ${MAX_GROUP_DEPTH} levels deep at most.`);
  }
}

/** A new group at the top or inside `parent`; `id` identifies it. */
export function createGroup(
  state: PackageGroups,
  rawName: string,
  parent: string | null,
  id: string,
): PackageGroups {
  const name = cleanGroupName(rawName);
  if (state.groups.length >= MAX_GROUPS) {
    throw invalid(`An installation can have ${MAX_GROUPS} groups at most.`);
  }
  checkParent(state, parent, 1);
  checkSiblings(state, name, parent);
  return { ...state, groups: [...state.groups, { id, name, parent }] };
}

/** Renames a group and/or moves it (with everything in it) to another parent. */
export function updateGroup(
  state: PackageGroups,
  id: string,
  change: { name?: string; parent?: string | null },
): PackageGroups {
  const group = findGroup(state, id);
  if (group === undefined) throw invalid("That group does not exist.");
  const name = change.name === undefined ? group.name : cleanGroupName(change.name);
  const parent = change.parent === undefined ? group.parent : change.parent;
  if (parent === id || (parent !== null && descendantIds(state, id).includes(parent))) {
    throw invalid("A group cannot be moved into itself.");
  }
  checkParent(state, parent, groupHeight(state, id));
  checkSiblings(state, name, parent, id);
  return {
    ...state,
    groups: state.groups.map((g) => (g.id === id ? { ...g, name, parent } : g)),
  };
}

/**
 * Deletes a group: its subgroups and packages move up to its parent (to "Ungrouped" when it
 * was at the top). A subgroup whose name is taken in the parent is refused.
 */
export function deleteGroup(state: PackageGroups, id: string): PackageGroups {
  const group = findGroup(state, id);
  if (group === undefined) throw invalid("That group does not exist.");
  const rest: PackageGroups = { ...state, groups: state.groups.filter((g) => g.id !== id) };
  for (const child of state.groups.filter((g) => g.parent === id)) {
    checkSiblings(rest, child.name, group.parent, child.id);
  }
  const groups = rest.groups.map((g) => (g.parent === id ? { ...g, parent: group.parent } : g));
  const packages: Record<string, string> = {};
  for (const [key, at] of Object.entries(state.packages)) {
    if (at !== id) packages[key] = at;
    else if (group.parent !== null) packages[key] = group.parent;
  }
  return { groups, packages };
}

/** Puts packages in a group, or in none (`null`); every package ends up in at most one. */
export function assignPackages(
  state: PackageGroups,
  keys: readonly string[],
  target: string | null,
): PackageGroups {
  if (target !== null && findGroup(state, target) === undefined) {
    throw invalid("That group does not exist.");
  }
  const moved = new Set(keys);
  const packages: Record<string, string> = Object.fromEntries(
    Object.entries(state.packages).filter(([key]) => !moved.has(key)),
  );
  if (target !== null) for (const key of moved) packages[key] = target;
  return { ...state, packages };
}

/** Forgets the assignments of packages that are no longer in the registry. */
export function pruneAssignments(
  state: PackageGroups,
  existing: ReadonlySet<string>,
): PackageGroups {
  const packages: Record<string, string> = {};
  for (const [key, at] of Object.entries(state.packages)) {
    if (existing.has(key)) packages[key] = at;
  }
  return { ...state, packages };
}

/** A fresh group id: 12 lower-case hex characters. */
export function newGroupId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
