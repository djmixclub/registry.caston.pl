/**
 * The home page and the admin panel (docs/spec.md "Home page and panel"): `GET /` shows the
 * first-run form, the login page or the view of the session's credential kind; `POST /login`,
 * `POST /logout` and `POST /first-run` handle the forms. HTML is rendered here (`src/pages/`);
 * styles and scripts are static assets. Mutations go through `/api/v1` with the session cookie.
 */

import { enabledAdapters } from "./adapters/index";
import { createFirstAdmin, hasAnyCredential, listCredentialViews } from "./core/admin";
import {
  authenticate,
  clearSessionCookie,
  createSession,
  deleteSession,
  readSession,
  sessionCookie,
  sessionIdFrom,
  sessionIdentity,
  type Authentication,
  type Identity,
} from "./core/auth";
import { enabledEcosystems, publicUrl } from "./core/config";
import { ValidationError } from "./core/errors";
import { WWW_AUTHENTICATE } from "./core/http";
import { listPackages } from "./core/packages";
import { latestRelease, updatesEnabled } from "./core/updates";
import type { Env } from "./env";
import { adminPage, adminTab, type AdminData, type AdminSettings } from "./pages/admin";
import { consumerPage, type ConsumerSection } from "./pages/consumer";
import { firstRunDonePage, firstRunPage } from "./pages/firstRun";
import { htmlResponse, type PageContext } from "./pages/layout";
import { loginPage, type LoginMode } from "./pages/login";
import { messagePage } from "./pages/message";
import { publishPage } from "./pages/publish";
import { placeholderSnippets } from "./pages/snippets";
import { Router } from "./router";
import { MIN_CLIENT_VERSION, SCHEMA_VERSION, VERSION } from "./version";

/** Form bodies are small: a token, or a login and a password (a `gh` JWT fits easily). */
const MAX_FORM_BYTES = 64 * 1024;

/** Injectable clock and network for tests. */
export interface PanelDeps {
  now?: () => Date;
  fetch?: typeof fetch;
}

interface PanelRequest {
  request: Request;
  env: Env;
  url: URL;
  now: Date;
  fetch: typeof fetch;
  ctx: PageContext;
}

type PanelHandler = (r: PanelRequest) => Promise<Response>;

const LOGIN_FAILED = "The token, or the login and password, are not valid.";

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "private, no-store", ...headers },
  });
}

/**
 * Cross-site form posts are refused: browsers send `Origin` with every `POST`, and it must be
 * the registry's own origin (the request's, or that of `PUBLIC_URL`).
 */
function sameOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  return (
    origin === new URL(request.url).origin || origin === new URL(publicUrl(env, request)).origin
  );
}

/** The `application/x-www-form-urlencoded` body, or `null` when it is missing or too large. */
async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(type)) return null;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return null;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_FORM_BYTES) return null;
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

function base64Utf8(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The `Authorization` value for a login form: `Bearer <token>`, or `Basic` with the login and
 * password, which accepts both the password half of a token and a whole pasted token.
 */
export function loginAuthorization(form: URLSearchParams): string | null {
  if (form.get("mode") === "password") {
    const login = (form.get("login") ?? "").trim();
    const password = (form.get("password") ?? "").trim();
    if (login === "" || password === "") return null;
    return `Basic ${base64Utf8(`${login}:${password}`)}`;
  }
  const token = (form.get("token") ?? "").trim();
  return token === "" ? null : `Bearer ${token}`;
}

/**
 * The consumer view's sections: every enabled ecosystem the credential has a grant for, with
 * its explicitly granted packages and the client configuration for them.
 */
async function consumerSections(r: PanelRequest, identity: Identity): Promise<ConsumerSection[]> {
  const { packages } = await listPackages(r.env, identity);
  const base = publicUrl(r.env, r.request);
  const login = `${r.env.TOKEN_PREFIX ?? ""}${identity.project}`;
  return enabledAdapters(r.env)
    .filter((adapter) => identity.grants.some((g) => g.eco === adapter.eco))
    .map((adapter) => {
      const own = packages.filter((p) => p.eco === adapter.eco);
      const names = own.map((p) => p.name);
      return {
        eco: adapter.eco,
        packages: own,
        snippets: placeholderSnippets(adapter, base, login, names),
      };
    });
}

/** The variables shown (read-only) in the Settings tab. */
const SETTINGS_VARS = [
  "ECOSYSTEMS",
  "MAX_UPLOAD_BYTES",
  "TOKEN_PREFIX",
  "CHECK_UPDATES",
  "APPEND_WINDOW_HOURS",
  "PUBLIC_URL",
] as const;

async function adminSettings(r: PanelRequest): Promise<AdminSettings> {
  const settings: AdminSettings = {
    version: VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    vars: SETTINGS_VARS.map((name) => ({ name, value: r.env[name] ?? "" })),
  };
  if (updatesEnabled(r.env)) {
    settings.update = { release: await latestRelease(r.env, r.fetch, r.now) };
  }
  return settings;
}

/** The data of the admin tab named by `?tab=`. */
async function adminData(r: PanelRequest, identity: Identity): Promise<AdminData> {
  const tab = adminTab(r.url.searchParams.get("tab"));
  switch (tab) {
    case "packages":
      return { tab, packages: (await listPackages(r.env, identity)).packages };
    case "credentials":
      return {
        tab,
        credentials: (await listCredentialViews(r.env)).credentials,
        ecosystems: enabledEcosystems(r.env),
        now: r.now,
      };
    case "settings":
      return { tab, settings: await adminSettings(r) };
  }
}

async function renderHome(r: PanelRequest, identity: Identity): Promise<Response> {
  const ctx: PageContext = { ...r.ctx, user: { project: identity.project, kind: identity.kind } };
  switch (identity.kind) {
    case "publish":
      return htmlResponse(publishPage(ctx));
    case "read":
      return htmlResponse(consumerPage(ctx, await consumerSections(r, identity)));
    case "admin":
      return htmlResponse(adminPage(ctx, await adminData(r, identity)));
  }
}

const home: PanelHandler = async (r) => {
  const session = await sessionIdentity(r.request, r.env, { now: () => r.now.getTime() });
  if (session !== null) return renderHome(r, session.identity);
  // A stale cookie (session ended, expired or credential gone) is cleared.
  const stale = sessionIdFrom(r.request) !== null;
  const headers: Record<string, string> = stale ? { "set-cookie": clearSessionCookie() } : {};
  if (!(await hasAnyCredential(r.env))) return htmlResponse(firstRunPage(r.ctx), 200, headers);
  return htmlResponse(loginPage(r.ctx), 200, headers);
};

const login: PanelHandler = async (r) => {
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const mode: LoginMode = form.get("mode") === "password" ? "password" : "token";
  const authorization = loginAuthorization(form);
  let auth: Authentication | null = null;
  let error = LOGIN_FAILED;
  try {
    auth =
      authorization === null
        ? null
        : await authenticate(new Request(r.url, { headers: { authorization } }), r.env, {
            now: () => r.now.getTime(),
            fetch: r.fetch,
            kindHint: "read",
          });
  } catch (err) {
    // A `_` login that matches several credentials says how to name the project.
    if (!(err instanceof ValidationError) || err.code !== "unauthorized") throw err;
    error = err.message;
  }
  if (auth === null) {
    const page = loginPage(r.ctx, {
      error,
      mode,
      login: mode === "password" ? (form.get("login") ?? "").trim() : undefined,
    });
    return htmlResponse(page, 401, { "www-authenticate": WWW_AUTHENTICATE });
  }
  const id = await createSession(r.env, auth.identity.record.project, {
    now: () => r.now.getTime(),
  });
  return redirect("/", { "set-cookie": sessionCookie(id) });
};

const logout: PanelHandler = async (r) => {
  const session = await readSession(r.request, r.env);
  if (session !== null) await deleteSession(r.env, session.id);
  return redirect("/", { "set-cookie": clearSessionCookie() });
};

const firstRun: PanelHandler = async (r) => {
  const done = () =>
    htmlResponse(
      messagePage(r.ctx, "Already set up", "The registry has already been set up."),
      403,
    );
  if (await hasAnyCredential(r.env)) return done();
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const project = (form.get("project") ?? "").trim();
  try {
    const { token } = await createFirstAdmin(r.env, project, r.now);
    return htmlResponse(firstRunDonePage(r.ctx, project, token));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    if (err.code === "invalid_request") {
      return htmlResponse(firstRunPage(r.ctx, { error: err.message, project }), 400);
    }
    return done();
  }
};

/** Form posts checked for a same-origin `Origin` header. */
const POSTS = new Set<PanelHandler>([login, logout, firstRun]);

const routes = new Router<PanelHandler>()
  .add("GET", "/", home)
  .add("POST", "/login", login)
  .add("POST", "/logout", logout)
  .add("POST", "/first-run", firstRun);

/**
 * Answers a panel route, or returns `null` when the path is not one (static assets and the
 * JSON `404` take over). `HEAD` is answered like `GET` without a body.
 */
export async function handlePanel(
  request: Request,
  env: Env,
  url: URL,
  deps: PanelDeps = {},
): Promise<Response | null> {
  const head = request.method === "HEAD";
  const match = routes.match(head ? "GET" : request.method, url.pathname);
  if (match === null) return null;
  const ctx: PageContext = { host: new URL(publicUrl(env, request)).host, version: VERSION };
  if (POSTS.has(match.value) && !sameOrigin(request, env)) {
    return htmlResponse(messagePage(ctx, "Forbidden", "Cross-site form posts are refused."), 403);
  }
  let response: Response;
  try {
    response = await match.value({
      request,
      env,
      url,
      now: deps.now?.() ?? new Date(),
      // The global `fetch` must not be called as a method of another object.
      fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
      ctx,
    });
  } catch (err) {
    console.error("Unhandled panel error:", err instanceof Error ? err.message : String(err));
    response = htmlResponse(
      messagePage(ctx, "Something went wrong", "The page could not be shown; try again later."),
      500,
    );
  }
  return head
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}
