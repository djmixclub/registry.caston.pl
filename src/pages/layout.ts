/**
 * The document shell shared by every page, and the HTML response with the panel's security
 * headers (docs/spec.md "Home page and panel"). Styles and scripts come from Workers Static
 * Assets (`public/`); pages never contain inline scripts, styles or event handlers.
 */

import type { Kind } from "../core/auth";
import { markup, type SafeHtml } from "./html";

/**
 * `Content-Security-Policy` of every HTML response: everything from the same origin only
 * (`default-src 'self'`), plus the directives that `default-src` does not cover.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Headers of every HTML response. */
export const HTML_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
};

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

function header(ctx: PageContext): SafeHtml {
  const user = ctx.user;
  const account =
    user === undefined
      ? ""
      : markup`<form class="signed-in" method="post" action="/logout">
<span>Signed in as <strong>${user.project}</strong> <span class="badge">${user.kind}</span></span>
<button type="submit" class="link">Log out</button>
</form>`;
  return markup`<header class="site-header">
<a class="brand" href="/">${ctx.host}</a>
${account}
</header>`;
}

/** A complete HTML document around `content`. */
export function layout(ctx: PageContext, title: string, content: SafeHtml): string {
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
<body>
${header(ctx)}
<main>
${content}
</main>
<footer class="site-footer">Serverless Registry ${ctx.version}</footer>
</body>
</html>
`.value;
}

/** An HTML response with the panel's security headers; `headers` are added last. */
export function htmlResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers: { ...HTML_HEADERS, ...headers } });
}
