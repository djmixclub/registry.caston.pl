/**
 * Native read protocols (`/<eco>/…`, see "Adapters and endpoints" in docs/spec.md). The
 * adapter routes the path; the kernel authenticates, applies the grants and answers: index
 * files filtered per credential, listings computed from `_meta/packages.json`, and file
 * downloads as `302` redirects to presigned `GET` URLs. Every response is
 * `Cache-Control: private, no-store`.
 */

import type { Adapter, ArchiveRoute, IndexRoute, ManifestFile } from "./adapters/types";
import { archiveFileOf } from "./adapters/types";
import { authenticate, type Identity } from "./core/auth";
import { presignConfig, publicUrl } from "./core/config";
import { ValidationError } from "./core/errors";
import { isAllowed, isPackageAllowed } from "./core/grants";
import { errorResponse } from "./core/http";
import { presignGet } from "./core/presign";
import { readIndex, readManifest, readPackagesMeta } from "./core/storage";
import type { Env } from "./env";

/** `Cache-Control` of every native response: indexes depend on the credential. */
export const NATIVE_CACHE_CONTROL = "private, no-store";

const NATIVE_HEADERS = { "cache-control": NATIVE_CACHE_CONTROL };

function notFound(): ValidationError {
  return new ValidationError("not_found");
}

/** Whether the caller may see the version (admin sees everything). */
function allows(identity: Identity, adapter: Adapter, name: string, version: string): boolean {
  return (
    identity.kind === "admin" ||
    isAllowed(identity.grants, adapter.eco, name, version, adapter.satisfies)
  );
}

function mayList(identity: Identity, adapter: Adapter, name: string): boolean {
  return identity.kind === "admin" || isPackageAllowed(identity.grants, adapter.eco, name);
}

function isJsonType(contentType: string | undefined): boolean {
  return contentType === undefined || /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType);
}

async function serveIndex(
  env: Env,
  identity: Identity,
  adapter: Adapter,
  route: IndexRoute,
): Promise<Response> {
  if (!mayList(identity, adapter, route.name)) throw notFound();
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
  const filtered = adapter.filterIndex(body, (name, version) =>
    allows(identity, adapter, name, version),
  );
  return new Response(json ? JSON.stringify(filtered) : String(filtered), {
    status: 200,
    headers: {
      "content-type": json ? "application/json; charset=utf-8" : (stored.contentType ?? ""),
      ...NATIVE_HEADERS,
    },
  });
}

async function serveListing(
  env: Env,
  request: Request,
  identity: Identity,
  adapter: Adapter,
): Promise<Response> {
  if (adapter.buildListing === undefined) throw notFound();
  const meta = await readPackagesMeta(env);
  const names = Object.keys(meta[adapter.eco])
    .filter((name) => mayList(identity, adapter, name))
    .sort();
  const body = adapter.buildListing(names, { publicUrl: publicUrl(env, request) });
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...NATIVE_HEADERS },
  });
}

async function serveFile(
  env: Env,
  identity: Identity,
  adapter: Adapter,
  route: ArchiveRoute,
  now: Date,
): Promise<Response> {
  if (!allows(identity, adapter, route.name, route.version)) throw notFound();
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
  const auth = await authenticate(request, env);
  if (auth === null) throw new ValidationError("unauthorized");
  const { identity } = auth;
  if (identity.kind === "publish") {
    throw new ValidationError("forbidden", "Publish credentials cannot read packages.");
  }
  switch (route.kind) {
    case "index":
      return serveIndex(env, identity, adapter, route);
    case "listing":
      return serveListing(env, request, identity, adapter);
    case "archive":
      return serveFile(env, identity, adapter, route, now);
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
    return errorResponse(err, NATIVE_HEADERS);
  }
}
