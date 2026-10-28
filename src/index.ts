import { getAdapter } from "./adapters/index";
import { API_HEADERS, API_PREFIX, handleApi } from "./api";
import { bucketMismatchError, bucketProblem } from "./core/bucket";
import { cleanup } from "./core/cron";
import { ValidationError } from "./core/errors";
import { errorResponse } from "./core/http";
import { ensureMigrated } from "./core/migrate";
import type { Env } from "./env";
import { handleNative } from "./native";
import { handlePanel } from "./panel";

function isApiPath(path: string): boolean {
  return path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
}

/** Static assets for `GET`/`HEAD`, falling through to a JSON `404`. */
async function serveAsset(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET" || request.method === "HEAD") {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;
  }
  return errorResponse(new ValidationError("not_found"));
}

async function route(
  request: Request,
  env: Env,
  url: URL,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
  if (isApiPath(url.pathname)) return handleApi(request, env, url);
  const eco = url.pathname.split("/")[1] ?? "";
  const adapter = getAdapter(env, eco);
  if (adapter !== null) return handleNative(request, env, adapter, url);
  return (await handlePanel(request, env, url, { waitUntil })) ?? serveAsset(request, env);
}

/**
 * Whether a request reads or writes package data in R2: the native protocols and the package
 * and publish endpoints. The panel, the credentials and the login endpoints do not, so an
 * admin can still sign in and fix the bucket.
 */
function usesBucket(env: Env, url: URL): boolean {
  if (isApiPath(url.pathname)) {
    const rest = url.pathname.slice(API_PREFIX.length);
    return rest === "/packages" || rest.startsWith("/packages/") || rest.startsWith("/publish/");
  }
  return getAdapter(env, url.pathname.split("/")[1] ?? "") !== null;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const headers = isApiPath(url.pathname) ? API_HEADERS : {};
    // First, so that migrations never run in a bucket that is not the installation's own.
    let problem;
    try {
      problem = await bucketProblem(env);
    } catch {
      return errorResponse(new ValidationError("internal_error"), headers);
    }
    if (problem !== null) {
      if (usesBucket(env, url)) return errorResponse(bucketMismatchError(problem), headers);
    } else {
      try {
        await ensureMigrated(env);
      } catch {
        return errorResponse(
          new ValidationError("internal_error", "Data migration failed; try again later."),
          headers,
        );
      }
    }
    return route(request, env, url, (promise) => ctx.waitUntil(promise));
  },

  async scheduled(controller, env, ctx): Promise<void> {
    // Nothing is cleaned up in a bucket that is not the installation's own.
    if ((await bucketProblem(env)) !== null) return;
    ctx.waitUntil(cleanup(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
