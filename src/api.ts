/**
 * The `/api/v1` surface (docs/api.md). Requests are processed in the order of section 1.4:
 * client version check, routing, body parsing, authentication, kind check, then the endpoint.
 * Every response carries `X-Min-Client-Version`.
 */

import {
  addSecret,
  createCredential,
  deletePackage,
  describeSecret,
  deleteVersion,
  expireSecret,
  listCredentialViews,
  readCredentialView,
  reindex,
  removeCredential,
  updateGrants,
  yank,
} from "./core/admin";
import {
  authenticate,
  sessionIdentity,
  type Identity,
  type Kind,
  type KindHint,
} from "./core/auth";
import { publicUrl } from "./core/config";
import { createLoginSession, pollLoginSession } from "./core/login";
import { ValidationError } from "./core/errors";
import { lookupRepository } from "./core/github";
import { errorResponse, jsonResponse } from "./core/http";
import { getPackage, listPackages } from "./core/packages";
import { commit, init } from "./core/publish";
import { compareVersions, parseVersion } from "./core/semver";
import type { Env } from "./env";
import { Router, type Params } from "./router";
import { MIN_CLIENT_VERSION, SCHEMA_VERSION, VERSION } from "./version";

/** Path prefix of the API. */
export const API_PREFIX = "/api/v1";

/** Headers on every `/api/v1` response. */
export const API_HEADERS: Readonly<Record<string, string>> = {
  "x-min-client-version": MIN_CLIENT_VERSION,
};

/** Request bodies are limited to 4 MiB. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** A semver version as the CLI sends it: no leading `v`. */
const CLIENT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const MUTATING = new Set(["POST", "PATCH", "DELETE"]);

/** Everything an endpoint handler gets. */
export interface ApiContext {
  env: Env;
  request: Request;
  params: Params;
  body: Record<string, unknown>;
  /** The caller; a placeholder that is never read for endpoints without authentication. */
  identity: Identity;
  now: Date;
  /** `PUBLIC_URL`, or the request's origin when it is not set. */
  publicUrl: string;
  /** Outgoing requests (GitHub); injectable for tests. */
  fetch: typeof fetch;
}

interface ApiResult {
  status: number;
  body: unknown;
}

interface ApiRoute {
  /** `none`: no credential; `any`: every kind; otherwise the kinds allowed. */
  auth: "none" | "any" | readonly Kind[];
  handler: (c: ApiContext) => Promise<ApiResult> | ApiResult;
}

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const created = (body: unknown): ApiResult => ({ status: 201, body });

const ADMIN: readonly Kind[] = ["admin"];
const READERS: readonly Kind[] = ["read", "admin"];
const PUBLISHERS: readonly Kind[] = ["publish"];

const p = (c: ApiContext, name: string): string => c.params[name] ?? "";

const routes = new Router<ApiRoute>()
  .add("GET", "/api/v1/version", {
    auth: "none",
    handler: () =>
      ok({ version: VERSION, minClientVersion: MIN_CLIENT_VERSION, schemaVersion: SCHEMA_VERSION }),
  })
  .add("GET", "/api/v1/whoami", {
    auth: "any",
    handler: (c) =>
      ok({
        project: c.identity.project,
        kind: c.identity.kind,
        grants: c.identity.grants,
        ...(c.identity.scopes === undefined ? {} : { scopes: c.identity.scopes }),
      }),
  })
  .add("POST", "/api/v1/auth/sessions", {
    auth: "none",
    handler: async (c) => created(await createLoginSession(c.env, c.body, c.publicUrl, c.now)),
  })
  .add("POST", "/api/v1/auth/sessions/poll", {
    auth: "none",
    handler: async (c) => {
      const result = await pollLoginSession(c.env, c.body, c.now);
      return result.status === "pending"
        ? { status: 202, body: { status: "pending" } }
        : ok({ status: "approved", ...result.issued });
    },
  })
  .add("POST", "/api/v1/publish/init", {
    auth: PUBLISHERS,
    handler: async (c) => ok(await init(c.env, c.identity, c.body, c.now)),
  })
  .add("POST", "/api/v1/publish/commit", {
    auth: PUBLISHERS,
    handler: async (c) => created(await commit(c.env, c.identity, c.body, c.now, c.publicUrl)),
  })
  .add("GET", "/api/v1/packages", {
    auth: READERS,
    handler: async (c) => ok(await listPackages(c.env, c.identity)),
  })
  .add("GET", "/api/v1/packages/:eco/:name", {
    auth: READERS,
    handler: async (c) => ok(await getPackage(c.env, c.identity, p(c, "eco"), p(c, "name"))),
  })
  .add("POST", "/api/v1/packages/:eco/:name/:version/yank", {
    auth: ADMIN,
    handler: async (c) =>
      ok(await yank(c.env, p(c, "eco"), p(c, "name"), p(c, "version"), c.now, c.publicUrl)),
  })
  .add("DELETE", "/api/v1/packages/:eco/:name/:version", {
    auth: ADMIN,
    handler: async (c) =>
      ok(
        await deleteVersion(c.env, p(c, "eco"), p(c, "name"), p(c, "version"), c.now, c.publicUrl),
      ),
  })
  .add("DELETE", "/api/v1/packages/:eco/:name", {
    auth: ADMIN,
    handler: async (c) => ok(await deletePackage(c.env, p(c, "eco"), p(c, "name"), c.publicUrl)),
  })
  .add("POST", "/api/v1/packages/:eco/:name/reindex", {
    auth: ADMIN,
    handler: async (c) => ok(await reindex(c.env, p(c, "eco"), p(c, "name"), c.now, c.publicUrl)),
  })
  .add("GET", "/api/v1/credentials", {
    auth: ADMIN,
    handler: async (c) => ok(await listCredentialViews(c.env)),
  })
  .add("POST", "/api/v1/credentials", {
    auth: ADMIN,
    handler: async (c) => created(await createCredential(c.env, c.body, c.now)),
  })
  .add("GET", "/api/v1/credentials/:project", {
    auth: ADMIN,
    handler: async (c) => ok(await readCredentialView(c.env, p(c, "project"))),
  })
  .add("PATCH", "/api/v1/credentials/:project", {
    auth: ADMIN,
    handler: async (c) => ok(await updateGrants(c.env, p(c, "project"), c.body)),
  })
  .add("DELETE", "/api/v1/credentials/:project", {
    auth: ADMIN,
    handler: async (c) => ok(await removeCredential(c.env, p(c, "project"))),
  })
  .add("POST", "/api/v1/credentials/:project/secrets", {
    auth: ADMIN,
    handler: async (c) => created(await addSecret(c.env, p(c, "project"), c.body, c.now)),
  })
  .add("GET", "/api/v1/github/repository", {
    auth: ADMIN,
    handler: async (c) =>
      ok(await lookupRepository(new URL(c.request.url).searchParams.get("name") ?? "", c.fetch)),
  })
  .add("PATCH", "/api/v1/credentials/:project/secrets/:id", {
    auth: ADMIN,
    handler: async (c) => ok(await describeSecret(c.env, p(c, "project"), p(c, "id"), c.body)),
  })
  .add("DELETE", "/api/v1/credentials/:project/secrets/:id", {
    auth: ADMIN,
    handler: async (c) => ok(await expireSecret(c.env, p(c, "project"), p(c, "id"), c.body, c.now)),
  });

/** Section 3: `400` for a malformed `X-Client-Version`, `426` below the minimum. */
function checkClientVersion(request: Request): void {
  const header = request.headers.get("x-client-version");
  if (header === null) return;
  const value = header.trim();
  if (!CLIENT_VERSION_RE.test(value) || parseVersion(value) === null) {
    throw new ValidationError("invalid_request", "X-Client-Version must be a semver version.");
  }
  if (compareVersions(value, MIN_CLIENT_VERSION) < 0) {
    throw new ValidationError(
      "client_too_old",
      `This registry requires sreg ${MIN_CLIENT_VERSION} or newer.`,
    );
  }
}

/** Section 1.2: a JSON object body of at most 4 MiB; an empty body is `{}`. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const tooLarge = () =>
    new ValidationError("payload_too_large", "Request bodies are limited to 4 MiB.");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw tooLarge();
  if (bytes.byteLength === 0) return {};
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new ValidationError("invalid_request", "Request bodies must be application/json.");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ValidationError("invalid_request", "The request body is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("invalid_request", "The request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

/**
 * Section 2: the `Authorization` header wins; without it the panel's session cookie is used.
 * Returns `null` when no valid credential is found.
 */
async function identify(
  request: Request,
  env: Env,
  kindHint: KindHint,
): Promise<{ identity: Identity; viaCookie: boolean } | null> {
  if (request.headers.has("authorization")) {
    const auth = await authenticate(request, env, { kindHint });
    return auth === null ? null : { identity: auth.identity, viaCookie: false };
  }
  const session = await sessionIdentity(request, env);
  return session === null ? null : { identity: session.identity, viaCookie: true };
}

/** A stand-in identity for endpoints without authentication; never used by them. */
const ANONYMOUS: Identity = {
  project: "",
  kind: "read",
  grants: [],
  record: { project: "", kind: "read", auth: [], grants: [] },
  entryId: "",
};

async function dispatch(
  request: Request,
  env: Env,
  url: URL,
  now: Date,
  fetcher: typeof fetch,
): Promise<Response> {
  if (url.pathname !== `${API_PREFIX}/version`) checkClientVersion(request);

  const match = routes.match(request.method, url.pathname);
  if (match === null) throw new ValidationError("not_found");
  const route = match.value;

  const body = await readBody(request);

  let identity = ANONYMOUS;
  if (route.auth !== "none") {
    // A `_:gh.<jwt>` login resolves to a `publish` credential only on the publishing endpoints.
    const kindHint = url.pathname.startsWith(`${API_PREFIX}/publish/`) ? "publish" : "read";
    const found = await identify(request, env, kindHint);
    if (found === null) throw new ValidationError("unauthorized");
    if (
      found.viaCookie &&
      MUTATING.has(request.method) &&
      (request.headers.get("x-requested-with") ?? "").trim() === ""
    ) {
      throw new ValidationError("forbidden", "Requests with a session need X-Requested-With.");
    }
    if (route.auth !== "any" && !route.auth.includes(found.identity.kind)) {
      throw new ValidationError("forbidden", "This credential may not perform this operation.");
    }
    identity = found.identity;
  }

  const result = await route.handler({
    env,
    request,
    params: match.params,
    body,
    identity,
    now,
    publicUrl: publicUrl(env, request),
    fetch: fetcher,
  });
  return jsonResponse(result.body, result.status, API_HEADERS);
}

/** Answers an `/api/v1` request; errors become `{ error, message }` bodies. */
export async function handleApi(
  request: Request,
  env: Env,
  url: URL,
  now: Date = new Date(),
  // The global `fetch` must not be called as a method of another object.
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<Response> {
  try {
    return await dispatch(request, env, url, now, fetcher);
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      console.error("Unhandled API error:", err instanceof Error ? err.message : String(err));
    }
    return errorResponse(err, API_HEADERS);
  }
}
