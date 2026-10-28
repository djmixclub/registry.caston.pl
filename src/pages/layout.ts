/**
 * The document shells shared by every page, and the HTML response with the panel's security
 * headers (docs/spec.md "Home page and panel"). {@link layout} is the shell of the signed-in
 * pages: a header with the registry's name, the admin navigation (kind `admin`) and the
 * signed-in user. {@link centredLayout} is the shell of the login, first-run and one-time token
 * pages: the registry's name above one centred card. Styles and scripts come from Workers
 * Static Assets (`public/`); pages never contain inline scripts, styles or event handlers.
 * `data-page` on `<body>` names the page, so `public/app.js` runs only what the page needs.
 */

import type { Kind } from "../core/auth";
import { markup, type SafeHtml } from "./html";

/**
 * `Content-Security-Policy` of every HTML response: everything from the same origin only
 * (`default-src 'self'`), plus the directives that `default-src` does not cover.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * Headers of every HTML response. `Referrer-Policy: same-origin` keeps referrers inside the
 * registry, so browsers send the real `Origin` with the panel's form posts (with `no-referrer`
 * they send `Origin: null`).
 */
export const HTML_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "cache-control": "private, no-store",
};

/** The documentation linked from the footer. */
export const DOCS_URL = "https://github.com/kduma-OSS/serverless-registry-worker/tree/main/docs";

/** The signed-in user shown in the header. */
export interface SignedIn {
  project: string;
  kind: Kind;
}

/** What every page needs besides its content. */
export interface PageContext {
  /** Host of the registry (the registry's name in the header). */
  host: string;
  /** Version of the Worker (footer). */
  version: string;
  /** The signed-in user, if any. */
  user?: SignedIn;
}

/** The sections of the admin navigation. */
export type AdminSection = "packages" | "credentials" | "settings";

/** The admin navigation, in display order. */
export const ADMIN_SECTIONS: readonly { id: AdminSection; title: string; href: string }[] = [
  { id: "packages", title: "Packages", href: "/admin/packages" },
  { id: "credentials", title: "Credentials", href: "/admin/credentials" },
  { id: "settings", title: "Settings", href: "/admin/settings" },
];

/** How a page is framed. */
export interface LayoutOptions {
  /** `data-page` of `<body>`: scopes the scripts of `public/app.js`. */
  page?: string;
  /** The admin section highlighted in the header. */
  section?: AdminSection;
  /** A wider centred card ({@link centredLayout}), for the setup checklist. */
  wide?: boolean;
}

/** The home of the signed-in user: the admin package list, or `/` for everyone else. */
export function homeHref(ctx: PageContext): string {
  return ctx.user?.kind === "admin" ? "/admin/packages" : "/";
}

/** The registry's mark: an outlined cube (decorative). */
export const CUBE_ICON = markup`<svg class="icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/></svg>`;

function adminNav(current: AdminSection | undefined): SafeHtml {
  const links = ADMIN_SECTIONS.map(
    (s) =>
      markup`<a href="${s.href}"${s.id === current ? markup` aria-current="page"` : ""}>${s.title}</a>`,
  );
  return markup`<nav class="site-nav" aria-label="Administration">${links}</nav>`;
}

function header(ctx: PageContext, options: LayoutOptions): SafeHtml {
  const user = ctx.user;
  const nav = user?.kind === "admin" ? adminNav(options.section) : "";
  const account =
    user === undefined
      ? ""
      : markup`<form class="signed-in" method="post" action="/logout">
<span>Signed in as <strong>${user.project}</strong> <span class="badge">${user.kind}</span></span>
<button type="submit" class="link">Log out</button>
</form>`;
  return markup`<header class="site-header">
<a class="brand" href="${homeHref(ctx)}">${CUBE_ICON}<span>${ctx.host}</span></a>
${nav}
${account}
</header>`;
}

function footer(ctx: PageContext): SafeHtml {
  return markup`<footer class="site-footer">Serverless Registry ${ctx.version} · <a href="${DOCS_URL}" rel="noreferrer">Documentation</a></footer>`;
}

function document(
  ctx: PageContext,
  title: string,
  options: LayoutOptions,
  body: SafeHtml,
  bodyClass?: string,
): string {
  const page = options.page === undefined ? "" : markup` data-page="${options.page}"`;
  const cls = bodyClass === undefined ? "" : markup` class="${bodyClass}"`;
  return markup`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · ${ctx.host}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body${cls}${page}>
${body}
${footer(ctx)}
</body>
</html>
`.value;
}

/** A complete HTML document around `content`, with the site header. */
export function layout(
  ctx: PageContext,
  title: string,
  content: SafeHtml,
  options: LayoutOptions = {},
): string {
  return document(
    ctx,
    title,
    options,
    markup`${header(ctx, options)}
<main>
${content}
</main>`,
  );
}

/**
 * A complete HTML document with the registry's name above one centred card (`content` is
 * the card's inside), without the site header: the login, first-run and token pages.
 */
export function centredLayout(
  ctx: PageContext,
  title: string,
  content: SafeHtml,
  options: LayoutOptions = {},
): string {
  return document(
    ctx,
    title,
    options,
    markup`<main class="centred">
<div class="centred-box${options.wide === true ? " wide" : ""}">
<a class="centred-brand" href="/">${CUBE_ICON}<strong>${ctx.host}</strong></a>
<section class="centred-card">
${content}
</section>
</div>
</main>`,
    "centred-page",
  );
}

/** An HTML response with the panel's security headers; `headers` are added last. */
export function htmlResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers: { ...HTML_HEADERS, ...headers } });
}
