/**
 * Transitive access (docs/api.md 5.3, `grants.transitive` in docs/spec.md): a `read` grant
 * also opens the versions of the packages its versions depend on, as declared in their
 * manifests, as long as those packages are in this registry. The closure is computed from the
 * ecosystem's dependency graph `_meta/deps/<eco>.json` (one R2 read; the adapter's `satisfies`
 * evaluates the constraints) and cached per credential in the Cache API under
 * {@link closureCacheUrl} for 60 seconds. Nothing is written to KV and nothing is invalidated:
 * publications and grant changes show in transitive access once the cached entry expires.
 */

import type { Adapter, Dependency, Eco } from "../adapters/types";
import type { Env } from "../env";
import { hasRole, type Identity } from "./auth";
import { isAllowed, isPackageAllowed, isTransitive, matchesPackage, type Grant } from "./grants";
import { constraintList, readDepsGraph, type DepsGraph } from "./storage";

export type ClosureEnv = Pick<Env, "R2_BUCKET">;

/** Versions reachable transitively, by package name (as keyed in the dependency graph). */
export type Closure = Map<string, Set<string>>;

/** Lifetime of a cached closure in the Cache API, in seconds (`Cache-Control: max-age`). */
export const CLOSURE_TTL_SECONDS = 60;

/**
 * Synthetic URL under which the closure of one credential in one ecosystem is kept in the Cache
 * API (`caches.default`); it is never fetched. The cache is per data centre and needs no KV
 * write.
 */
export function closureCacheUrl(eco: Eco, project: string): string {
  return `https://cache.internal/closure/${eco}/${encodeURIComponent(project)}`;
}

/** The part of the Cache API the closure cache uses. */
export type ClosureCache = Pick<Cache, "match" | "put">;

/** Injectable cache for tests. */
export interface ClosureOptions {
  /** Where closures are cached; `caches.default` when omitted. */
  cache?: ClosureCache;
  /** Skip the cached closure (the fresh one is cached again). */
  fresh?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Package names that compare case-insensitively (docs/api.md 5.1 and 5.3). */
function foldName(eco: Eco, name: string): string {
  return eco === "composer" || eco === "npm" || eco === "nuget" ? name.toLowerCase() : name;
}

/** The grants of an ecosystem that open dependencies. */
function transitiveGrants(identity: Identity, eco: Eco): Grant[] {
  return identity.grants.read.filter((g) => g.eco === eco && isTransitive(g));
}

/** Whether a closure is ever computed for the identity in the ecosystem. */
export function needsClosure(identity: Identity, eco: Eco): boolean {
  return hasRole(identity, "read") && transitiveGrants(identity, eco).length > 0;
}

/** The dependency graph of one ecosystem (`_meta/deps/<eco>.json`) with name resolution. */
export class DependencyGraph {
  private readonly byFolded: Map<string, string>;

  constructor(
    readonly adapter: Adapter,
    readonly graph: DepsGraph,
  ) {
    this.byFolded = new Map(Object.keys(graph).map((name) => [foldName(adapter.eco, name), name]));
  }

  /** Reads `_meta/deps/<eco>.json` and returns the graph of one ecosystem. */
  static async load(env: ClosureEnv, adapter: Adapter): Promise<DependencyGraph> {
    return new DependencyGraph(adapter, await readDepsGraph(env, adapter.eco));
  }

  /** The registry's name of a dependency, or `null` when the package is not in the registry. */
  resolve(name: string): string | null {
    return this.byFolded.get(foldName(this.adapter.eco, name)) ?? null;
  }

  /** Every stored version of a package (yanked included); `[]` for an unknown package. */
  versions(name: string): string[] {
    return Object.keys(this.graph[name] ?? {});
  }

  /** The dependencies one version declares, one entry per declared constraint. */
  dependencies(name: string, version: string): Dependency[] {
    const deps = this.graph[name]?.[version] ?? {};
    return Object.entries(deps).flatMap(([dep, constraint]) =>
      constraintList(constraint).map((c) => ({ name: dep, constraint: c })),
    );
  }
}

/** One version of a package. */
export interface VersionRef {
  name: string;
  version: string;
}

/** What a walk reached in one package. */
export interface Reached {
  /** The distinct constraints, as written, of the dependencies that point at the package. */
  constraints: string[];
  /** The versions of the package the constraints admit. */
  versions: Set<string>;
}

function versionKey(v: VersionRef): string {
  return `${v.name}\u0000${v.version}`;
}

/**
 * Follows the dependencies of `sources` depth-first: every dependency on a package of the
 * registry admits the versions that satisfy its constraint (an unparsable constraint admits
 * none), and the admitted versions are followed in turn. Yanked versions take part like any
 * other; each version is visited once, so cycles end. The sources themselves are only part of
 * the result when a dependency leads back to them.
 */
export function walkDependencies(
  graph: DependencyGraph,
  sources: readonly VersionRef[],
): Map<string, Reached> {
  const { adapter } = graph;
  const reached = new Map<string, Reached>();
  const visited = new Set(sources.map(versionKey));
  const stack = [...sources];
  for (let v = stack.pop(); v !== undefined; v = stack.pop()) {
    for (const dep of graph.dependencies(v.name, v.version)) {
      const target = graph.resolve(dep.name);
      if (target === null) continue;
      let entry = reached.get(target);
      if (entry === undefined) {
        entry = { constraints: [], versions: new Set() };
        reached.set(target, entry);
      }
      if (!entry.constraints.includes(dep.constraint)) entry.constraints.push(dep.constraint);
      for (const version of graph.versions(target)) {
        if (!adapter.satisfies(version, dep.constraint)) continue;
        entry.versions.add(version);
        const candidate = { name: target, version };
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
export function transitiveSources(
  graph: DependencyGraph,
  identity: Identity,
  name: string,
): VersionRef[] {
  const eco = graph.adapter.eco;
  const grants = transitiveGrants(identity, eco);
  if (!grants.some((g) => matchesPackage(g.package, name, eco))) return [];
  return graph
    .versions(name)
    .filter((version) => isAllowed(grants, eco, name, version, graph.adapter.satisfies))
    .map((version) => ({ name, version }));
}

function computeFresh(graph: DependencyGraph, identity: Identity): Closure {
  const sources = Object.keys(graph.graph).flatMap((name) =>
    transitiveSources(graph, identity, name),
  );
  const closure: Closure = new Map();
  for (const [name, entry] of walkDependencies(graph, sources)) {
    if (entry.versions.size > 0) closure.set(name, entry.versions);
  }
  return closure;
}

/** The cached closure, or `null` when it is missing or malformed (or the cache fails). */
async function readCached(cache: ClosureCache, url: string): Promise<Closure | null> {
  try {
    const response = await cache.match(url);
    if (response === undefined) return null;
    const value: unknown = await response.json();
    if (!isRecord(value) || !isRecord(value.packages)) return null;
    const closure: Closure = new Map();
    for (const [name, versions] of Object.entries(value.packages)) {
      if (!Array.isArray(versions) || !versions.every((v) => typeof v === "string")) return null;
      closure.set(name, new Set(versions));
    }
    return closure;
  } catch {
    return null;
  }
}

async function writeCached(cache: ClosureCache, url: string, closure: Closure): Promise<void> {
  const packages = Object.fromEntries(
    [...closure.entries()].map(([name, versions]) => [name, [...versions].sort()]),
  );
  try {
    await cache.put(
      url,
      new Response(JSON.stringify({ packages }), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${CLOSURE_TTL_SECONDS}`,
        },
      }),
    );
  } catch {
    // Caching is best-effort; the next request computes the closure again.
  }
}

/**
 * The versions reachable transitively from the versions the identity's transitive grants of
 * `eco` cover, restricted to packages of the dependency graph. Empty (and not cached) when the
 * identity has no transitive grant in the ecosystem or is not a `read` credential; otherwise
 * read from, or written to, the Cache API.
 */
export async function computeClosure(
  env: ClosureEnv,
  identity: Identity,
  eco: Eco,
  adapter: Adapter,
  options: ClosureOptions = {},
): Promise<Closure> {
  if (!needsClosure(identity, eco)) return new Map();
  const cache = options.cache ?? caches.default;
  const url = closureCacheUrl(eco, identity.project);
  if (!options.fresh) {
    const cached = await readCached(cache, url);
    if (cached !== null) return cached;
  }
  const closure = computeFresh(await DependencyGraph.load(env, adapter), identity);
  await writeCached(cache, url, closure);
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
  options: ClosureOptions = {},
): Promise<Access> {
  if (hasRole(identity, "admin")) return { allows: () => true, listable: () => true };
  const closure = await computeClosure(env, identity, eco, adapter, options);
  const grants = identity.grants.read;
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
  options: ClosureOptions = {},
): Promise<boolean> {
  if (hasRole(identity, "admin")) return true;
  if (isAllowed(identity.grants.read, eco, name, version, adapter.satisfies)) return true;
  const closure = await computeClosure(env, identity, eco, adapter, options);
  return closure.get(name)?.has(version) ?? false;
}

/** Whether the identity may see a version of `eco`: explicit grants first, the closure second. */
export async function allowedFor(
  env: ClosureEnv,
  identity: Identity,
  eco: Eco,
  adapter: Adapter,
  options: ClosureOptions = {},
): Promise<(name: string, version: string) => boolean> {
  return (await accessFor(env, identity, eco, adapter, options)).allows;
}
