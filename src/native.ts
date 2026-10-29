/**
 * Native read protocols (`/<eco>/…`, see "Adapters and endpoints" in docs/spec.md). The
 * adapter routes the path; the kernel authenticates, applies the grants and answers: index
 * files filtered per credential, listings computed from `_meta/packages.json`, configuration
 * documents, credential checks (`ping`, `whoami`), and file downloads as `302` redirects to
 * presigned `GET` URLs (or, for small text files an adapter marks `inline`, the content
 * itself). Versions opened transitively by a
 * grant (docs/api.md 5.3) are served exactly like explicitly granted ones. Every response is
 * `Cache-Control: private, no-store`; JSON responses carry a strong `ETag` and answer a
 * matching `If-None-Match` with `304`.
 */

import type {
  Adapter,
  ArchiveRoute,
  Eco,
  FileSelection,
  IndexRoute,
  ListingRoute,
  Manifest,
  ManifestFile,
  StaticRoute,
} from "./adapters/types";
import { archiveFileOf, RawIndexBody } from "./adapters/types";
import { authenticate, hasRole, type Identity } from "./core/auth";
import { accessFor, allowsVersion, type Access } from "./core/closure";
import { presignConfig, publicUrl } from "./core/config";
import { ValidationError } from "./core/errors";
import { errorResponse } from "./core/http";
import { presignGet } from "./core/presign";
import { readIndex, readManifest, readPackagesMeta } from "./core/storage";
import type { Env } from "./env";

/** `Cache-Control` of every native response: indexes depend on the credential. */
export const NATIVE_CACHE_CONTROL = "private, no-store";

const NATIVE_HEADERS = { "cache-control": NATIVE_CACHE_CONTROL };

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const BASIC_CHALLENGE = 'Basic realm="serverless-registry"';

/**
 * Challenges sent with a `401` in addition to the Bearer one, per ecosystem: NuGet, SwiftPM
 * and Maven only send their credentials after a Basic challenge (docs/api.md 9.1, 10.1, 11.1).
 */
const EXTRA_CHALLENGES: Partial<Record<Eco, string>> = {
  nuget: BASIC_CHALLENGE,
  swift: BASIC_CHALLENGE,
  maven: BASIC_CHALLENGE,
};

function notFound(): ValidationError {
  return new ValidationError("not_found");
}

function isJsonType(contentType: string | undefined): boolean {
  return contentType === undefined || /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType);
}

/** Strong `ETag` of a body: the quoted first 32 hex characters of its SHA-256. */
export async function etagOf(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex.slice(0, 32)}"`;
}

/** Whether `If-None-Match` names the entity tag (weak comparison) or is `*`. */
function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === "*" || tag === etag);
}

/** A `200` JSON response with an `ETag`, or `304` when the client already has it. */
async function jsonResponse(request: Request, value: unknown): Promise<Response> {
  const body = JSON.stringify(value);
  const etag = await etagOf(body);
  if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { etag, ...NATIVE_HEADERS } });
  }
  return new Response(body, {
    status: 200,
    headers: { "content-type": JSON_CONTENT_TYPE, etag, ...NATIVE_HEADERS },
  });
}

/** The index file of a route filtered by {@link Adapter.filterIndex}, with its content type. */
async function filteredIndex(
  env: Env,
  access: Access,
  adapter: Adapter,
  route: IndexRoute,
): Promise<{ filtered: unknown; contentType: string | undefined }> {
  if (!access.listable(route.name)) throw notFound();
  const stored = await readIndex(env, route.key);
  if (stored === null) throw notFound();
  const json = isJsonType(stored.contentType);
  let body: unknown = stored.body;
  if (json) {
    try {
      body = JSON.parse(stored.body);
    } catch {
      throw new ValidationError("internal_error", "A stored index file is not valid JSON.");
    }
  }
  const filtered: unknown = await adapter.filterIndex(body, access.allows, route);
  if (filtered === null) throw notFound();
  return { filtered, contentType: stored.contentType };
}

async function serveIndex(
  env: Env,
  request: Request,
  access: Access,
  adapter: Adapter,
  route: IndexRoute,
): Promise<Response> {
  const { filtered, contentType } = await filteredIndex(env, access, adapter, route);
  if (filtered instanceof RawIndexBody) {
    return new Response(filtered.body, {
      status: filtered.status,
      headers: { ...filtered.headers, "content-type": filtered.contentType, ...NATIVE_HEADERS },
    });
  }
  if (typeof filtered === "string") {
    return new Response(filtered, {
      status: 200,
      headers: {
        "content-type": contentType ?? "text/plain; charset=utf-8",
        ...NATIVE_HEADERS,
      },
    });
  }
  return jsonResponse(request, filtered);
}

/** Reads and decodes one of the adapter's index files for a listing; `null` when unusable. */
async function readIndexJson(env: Env, key: string): Promise<unknown> {
  const stored = await readIndex(env, key);
  if (stored === null || !isJsonType(stored.contentType)) return null;
  try {
    return JSON.parse(stored.body) as unknown;
  } catch {
    return null;
  }
}

async function serveListing(
  env: Env,
  request: Request,
  access: Access,
  adapter: Adapter,
  route: ListingRoute,
): Promise<Response> {
  if (adapter.buildListing === undefined) throw notFound();
  const meta = await readPackagesMeta(env);
  const names = Object.keys(meta[adapter.eco])
    .filter((name) => access.listable(name))
    .sort();
  const body: unknown = await adapter.buildListing(names, {
    publicUrl: publicUrl(env, request),
    route,
    allowed: access.allows,
    readIndex: (key) => readIndexJson(env, key),
  });
  return jsonResponse(request, body);
}

function selectFile(
  adapter: Adapter,
  manifest: Manifest,
  route: ArchiveRoute,
  publicUrl: string,
): FileSelection | null {
  if (adapter.selectFile !== undefined) return adapter.selectFile(manifest, route, publicUrl);
  const file: ManifestFile | null =
    route.file === null
      ? archiveFileOf(manifest.files)
      : (manifest.files.find((f) => f.name === route.file) ?? null);
  return file === null ? null : { file };
}

/**
 * The route with its version resolved through {@link ArchiveRoute.resolve} (generic `latest`):
 * the `version` of the filtered index; `404` when there is none.
 */
async function resolveArchive(
  env: Env,
  identity: Identity,
  adapter: Adapter,
  route: ArchiveRoute,
): Promise<ArchiveRoute> {
  if (route.resolve === undefined) return route;
  const access = await accessFor(env, identity, adapter.eco, adapter);
  const { filtered } = await filteredIndex(env, access, adapter, route.resolve);
  const version: unknown =
    typeof filtered === "object" && filtered !== null && "version" in filtered
      ? filtered.version
      : undefined;
  if (typeof version !== "string" || !adapter.validateVersion(version)) throw notFound();
  return { ...route, version };
}

async function serveFile(
  env: Env,
  request: Request,
  identity: Identity,
  adapter: Adapter,
  route: ArchiveRoute,
  now: Date,
): Promise<Response> {
  if (!(await allowsVersion(env, identity, adapter.eco, adapter, route.name, route.version))) {
    throw notFound();
  }
  const manifest = await readManifest(env, adapter.eco, route.name, route.version);
  if (manifest === null) throw notFound();
  const selected = selectFile(adapter, manifest, route, publicUrl(env, request));
  if (selected === null) throw notFound();
  const key = adapter.fileKey(manifest, selected.file);
  const headers = { ...selected.headers, ...NATIVE_HEADERS };
  if (route.inline) {
    const object = await env.R2_BUCKET.get(key);
    if (object === null) throw notFound();
    return new Response(object.body, {
      status: 200,
      headers: { ...headers, "content-type": route.contentType ?? "application/octet-stream" },
    });
  }
  const signed = await presignGet({ ...presignConfig(env), key, now });
  return new Response(null, { status: 302, headers: { ...headers, location: signed.url } });
}

/** A {@link StaticRoute}: JSON, or its string body verbatim when it names a content type. */
function serveStatic(request: Request, route: StaticRoute): Promise<Response> | Response {
  if (route.contentType === undefined && route.status === undefined) {
    return jsonResponse(request, route.body);
  }
  const body = route.contentType === undefined ? JSON.stringify(route.body) : String(route.body);
  return new Response(body, {
    status: route.status ?? 200,
    headers: { "content-type": route.contentType ?? JSON_CONTENT_TYPE, ...NATIVE_HEADERS },
  });
}

async function dispatch(
  request: Request,
  env: Env,
  adapter: Adapter,
  url: URL,
  now: Date,
): Promise<Response> {
  const route = adapter.route(request, url);
  if (route === null) throw notFound();
  const auth = await authenticate(request, env, { kindHint: "read" });
  if (auth === null) throw new ValidationError("unauthorized");
  const { identity } = auth;
  // A yank or delete login token carries the `admin` role but only for those operations.
  if (identity.ops !== undefined) {
    throw new ValidationError("forbidden", "This login token may not read packages.");
  }
  // Checking the credential itself (`npm ping`, `npm whoami`) is open to every kind.
  if (route.kind === "static") return serveStatic(request, route);
  if (route.kind === "whoami") return jsonResponse(request, { username: identity.project });
  if (!hasRole(identity, "read", "admin")) {
    throw new ValidationError("forbidden", "Publish credentials cannot read packages.");
  }
  switch (route.kind) {
    case "index":
      return serveIndex(
        env,
        request,
        await accessFor(env, identity, adapter.eco, adapter),
        adapter,
        route,
      );
    case "listing":
      return serveListing(
        env,
        request,
        await accessFor(env, identity, adapter.eco, adapter),
        adapter,
        route,
      );
    case "archive":
      return serveFile(
        env,
        request,
        identity,
        adapter,
        await resolveArchive(env, identity, adapter, route),
        now,
      );
    case "config":
      if (adapter.buildConfig === undefined) throw notFound();
      return jsonResponse(request, adapter.buildConfig({ publicUrl: publicUrl(env, request) }));
  }
}

/** Answers a request under `/<eco>/` for an enabled adapter. */
export async function handleNative(
  request: Request,
  env: Env,
  adapter: Adapter,
  url: URL,
  now: Date = new Date(),
): Promise<Response> {
  let response: Response;
  try {
    response = await dispatch(request, env, adapter, url, now);
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      console.error("Unhandled native error:", err instanceof Error ? err.message : String(err));
    }
    response = errorResponse(err, NATIVE_HEADERS);
    const challenge = EXTRA_CHALLENGES[adapter.eco];
    if (response.status === 401 && challenge !== undefined) {
      const bearer = response.headers.get("www-authenticate");
      response.headers.set("www-authenticate", challenge);
      if (bearer !== null) response.headers.append("www-authenticate", bearer);
    }
  }
  return adapter.finalizeResponse === undefined ? response : adapter.finalizeResponse(response);
}
