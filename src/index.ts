import type { Env } from "./env";
import { MIN_CLIENT_VERSION, SCHEMA_VERSION, VERSION } from "./version";

const API_PREFIX = "/api/v1/";

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function apiJson(body: unknown, status: number): Response {
  return json(body, status, { "x-min-client-version": MIN_CLIENT_VERSION });
}

function routeApi(request: Request, path: string): Response {
  if (request.method === "GET" && path === "version") {
    return apiJson(
      { version: VERSION, minClientVersion: MIN_CLIENT_VERSION, schemaVersion: SCHEMA_VERSION },
      200,
    );
  }
  return apiJson({ error: "not_found", message: "Not found." }, 404);
}

function route(request: Request, url: URL): Response {
  if (url.pathname.startsWith(API_PREFIX)) {
    return routeApi(request, url.pathname.slice(API_PREFIX.length));
  }
  return json({ error: "not_found", message: "Not found." }, 404);
}

export default {
  async fetch(request): Promise<Response> {
    return route(request, new URL(request.url));
  },

  async scheduled(): Promise<void> {
    // Hourly cleanup of staging uploads and expired secrets is not implemented yet.
  },
} satisfies ExportedHandler<Env>;
