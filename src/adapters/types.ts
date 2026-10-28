/**
 * Contracts shared by the kernel and the ecosystem adapters (see "Adapters and endpoints" in
 * docs/spec.md). Adapters implement {@link Adapter}; they never touch R2, KV or auth.
 */

/** Supported ecosystems. */
export type Eco = "composer" | "npm" | "cargo";

/** All ecosystems, in a stable order. */
export const ECOS: readonly Eco[] = ["composer", "npm", "cargo"];

/** Narrows an arbitrary value to {@link Eco}. */
export function isEco(value: unknown): value is Eco {
  return typeof value === "string" && (ECOS as readonly string[]).includes(value);
}

/**
 * Normalised version manifest stored at `<eco>/pkg/<name>/<version>/manifest.json`. It is the
 * only durable data contract: indexes are always rebuilt from manifests.
 */
export interface Manifest {
  eco: Eco;
  /** Decoded package name, e.g. `@acme/sdk`. */
  name: string;
  version: string;
  /** Archive file name. */
  file: string;
  /** Archive size in bytes. */
  size: number;
  /** SHA-256 of the archive, 64 lower-case hex characters. */
  sha256: string;
  /** RFC 3339 timestamp of the commit. */
  published: string;
  /** `[<source>.]<project>` of the credential that published the version. */
  publishedBy: string;
  yanked: boolean;
  /** Whatever the adapter needs to reproduce the version's entry in the index. */
  native: Record<string, unknown>;
}

/** One generated index file written to R2. */
export interface IndexFile {
  /** R2 key, under `<eco>/index/`. */
  key: string;
  body: string;
  contentType: string;
}

/** Body of `POST /api/v1/publish/init` (docs/api.md 6.4). */
export interface PublishInit {
  eco: Eco;
  name: string;
  version: string;
  file: string;
  size: number;
  sha256: string;
  /** Ecosystem-native metadata (`composer.json`, `package.json`, cargo index line). */
  manifest: Record<string, unknown>;
  /** npm only: dist-tag to point at this version. */
  tag?: string;
}

/** A read of an index file, which the kernel filters by the caller's grants. */
export interface IndexRoute {
  kind: "index";
  /** R2 key of the index file. */
  key: string;
  /** Decoded package name the index belongs to. */
  name: string;
}

/** A download of an archive, answered with a redirect to a presigned `GET`. */
export interface ArchiveRoute {
  kind: "archive";
  /** R2 key of the archive. */
  key: string;
  name: string;
  version: string;
}

/** A ready-to-paste client configuration snippet for the home page. */
export interface Snippet {
  title: string;
  filename: string;
  /** Language hint for display, e.g. `json`, `ini`, `toml`. */
  language: string;
  body: string;
}

/** Context passed to {@link Adapter.buildIndex}. */
export interface IndexContext {
  /** `PUBLIC_URL` without a trailing slash. */
  publicUrl: string;
  /** Ecosystem-specific package metadata kept outside the manifests (e.g. npm dist-tags). */
  meta?: Record<string, unknown>;
}

/** One ecosystem module (`src/adapters/<eco>/index.ts`). */
export interface Adapter {
  eco: Eco;
  /** Validates and normalises what the CLI sent in `init`; throws `ValidationError`. */
  parseManifest(input: PublishInit): Manifest;
  /** R2 key of the archive of a version. */
  archiveKey(m: Manifest): string;
  /** Rebuilds the index of one package from all its manifests (including yanked ones). */
  buildIndex(name: string, manifests: Manifest[], ctx: IndexContext): IndexFile[];
  /** Read routing of the native protocol; `null` when the path is not handled. */
  route(req: Request, url: URL): IndexRoute | ArchiveRoute | null;
  /** Removes from an index body every version the credential may not see. */
  filterIndex(body: unknown, allowed: (name: string, version: string) => boolean): unknown;
  /** Configuration snippets for the home page. */
  clientConfig(baseUrl: string, token: string, packages: string[]): Snippet[];
  /** Whether a version satisfies a constraint in the ecosystem's syntax. */
  satisfies(version: string, constraint: string): boolean;
}
