import { getAdapter } from "./adapters/index";
import { API_HEADERS, API_PREFIX, handleApi } from "./api";
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

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  if (isApiPath(url.pathname)) return handleApi(request, env, url);
  const eco = url.pathname.split("/")[1] ?? "";
  const adapter = getAdapter(env, eco);
  if (adapter !== null) return handleNative(request, env, adapter, url);
  return (await handlePanel(request, env, url)) ?? serveAsset(request, env);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      await ensureMigrated(env);
    } catch {
      return errorResponse(
        new ValidationError("internal_error", "Data migration failed; try again later."),
        isApiPath(url.pathname) ? API_HEADERS : {},
      );
    }
    return route(request, env, url);
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(cleanup(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
