/**
 * Native read protocols (`/<eco>/…`, see "Adapters and endpoints" in docs/spec.md). The
 * adapter routes the path; the kernel authenticates, applies the grants and answers: index
 * files filtered per credential, listings computed from `_meta/packages.json`, configuration
 * documents, credential checks (`ping`, `whoami`), and file downloads as `302` redirects to
 * presigned `GET` URLs. Versions opened transitively by a
 * grant (docs/api.md 5.3) are served exactly like explicitly granted ones. Every response is
 * `Cache-Control: private, no-store`.
 */

import type { Adapter, ArchiveRoute, IndexRoute, ManifestFile } from "./adapters/types";
import { archiveFileOf } from "./adapters/types";
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

function notFound(): ValidationError {
  return new ValidationError("not_found");
}

function isJsonType(contentType: string | undefined): boolean {
  return contentType === undefined || /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType);
}

async function serveIndex(
  env: Env,
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
  if (typeof filtered === "string") {
    return new Response(filtered, {
      status: 200,
      headers: {
        "content-type": stored.contentType ?? "text/plain; charset=utf-8",
        ...NATIVE_HEADERS,
      },
    });
  }
  return jsonResponse(filtered);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...NATIVE_HEADERS },
  });
}

async function serveListing(
  env: Env,
  request: Request,
  access: Access,
  adapter: Adapter,
): Promise<Response> {
  if (adapter.buildListing === undefined) throw notFound();
  const meta = await readPackagesMeta(env);
  const names = Object.keys(meta[adapter.eco])
    .filter((name) => access.listable(name))
    .sort();
  return jsonResponse(adapter.buildListing(names, { publicUrl: publicUrl(env, request) }));
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
  const auth = await authenticate(request, env);
  if (auth === null) throw new ValidationError("unauthorized");
  const { identity } = auth;
  // Checking the credential itself (`npm ping`, `npm whoami`) is open to every kind.
  if (route.kind === "static") return jsonResponse(route.body);
  if (route.kind === "whoami") return jsonResponse({ username: identity.project });
  if (identity.kind === "publish") {
    throw new ValidationError("forbidden", "Publish credentials cannot read packages.");
  }
  switch (route.kind) {
    case "index":
      return serveIndex(env, await accessFor(env, identity, adapter.eco, adapter), adapter, route);
    case "listing":
      return serveListing(
        env,
        request,
        await accessFor(env, identity, adapter.eco, adapter),
        adapter,
      );
    case "archive":
      return serveFile(env, identity, adapter, route, now);
    case "config":
      if (adapter.buildConfig === undefined) throw notFound();
      return jsonResponse(adapter.buildConfig({ publicUrl: publicUrl(env, request) }));
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
