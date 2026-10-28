/**
 * Native read protocols (`/<eco>/…`, see "Adapters and endpoints" in docs/spec.md). The
 * adapter routes the path; the kernel authenticates, applies the grants and answers: index
 * files filtered per credential, listings computed from `_meta/packages.json`, configuration
 * documents, credential checks (`ping`, `whoami`), and file downloads as `302` redirects to
 * presigned `GET` URLs. Versions opened transitively by a
 * grant (docs/api.md 5.3) are served exactly like explicitly granted ones. Every response is
 * `Cache-Control: private, no-store`; JSON responses carry a strong `ETag` and answer a
 * matching `If-None-Match` with `304`.
 */

import type {
  Adapter,
  ArchiveRoute,
  Eco,
  IndexRoute,
  ListingRoute,
  ManifestFile,
} from "./adapters/types";
import { archiveFileOf, RawIndexBody } from "./adapters/types";
import { authenticate, type Identity } from "./core/auth";
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

/**
 * Challenges sent with a `401` in addition to the Bearer one, per ecosystem: NuGet clients
 * only prompt for credentials on a Basic challenge (docs/api.md 9.1).
 */
const EXTRA_CHALLENGES: Partial<Record<Eco, string>> = {
  nuget: 'Basic realm="serverless-registry"',
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

async function serveIndex(
  env: Env,
  request: Request,
  access: Access,
  adapter: Adapter,
  route: IndexRoute,
): Promise<Response> {
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
  const filtered = adapter.filterIndex(body, access.allows, route);
  if (filtered === null) throw notFound();
  if (filtered instanceof RawIndexBody) {
    return new Response(filtered.body, {
      status: 200,
      headers: { "content-type": filtered.contentType, ...NATIVE_HEADERS },
    });
  }
  if (typeof filtered === "string") {
    return new Response(filtered, {
      status: 200,
      headers: {
        "content-type": stored.contentType ?? "text/plain; charset=utf-8",
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

async function serveFile(
  env: Env,
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
  const file: ManifestFile | null =
    route.file === null
      ? archiveFileOf(manifest.files)
      : (manifest.files.find((f) => f.name === route.file) ?? null);
  if (file === null) throw notFound();
  const signed = await presignGet({
    ...presignConfig(env),
    key: adapter.fileKey(manifest, file),
    now,
  });
  return new Response(null, {
    status: 302,
    headers: { location: signed.url, ...NATIVE_HEADERS },
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
  // Checking the credential itself (`npm ping`, `npm whoami`) is open to every kind.
  if (route.kind === "static") return jsonResponse(request, route.body);
  if (route.kind === "whoami") return jsonResponse(request, { username: identity.project });
  if (identity.kind === "publish") {
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
      return serveFile(env, identity, adapter, route, now);
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
  try {
    return await dispatch(request, env, adapter, url, now);
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      console.error("Unhandled native error:", err instanceof Error ? err.message : String(err));
    }
    const response = errorResponse(err, NATIVE_HEADERS);
    const challenge = EXTRA_CHALLENGES[adapter.eco];
    if (response.status === 401 && challenge !== undefined) {
      const bearer = response.headers.get("www-authenticate");
      response.headers.set("www-authenticate", challenge);
      if (bearer !== null) response.headers.append("www-authenticate", bearer);
    }
    return response;
  }
}
