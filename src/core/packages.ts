/**
 * Package listing for the home page, the panel and the CLI (docs/api.md 6.6–6.7). `read`
 * credentials see only the versions their grants cover; `admin` sees everything; `publish`
 * credentials may not list packages.
 */

import { enabledAdapters, getAdapter } from "../adapters/index";
import type { Adapter, Eco, Manifest } from "../adapters/types";
import type { Env } from "../env";
import { toPackageVersion, type PackageVersion } from "./admin";
import { requireKind, type Identity } from "./auth";
import { ValidationError } from "./errors";
import { isAllowed, isPackageAllowed } from "./grants";
import { listManifests, readPackagesMeta } from "./storage";

export type PackagesEnv = Pick<Env, "R2_BUCKET" | "ECOSYSTEMS">;

/** One package with the versions the caller may see, highest first. */
export interface PackageView {
  eco: Eco;
  /** Decoded name, e.g. `@acme/sdk`. */
  name: string;
  versions: PackageVersion[];
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

async function packageView(
  env: PackagesEnv,
  identity: Identity,
  adapter: Adapter,
  name: string,
): Promise<PackageView> {
  const manifests = await listManifests(env, adapter.eco, name, adapter.compareVersions);
  return { eco: adapter.eco, name, versions: visibleVersions(identity, adapter, manifests) };
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
    const names = Object.keys(meta[adapter.eco])
      .filter((name) => mayList(identity, adapter.eco, name))
      .sort(byteOrder);
    const views = await Promise.all(names.map((name) => packageView(env, identity, adapter, name)));
    packages.push(...views.filter((view) => view.versions.length > 0));
  }
  return { packages };
}

/**
 * `GET /api/v1/packages/<eco>/<name>`: one package; `404` when it does not exist or, for
 * `read`, when no version of it is covered by the grants.
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
  const view = await packageView(env, identity, adapter, name);
  if (view.versions.length === 0) throw notFound;
  return view;
}
