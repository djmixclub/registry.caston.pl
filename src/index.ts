import type { Env } from "./env";
import { ValidationError } from "./core/errors";
import { cleanup } from "./core/cron";
import { errorResponse, jsonResponse } from "./core/http";
import { ensureMigrated } from "./core/migrate";
import { MIN_CLIENT_VERSION, SCHEMA_VERSION, VERSION } from "./version";

const API_PREFIX = "/api/v1/";

const API_HEADERS = { "x-min-client-version": MIN_CLIENT_VERSION };

function apiJson(body: unknown, status: number): Response {
  return jsonResponse(body, status, API_HEADERS);
}

function routeApi(request: Request, path: string): Response {
  if (request.method === "GET" && path === "version") {
    return apiJson(
      { version: VERSION, minClientVersion: MIN_CLIENT_VERSION, schemaVersion: SCHEMA_VERSION },
      200,
    );
  }
  return errorResponse(new ValidationError("not_found"), API_HEADERS);
}

function route(request: Request, url: URL): Response {
  if (url.pathname.startsWith(API_PREFIX)) {
    return routeApi(request, url.pathname.slice(API_PREFIX.length));
  }
  return errorResponse(new ValidationError("not_found"));
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      await ensureMigrated(env);
    } catch {
      return errorResponse(
        new ValidationError("internal_error", "Data migration failed; try again later."),
      );
    }
    return route(request, new URL(request.url));
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(cleanup(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
