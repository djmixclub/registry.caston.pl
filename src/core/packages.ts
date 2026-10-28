/**
 * Package listing for the home page, the panel and the CLI (docs/api.md 6.6–6.7). `read`
 * credentials see only the versions their explicit grants cover, and under each package the
 * dependencies its grant opens transitively (5.3); `admin` sees everything; `publish`
 * credentials may not list packages.
 */

import { enabledAdapters, getAdapter } from "../adapters/index";
import type { Adapter, Eco, Manifest } from "../adapters/types";
import type { Env } from "../env";
import { toPackageVersion, type PackageVersion } from "./admin";
import { requireKind, type Identity } from "./auth";
import { PackageGraph, transitiveSources, walkDependencies } from "./closure";
import { ValidationError } from "./errors";
import { isAllowed, isPackageAllowed } from "./grants";
import { readPackagesMeta } from "./storage";

export type PackagesEnv = Pick<Env, "R2_BUCKET" | "ECOSYSTEMS">;

/** A package that a grant opens transitively (docs/api.md 5.3 and 6.6). */
export interface PackageDependency {
  name: string;
  /** The distinct declared constraints that lead to the package, as written. */
  constraints: string[];
  /** The versions opened, highest first. */
  versions: string[];
}

/** One package with the versions the caller may see, highest first. */
export interface PackageView {
  eco: Eco;
  /** Decoded name, e.g. `@acme/sdk`. */
  name: string;
  versions: PackageVersion[];
  /** `read` only: what the package's grant opens transitively, sorted by name. */
  dependencies?: PackageDependency[];
}

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether the caller may see the package at all (any version). */
function mayList(identity: Identity, eco: Eco, name: string): boolean {
  return identity.kind === "admin" || isPackageAllowed(identity.grants, eco, name);
}

/** The versions of a package the caller may see, highest first; yanked ones included. */
function visibleVersions(
  identity: Identity,
  adapter: Adapter,
  manifests: readonly Manifest[],
): PackageVersion[] {
  return manifests
    .filter(
      (m) =>
        identity.kind === "admin" ||
        isAllowed(identity.grants, adapter.eco, m.name, m.version, adapter.satisfies),
    )
    .map(toPackageVersion)
    .reverse();
}

/**
 * The packages and versions that the transitive grants covering a package open from it, direct
 * and indirect, flattened and sorted by name (byte order); the package itself is left out.
 */
async function dependenciesOf(
  graph: PackageGraph,
  identity: Identity,
  name: string,
): Promise<PackageDependency[]> {
  const sources = await transitiveSources(graph, identity, name);
  if (sources.length === 0) return [];
  const reached = await walkDependencies(graph, sources);
  const compare = graph.adapter.compareVersions;
  return [...reached.entries()]
    .filter(([dep, entry]) => dep !== name && entry.versions.size > 0)
    .sort(([a], [b]) => byteOrder(a, b))
    .map(([dep, entry]) => ({
      name: dep,
      constraints: entry.constraints,
      versions: [...entry.versions].sort((a, b) => compare(b, a)),
    }));
}

async function packageView(
  graph: PackageGraph,
  identity: Identity,
  name: string,
): Promise<PackageView> {
  const { adapter } = graph;
  const manifests = await graph.manifests(name);
  const view: PackageView = {
    eco: adapter.eco,
    name,
    versions: visibleVersions(identity, adapter, manifests),
  };
  if (identity.kind === "read" && view.versions.length > 0) {
    view.dependencies = await dependenciesOf(graph, identity, name);
  }
  return view;
}

/**
 * `GET /api/v1/packages`: every package of the enabled ecosystems with at least one visible
 * version, sorted by ecosystem and name (byte order).
 */
export async function listPackages(
  env: PackagesEnv,
  identity: Identity,
): Promise<{ packages: PackageView[] }> {
  requireKind(identity, "read", "admin");
  const meta = await readPackagesMeta(env);
  const adapters = enabledAdapters(env).sort((a, b) => byteOrder(a.eco, b.eco));
  const packages: PackageView[] = [];
  for (const adapter of adapters) {
    const graph = new PackageGraph(env, adapter, Object.keys(meta[adapter.eco]));
    const names = graph.names
      .filter((name) => mayList(identity, adapter.eco, name))
      .sort(byteOrder);
    const views = await Promise.all(names.map((name) => packageView(graph, identity, name)));
    packages.push(...views.filter((view) => view.versions.length > 0));
  }
  return { packages };
}

/**
 * `GET /api/v1/packages/<eco>/<name>`: one package; `404` when it does not exist or, for
 * `read`, when no version of it is covered by an explicit grant (a package reachable only
 * transitively is listed under the `dependencies` of its source package instead).
 */
export async function getPackage(
  env: PackagesEnv,
  identity: Identity,
  eco: string,
  name: string,
): Promise<PackageView> {
  requireKind(identity, "read", "admin");
  const notFound = new ValidationError("not_found", "Package not found.");
  const adapter = getAdapter(env, eco);
  if (adapter === null || !mayList(identity, adapter.eco, name)) throw notFound;
  const view = await packageView(await PackageGraph.load(env, adapter), identity, name);
  if (view.versions.length === 0) throw notFound;
  return view;
}
