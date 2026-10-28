/**
 * The home page and the admin panel (docs/spec.md "Home page and panel"): `GET /` shows the
 * first-run form, the login page or the view of the session's credential kind (an admin is sent
 * on to `/admin/packages`); `POST /login`, `POST /logout` and `POST /first-run` handle the
 * forms; `GET /packages/<eco>/<name>[/<version>]` show a package and a version, and
 * `…/<version>/files/<file>` downloads a file. The admin pages live under `/admin/`: packages,
 * credentials (list, `new`, one credential) and settings. HTML is rendered here
 * (`src/pages/`); styles and scripts are static assets. Mutations go through `/api/v1` with the
 * session cookie, except the two admin forms whose answer is a one-time token ("new
 * credential", "add a secret"), which are form posts checked like the login form.
 */

import { ECOS } from "./adapters/types";
import {
  addSecret,
  createCredential,
  createFirstAdmin,
  hasAnyCredential,
  listCredentialViews,
  readCredentialView,
} from "./core/admin";
import {
  authenticate,
  clearSessionCookie,
  createSession,
  sessionCookie,
  sessionIdentity,
  sessionValueFrom,
  type Authentication,
  type Identity,
} from "./core/auth";
import {
  DEFAULT_APPEND_WINDOW_HOURS,
  DEFAULT_BUCKET_NAME,
  DEFAULT_CHECK_UPDATES,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_TOKEN_PREFIX,
  enabledEcosystems,
  missingRequired,
  publicUrl,
  setupStatus,
  tokenPrefix,
} from "./core/config";
import { ValidationError } from "./core/errors";
import { WWW_AUTHENTICATE } from "./core/http";
import { listPackages } from "./core/packages";
import { latestRelease, updatesEnabled } from "./core/updates";
import type { Env } from "./env";
import { adminPackagesPage, credentialHref } from "./pages/admin";
import { consumerPage } from "./pages/consumer";
import { MIN_PASSWORD_LENGTH } from "./pages/components";
import {
  credentialPage,
  credentialsPage,
  newCredentialPage,
  type SecretFormValues,
} from "./pages/credentials";
import { firstRunDonePage, firstRunPage, passwordLogin } from "./pages/firstRun";
import { markup } from "./pages/html";
import { ADMIN_SECTIONS, htmlResponse, type PageContext } from "./pages/layout";
import { loginPage, type LoginMode } from "./pages/login";
import { messagePage } from "./pages/message";
import { packagePage } from "./pages/package";
import { publishPage } from "./pages/publish";
import { settingsPage, type AdminSettings, type Setting } from "./pages/settings";
import { setupPage } from "./pages/setup";
import { placeholderSnippets } from "./pages/snippets";
import { tokenPage } from "./pages/token";
import { versionPage } from "./pages/version";
import { credentialForm, secretForm } from "./panelForms";
import { downloadUrl, visiblePackage, visibleVersion } from "./panelPackages";
import { Router, type Params } from "./router";
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
  /** Decoded path parameters of the route. */
  params: Params;
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
 * Cross-site form posts are refused. A post is accepted when its `Origin` is the registry's own
 * origin (the request's, or that of `PUBLIC_URL`), or when `Origin` is `null` or missing and
 * the browser vouches for it with `Sec-Fetch-Site: same-origin` (or `none`, a navigation the
 * user started). Browsers send `Origin: null` when the page was served with a referrer policy
 * that hides it; anything else, including a post with neither header, is refused.
 */
function sameOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null") {
    return (
      origin === new URL(request.url).origin || origin === new URL(publicUrl(env, request)).origin
    );
  }
  const site = request.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
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
  if (token === "") return null;
  // A header value must be bytes: a token with other characters (a non-ASCII admin password)
  // travels as Basic with its UTF-8 encoded in base64.
  return /^[\x21-\x7e]+$/.test(token) ? `Bearer ${token}` : `Basic ${base64Utf8(token)}`;
}

/**
 * The variables shown (read-only) on the settings page, with the value the Worker uses while
 * one is unset (`PUBLIC_URL`: the origin of the request).
 */
function settingsVars(r: PanelRequest): Setting[] {
  const defaults = {
    ECOSYSTEMS: ECOS.join(","),
    MAX_UPLOAD_BYTES: String(DEFAULT_MAX_UPLOAD_BYTES),
    TOKEN_PREFIX: DEFAULT_TOKEN_PREFIX,
    CHECK_UPDATES: String(DEFAULT_CHECK_UPDATES),
    APPEND_WINDOW_HOURS: String(DEFAULT_APPEND_WINDOW_HOURS),
    R2_BUCKET_NAME: DEFAULT_BUCKET_NAME,
    PUBLIC_URL: new URL(r.request.url).origin,
  } as const;
  return Object.entries(defaults).map(([name, fallback]) => ({
    name,
    value: r.env[name as keyof typeof defaults] ?? "",
    default: fallback,
  }));
}

async function adminSettings(r: PanelRequest): Promise<AdminSettings> {
  const settings: AdminSettings = {
    version: VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    setup: setupStatus(r.env),
    vars: settingsVars(r),
  };
  if (updatesEnabled(r.env)) {
    settings.update = { release: await latestRelease(r.env, r.fetch, r.now) };
  }
  return settings;
}

function signedInContext(r: PanelRequest, identity: Identity): PageContext {
  return { ...r.ctx, user: { project: identity.project, kind: identity.kind } };
}

async function renderHome(r: PanelRequest, identity: Identity): Promise<Response> {
  const ctx = signedInContext(r, identity);
  switch (identity.kind) {
    case "publish":
      return htmlResponse(publishPage(ctx));
    case "read":
      return htmlResponse(consumerPage(ctx, (await listPackages(r.env, identity)).packages));
    case "admin": {
      // `/?tab=<section>` was the admin view before it had pages of its own.
      const tab = r.url.searchParams.get("tab");
      const section = ADMIN_SECTIONS.find((s) => s.id === tab) ?? ADMIN_SECTIONS[0];
      return redirect(section?.href ?? "/admin/packages");
    }
  }
}

/**
 * The first-run page: the setup checklist above the "create admin" form, or only the
 * checklist while `SESSION_SECRET` is missing, because nobody could sign in afterwards.
 */
function firstRunView(r: PanelRequest, options: { error?: string; project?: string } = {}): string {
  const setup = setupStatus(r.env);
  if (sessionsMissing(setup)) return setupPage(r.ctx, setup);
  return firstRunPage(r.ctx, { ...options, setup });
}

function sessionsMissing(setup: ReturnType<typeof setupStatus>): boolean {
  return missingRequired(setup).some((item) => item.name === "SESSION_SECRET");
}

const home: PanelHandler = async (r) => {
  const session = await sessionIdentity(r.request, r.env, { now: () => r.now.getTime() });
  if (session !== null) return renderHome(r, session.identity);
  // A stale cookie (session ended, expired or credential gone) is cleared.
  const stale = sessionValueFrom(r.request) !== null;
  const headers: Record<string, string> = stale ? { "set-cookie": clearSessionCookie() } : {};
  if (!(await hasAnyCredential(r.env))) return htmlResponse(firstRunView(r), 200, headers);
  return htmlResponse(loginPage(r.ctx), 200, headers);
};

/** The identity of the request's panel session, or `null` without a valid one. */
async function sessionOf(r: PanelRequest): Promise<Identity | null> {
  const session = await sessionIdentity(r.request, r.env, { now: () => r.now.getTime() });
  return session?.identity ?? null;
}

function notFoundPage(ctx: PageContext): Response {
  return htmlResponse(
    messagePage(ctx, "Not found", "This package or version does not exist, or you may not see it."),
    404,
  );
}

/**
 * Runs a package route for a signed-in `read` or `admin` identity: without a session the
 * browser goes to the login page, a `publish` credential gets its notice with `403`.
 */
function packageRoute(
  handler: (r: PanelRequest, identity: Identity, ctx: PageContext) => Promise<Response>,
): PanelHandler {
  return async (r) => {
    const identity = await sessionOf(r);
    if (identity === null) return redirect("/");
    const ctx = signedInContext(r, identity);
    if (identity.kind === "publish") return htmlResponse(publishPage(ctx), 403);
    return handler(r, identity, ctx);
  };
}

const packageView = packageRoute(async (r, identity, ctx) => {
  const { eco = "", name = "" } = r.params;
  const visible = await visiblePackage(r.env, identity, eco, name);
  if (visible === null) return notFoundPage(ctx);
  const login = `${tokenPrefix(r.env)}${identity.project}`;
  const base = publicUrl(r.env, r.request);
  const snippets = placeholderSnippets(visible.adapter, base, login, [visible.view.name]);
  return htmlResponse(
    packagePage(ctx, {
      view: visible.view,
      snippets,
      transitive: visible.transitive,
      ...visible.details,
      admin: identity.kind === "admin",
    }),
  );
});

const versionView = packageRoute(async (r, identity, ctx) => {
  const { eco = "", name = "", version = "" } = r.params;
  const base = publicUrl(r.env, r.request);
  const data = await visibleVersion(r.env, identity, eco, name, version, base);
  return data === null ? notFoundPage(ctx) : htmlResponse(versionPage(ctx, data));
});

const download = packageRoute(async (r, identity, ctx) => {
  const { eco = "", name = "", version = "", file = "" } = r.params;
  const url = await downloadUrl(r.env, identity, eco, name, version, file, r.now);
  if (url === null) return notFoundPage(ctx);
  return new Response(null, {
    status: 302,
    headers: { location: url, "cache-control": "private, no-store" },
  });
});

// ---------------------------------------------------------------------------------------------
// Admin pages
// ---------------------------------------------------------------------------------------------

/**
 * Runs an admin route: without a session the browser goes to the login page, a `publish`
 * credential gets its notice and a `read` credential a notice, both with `403`.
 */
function adminRoute(
  handler: (r: PanelRequest, identity: Identity, ctx: PageContext) => Promise<Response>,
): PanelHandler {
  return async (r) => {
    const identity = await sessionOf(r);
    if (identity === null) return redirect("/");
    const ctx = signedInContext(r, identity);
    if (identity.kind === "publish") return htmlResponse(publishPage(ctx), 403);
    if (identity.kind !== "admin") {
      const text = "This page is only for admin credentials.";
      return htmlResponse(messagePage(ctx, "Forbidden", text), 403);
    }
    return handler(r, identity, ctx);
  };
}

const adminPackages = adminRoute(async (r, identity, ctx) =>
  htmlResponse(adminPackagesPage(ctx, (await listPackages(r.env, identity)).packages)),
);

const adminCredentials = adminRoute(async (r, _identity, ctx) =>
  htmlResponse(credentialsPage(ctx, (await listCredentialViews(r.env)).credentials, r.now)),
);

const newCredential = adminRoute(async (r, _identity, ctx) =>
  htmlResponse(newCredentialPage(ctx, { ecosystems: enabledEcosystems(r.env) })),
);

/** The login of a project's tokens. */
function loginOf(env: Env, project: string): string {
  return `${tokenPrefix(env)}${project}`;
}

/** How a token page tells to sign in with a chosen password, or nothing. */
function passwordNote(token: string, password: string) {
  const login = passwordLogin(token, password);
  return login === null
    ? ""
    : markup` Its login is <code>${login}</code> with the password you chose; below is its whole token, for clients that take a single token.`;
}

/** `POST /admin/credentials/new`: the token page, or the form again with the error. */
const createCredentialPost = adminRoute(async (r, _identity, ctx) => {
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const { body, values, password, repeat } = credentialForm(form);
  const ecosystems = enabledEcosystems(r.env);
  const again = (error: string, status: number) =>
    htmlResponse(newCredentialPage(ctx, { ecosystems, error, values }), status);
  const problem = passwordProblem(password, repeat);
  if (problem !== null) return again(problem, 400);
  let created: Awaited<ReturnType<typeof createCredential>>;
  try {
    created = await createCredential(r.env, body, r.now);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    return again(err.message, err.status);
  }
  const { project, kind } = created.credential;
  const token = created.token ?? "";
  return htmlResponse(
    tokenPage(ctx, {
      title: "Credential created",
      text: markup`The ${kind} credential <strong>${project}</strong> has been created.${passwordNote(token, password)}`,
      token,
      next: { href: credentialHref(project), label: "Continue to the credential" },
    }),
  );
});

/** The page of one credential, optionally with a refused "add a secret" form. */
async function renderCredential(
  r: PanelRequest,
  ctx: PageContext,
  project: string,
  refused?: { error: string; values: SecretFormValues; status: number },
): Promise<Response> {
  let credential;
  try {
    credential = await readCredentialView(r.env, project);
  } catch (err) {
    if (err instanceof ValidationError && err.code === "not_found") {
      return htmlResponse(messagePage(ctx, "Not found", "This credential does not exist."), 404);
    }
    throw err;
  }
  const page = credentialPage(ctx, {
    credential,
    ecosystems: enabledEcosystems(r.env),
    now: r.now,
    login: loginOf(r.env, project),
    secretError: refused?.error,
    secretValues: refused?.values,
  });
  return htmlResponse(page, refused?.status ?? 200);
}

const credentialView = adminRoute(async (r, _identity, ctx) =>
  renderCredential(r, ctx, r.params.project ?? ""),
);

/**
 * `POST /admin/credentials/<project>/secrets`: a `key` secret answers with the token page, a
 * `gh` secret goes back to the credential; an error shows the credential with the form again.
 */
const addSecretPost = adminRoute(async (r, _identity, ctx) => {
  const project = r.params.project ?? "";
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const { body, values, password, repeat } = secretForm(form);
  const problem = passwordProblem(password, repeat);
  if (problem !== null) {
    return renderCredential(r, ctx, project, { error: problem, values, status: 400 });
  }
  let added: Awaited<ReturnType<typeof addSecret>>;
  try {
    added = await addSecret(r.env, project, body, r.now);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    // A credential that is gone is answered with its `404` page.
    if (err.code === "not_found") return renderCredential(r, ctx, project);
    return renderCredential(r, ctx, project, { error: err.message, values, status: err.status });
  }
  if (added.token === undefined) return redirect(`${credentialHref(project)}#secrets`);
  return htmlResponse(
    tokenPage(ctx, {
      title: "Secret added",
      text: markup`A new key secret (<code>${added.secret.id}</code>) has been added to <strong>${project}</strong>.${passwordNote(added.token, password)}`,
      token: added.token,
      next: { href: credentialHref(project), label: "Back to the credential" },
    }),
  );
});

const adminSettingsView = adminRoute(async (r, _identity, ctx) =>
  htmlResponse(settingsPage(ctx, await adminSettings(r))),
);

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
  let value: string;
  try {
    value = await createSession(r.env, auth.identity.record.project, {
      now: () => r.now.getTime(),
    });
  } catch (err) {
    // SESSION_SECRET is missing: the message names the setting, never a secret.
    if (!(err instanceof ValidationError)) throw err;
    return htmlResponse(messagePage(r.ctx, "Sessions are not configured", err.message), 500);
  }
  return redirect("/", { "set-cookie": sessionCookie(value) });
};

/** Sessions live only in the signed cookie, so logging out just clears it. */
const logout: PanelHandler = async () => redirect("/", { "set-cookie": clearSessionCookie() });

/** Why the optional password of the first-run form is refused, or `null` when it is fine. */
export function passwordProblem(password: string, repeat: string): string | null {
  if (password === "" && repeat === "") return null;
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `The password must have at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return password === repeat ? null : "The passwords do not match.";
}

const firstRun: PanelHandler = async (r) => {
  const done = () =>
    htmlResponse(
      messagePage(r.ctx, "Already set up", "The registry has already been set up."),
      403,
    );
  if (await hasAnyCredential(r.env)) return done();
  // An admin created now could not sign in: the page shows what is missing instead.
  if (sessionsMissing(setupStatus(r.env)))
    return htmlResponse(setupPage(r.ctx, setupStatus(r.env)), 409);
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const project = (form.get("project") ?? "").trim();
  const password = form.get("password") ?? "";
  const problem = passwordProblem(password, form.get("password_repeat") ?? "");
  if (problem !== null) {
    return htmlResponse(firstRunView(r, { error: problem, project }), 400);
  }
  try {
    const { token } = await createFirstAdmin(r.env, project, r.now, password || undefined);
    const login = passwordLogin(token, password);
    return htmlResponse(firstRunDonePage(r.ctx, project, token, login));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    if (err.code === "invalid_request") {
      return htmlResponse(firstRunView(r, { error: err.message, project }), 400);
    }
    return done();
  }
};

/** Form posts checked by `sameOrigin`. */
const POSTS = new Set<PanelHandler>([login, logout, firstRun, createCredentialPost, addSecretPost]);

const routes = new Router<PanelHandler>()
  .add("GET", "/", home)
  .add("POST", "/login", login)
  .add("POST", "/logout", logout)
  .add("POST", "/first-run", firstRun)
  .add("GET", "/packages/:eco/:name", packageView)
  .add("GET", "/packages/:eco/:name/:version", versionView)
  .add("GET", "/packages/:eco/:name/:version/files/:file", download)
  .add("GET", "/admin/packages", adminPackages)
  .add("GET", "/admin/credentials", adminCredentials)
  // Before `:project`, which would match `new` too (see `credentialHref`).
  .add("GET", "/admin/credentials/new", newCredential)
  .add("POST", "/admin/credentials/new", createCredentialPost)
  .add("GET", "/admin/credentials/:project", credentialView)
  .add("POST", "/admin/credentials/:project/secrets", addSecretPost)
  .add("GET", "/admin/settings", adminSettingsView);

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
      params: match.params,
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
