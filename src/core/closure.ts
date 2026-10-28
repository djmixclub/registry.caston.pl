/**
 * Transitive access (docs/api.md 5.3, `grants.transitive` in docs/spec.md): a `read` grant
 * also opens the versions of the packages its versions depend on, as declared in their
 * manifests, as long as those packages are in this registry. The closure is computed from the
 * dependency constraints (the adapter's `dependencies` and `satisfies`), cached in KV under
 * `closure:<project>:<eco>` for 60 seconds and dropped whenever the ecosystem's packages or
 * the credential's grants change.
 */

import type { Adapter, Eco, Manifest } from "../adapters/types";
import type { Env } from "../env";
import type { Identity } from "./auth";
import { isAllowed, isPackageAllowed, isTransitive, matchesPackage, type Grant } from "./grants";
import { listManifests, readPackagesMeta } from "./storage";
import { rfc3339 } from "./time";

export type ClosureEnv = Pick<Env, "R2_BUCKET" | "AUTH">;

/** Versions reachable transitively, by package name (as listed in `_meta/packages.json`). */
export type Closure = Map<string, Set<string>>;

/** Lifetime of a cached closure in KV, in seconds (the KV minimum). */
export const CLOSURE_TTL_SECONDS = 60;

const CLOSURE_PREFIX = "closure:";

/** KV key of the cached closure of one credential in one ecosystem. */
export function closureKey(project: string, eco: Eco): string {
  return `${CLOSURE_PREFIX}${project}:${eco}`;
}

/** The cached closure as stored in KV. */
interface StoredClosure {
  /** RFC 3339: when the closure was computed. */
  computedAt: string;
  packages: Record<string, string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredClosure(value: unknown): value is StoredClosure {
  return (
    isRecord(value) &&
    typeof value.computedAt === "string" &&
    isRecord(value.packages) &&
    Object.values(value.packages).every(
      (versions) => Array.isArray(versions) && versions.every((v) => typeof v === "string"),
    )
  );
}

/** Package names that compare case-insensitively (docs/api.md 5.1 and 5.3). */
function foldName(eco: Eco, name: string): string {
  return eco === "composer" || eco === "npm" || eco === "nuget" ? name.toLowerCase() : name;
}

/** The grants of an ecosystem that open dependencies. */
function transitiveGrants(identity: Identity, eco: Eco): Grant[] {
  return identity.grants.filter((g) => g.eco === eco && isTransitive(g));
}

/** Whether a closure is ever computed for the identity in the ecosystem. */
function needsClosure(identity: Identity, eco: Eco): boolean {
  return identity.kind === "read" && transitiveGrants(identity, eco).length > 0;
}

/**
 * The packages of one ecosystem with their manifests, read through `listManifests` at most once
 * per package within one computation.
 */
export class PackageGraph {
  private readonly loaded = new Map<string, Promise<Manifest[]>>();
  private readonly byFolded: Map<string, string>;

  constructor(
    private readonly env: Pick<Env, "R2_BUCKET">,
    readonly adapter: Adapter,
    /** Every package name of the ecosystem in `_meta/packages.json`. */
    readonly names: readonly string[],
  ) {
    this.byFolded = new Map(names.map((name) => [foldName(adapter.eco, name), name]));
  }

  /** Reads `_meta/packages.json` and returns the graph of one ecosystem. */
  static async load(env: Pick<Env, "R2_BUCKET">, adapter: Adapter): Promise<PackageGraph> {
    const meta = await readPackagesMeta(env);
    return new PackageGraph(env, adapter, Object.keys(meta[adapter.eco]).sort());
  }

  /** The registry's name of a dependency, or `null` when the package is not in the registry. */
  resolve(name: string): string | null {
    return this.byFolded.get(foldName(this.adapter.eco, name)) ?? null;
  }

  /** Every manifest of a package (yanked included), lowest version first. */
  manifests(name: string): Promise<Manifest[]> {
    let pending = this.loaded.get(name);
    if (pending === undefined) {
      pending = listManifests(this.env, this.adapter.eco, name, this.adapter.compareVersions);
      this.loaded.set(name, pending);
    }
    return pending;
  }
}

/** What a walk reached in one package. */
export interface Reached {
  /** The distinct constraints, as written, of the dependencies that point at the package. */
  constraints: string[];
  /** The versions of the package the constraints admit. */
  versions: Set<string>;
}

function versionKey(m: Manifest): string {
  return `${m.name}\u0000${m.version}`;
}

/**
 * Follows the dependencies of `sources` depth-first: every dependency on a package of the
 * registry admits the versions that satisfy its constraint (an unparsable constraint admits
 * none), and the admitted versions are followed in turn. Yanked versions take part like any
 * other; each version is visited once, so cycles end. The sources themselves are only part of
 * the result when a dependency leads back to them.
 */
export async function walkDependencies(
  graph: PackageGraph,
  sources: readonly Manifest[],
): Promise<Map<string, Reached>> {
  const { adapter } = graph;
  const reached = new Map<string, Reached>();
  const visited = new Set(sources.map(versionKey));
  const stack = [...sources];
  for (let m = stack.pop(); m !== undefined; m = stack.pop()) {
    for (const dep of adapter.dependencies(m)) {
      const target = graph.resolve(dep.name);
      if (target === null) continue;
      let entry = reached.get(target);
      if (entry === undefined) {
        entry = { constraints: [], versions: new Set() };
        reached.set(target, entry);
      }
      if (!entry.constraints.includes(dep.constraint)) entry.constraints.push(dep.constraint);
      for (const candidate of await graph.manifests(target)) {
        if (!adapter.satisfies(candidate.version, dep.constraint)) continue;
        entry.versions.add(candidate.version);
        const key = versionKey(candidate);
        if (!visited.has(key)) {
          visited.add(key);
          stack.push(candidate);
        }
      }
    }
  }
  return reached;
}

/**
 * The versions of a package that open dependencies: those covered by the identity's
 * transitive grants of the ecosystem.
 */
export async function transitiveSources(
  graph: PackageGraph,
  identity: Identity,
  name: string,
): Promise<Manifest[]> {
  const eco = graph.adapter.eco;
  const grants = transitiveGrants(identity, eco);
  if (!grants.some((g) => matchesPackage(g.package, name, eco))) return [];
  return (await graph.manifests(name)).filter((m) =>
    isAllowed(grants, eco, m.name, m.version, graph.adapter.satisfies),
  );
}

async function computeFresh(
  env: ClosureEnv,
  identity: Identity,
  eco: Eco,
  adapter: Adapter,
): Promise<Closure> {
  const graph = await PackageGraph.load(env, adapter);
  const sources: Manifest[] = [];
  for (const name of graph.names) sources.push(...(await transitiveSources(graph, identity, name)));
  const reached = await walkDependencies(graph, sources);
  const closure: Closure = new Map();
  for (const [name, entry] of reached) {
    if (entry.versions.size > 0) closure.set(name, entry.versions);
  }
  return closure;
}

async function readCached(env: Pick<Env, "AUTH">, key: string): Promise<Closure | null> {
  const text = await env.AUTH.get(key, "text");
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isStoredClosure(value)) return null;
  return new Map(
    Object.entries(value.packages).map(([name, versions]) => [name, new Set(versions)]),
  );
}

async function writeCached(
  env: Pick<Env, "AUTH">,
  key: string,
  closure: Closure,
  now: Date,
): Promise<void> {
  const stored: StoredClosure = {
    computedAt: rfc3339(now),
    packages: Object.fromEntries(
      [...closure.entries()].map(([name, versions]) => [name, [...versions].sort()]),
    ),
  };
  await env.AUTH.put(key, JSON.stringify(stored), { expirationTtl: CLOSURE_TTL_SECONDS });
}

/**
 * The versions reachable transitively from the versions the identity's transitive grants of
 * `eco` cover, restricted to packages listed in `_meta/packages.json`. Empty (and not cached)
 * when the identity has no transitive grant in the ecosystem or is not a `read` credential;
 * otherwise read from, or written to, the KV cache.
 */
export async function computeClosure(
  env: ClosureEnv,
  identity: Identity,
  eco: Eco,
  adapter: Adapter,
  now: Date = new Date(),
): Promise<Closure> {
  if (!needsClosure(identity, eco)) return new Map();
  const key = closureKey(identity.project, eco);
  const cached = await readCached(env, key);
  if (cached !== null) return cached;
  const closure = await computeFresh(env, identity, eco, adapter);
  await writeCached(env, key, closure, now);
  return closure;
}

/** What a caller may see in one ecosystem: explicit grants first, the closure second. */
export interface Access {
  /** Whether the caller may see a version. */
  allows(name: string, version: string): boolean;
  /** Whether the caller may see the package at all (any version). */
  listable(name: string): boolean;
}

/** {@link Access} of an identity in an ecosystem; `admin` sees everything. */
export async function accessFor(
  env: ClosureEnv,
  identity: Identity,
  eco: Eco,
  adapter: Adapter,
): Promise<Access> {
  if (identity.kind === "admin") return { allows: () => true, listable: () => true };
  const closure = await computeClosure(env, identity, eco, adapter);
  const { grants } = identity;
  return {
    allows: (name, version) =>
      isAllowed(grants, eco, name, version, adapter.satisfies) ||
      (closure.get(name)?.has(version) ?? false),
    listable: (name) => isPackageAllowed(grants, eco, name) || closure.has(name),
  };
}

/**
 * Whether the identity may see one version: explicit grants first, and only when they do not
 * cover it, the closure (so a download covered by a grant never computes one).
 */
export async function allowsVersion(
  env: ClosureEnv,
  identity: Identity,
  eco: Eco,
  adapter: Adapter,
  name: string,
  version: string,
): Promise<boolean> {
  if (identity.kind === "admin") return true;
  if (isAllowed(identity.grants, eco, name, version, adapter.satisfies)) return true;
  return (await computeClosure(env, identity, eco, adapter)).get(name)?.has(version) ?? false;
}

/** Whether the identity may see a version of `eco`: explicit grants first, the closure second. */
export async function allowedFor(
  env: ClosureEnv,
  identity: Identity,
  eco: Eco,
  adapter: Adapter,
): Promise<(name: string, version: string) => boolean> {
  return (await accessFor(env, identity, eco, adapter)).allows;
}

async function deleteMatching(
  env: Pick<Env, "AUTH">,
  prefix: string,
  keep: (name: string) => boolean,
): Promise<number> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.AUTH.list({ prefix, cursor });
    for (const key of page.keys) if (!keep(key.name)) names.push(key.name);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  await Promise.all(names.map((name) => env.AUTH.delete(name)));
  return names.length;
}

/**
 * Drops every cached closure of an ecosystem; called after every change to its packages
 * (publish, yank, delete, reindex). Returns the number of deleted keys.
 */
export function invalidateClosures(env: Pick<Env, "AUTH">, eco: Eco): Promise<number> {
  return deleteMatching(env, CLOSURE_PREFIX, (name) => !name.endsWith(`:${eco}`));
}

/**
 * Drops every cached closure of a credential; called when its grants change or it is deleted.
 * Returns the number of deleted keys.
 */
export function invalidateProjectClosures(
  env: Pick<Env, "AUTH">,
  project: string,
): Promise<number> {
  return deleteMatching(env, `${CLOSURE_PREFIX}${project}:`, () => false);
}
