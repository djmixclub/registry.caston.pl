import type { Env } from "./env";

const API_PREFIX = "/api/v1/";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function notFound(): Response {
  return json({ error: "not_found", message: "Not found." }, 404);
}

async function route(request: Request, url: URL): Promise<Response> {
  if (url.pathname.startsWith(API_PREFIX)) {
    return notFound();
  }
  return notFound();
}

export default {
  async fetch(request): Promise<Response> {
    return route(request, new URL(request.url));
  },

  async scheduled(): Promise<void> {
    // Hourly cleanup of staging uploads and expired secrets is not implemented yet.
  },
} satisfies ExportedHandler<Env>;
