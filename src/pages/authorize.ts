/**
 * The page a browser login opens (`GET /authorize/<session>`, docs/api.md 2.6): what the CLI
 * asks for, then the sign-in (project and password, and a second step for the one-time code)
 * or, when the browser already has a login session, only the approval. A publish login lists
 * every operation and approves only when the credential's grants allow them all; a yank or
 * delete login lists the versions or packages and approves only for an `admin` credential. All forms
 * post back under `/authorize/<session>/`.
 */

import type { LoginSession, ScopeCheck } from "../core/login";
import { errorMessage } from "./components";
import { markup, type SafeHtml } from "./html";
import { centredLayout, type PageContext } from "./layout";

function action(id: string, name: string): string {
  return `/authorize/${id}/${name}`;
}

function operation(session: LoginSession, checks: readonly ScopeCheck[]): SafeHtml {
  if (session.purpose === "pull") {
    const eco = session.eco === undefined ? "" : ` ${session.eco}`;
    return markup`<p class="sub">A command-line client asks to <strong>download${eco} packages</strong> with a short-lived token.</p>`;
  }
  if (session.purpose === "yank" || session.purpose === "delete") return adminOperation(session);
  const rows = checks.map(
    (c) =>
      markup`<li><code>${c.scope.eco}</code> <strong>${c.scope.package}</strong> <code>${c.scope.version}</code>${c.allowed ? "" : markup` <span class="badge warn">not allowed</span>`}</li>`,
  );
  return markup`<p class="sub">A command-line client asks to <strong>publish</strong> only the following ${checks.length === 1 ? "version" : "versions"} with a token valid for 15 minutes:</p>
<ul class="plain">${rows}</ul>`;
}

/**
 * A yank or delete login lists every package version (or, for a delete, whole package) it
 * names. A delete is irreversible, so it is shown with a warning.
 */
function adminOperation(session: LoginSession): SafeHtml {
  const ops = session.ops ?? [];
  const rows = ops.map((o) =>
    o.version === undefined
      ? markup`<li><code>${o.eco}</code> <strong>${o.package}</strong> <span class="badge warn">the whole package, every version</span></li>`
      : markup`<li><code>${o.eco}</code> <strong>${o.package}</strong> <code>${o.version}</code></li>`,
  );
  const versions = ops.length === 1 ? "this" : "these";
  if (session.purpose === "delete") {
    return markup`<p class="sub">A command-line client asks to <strong>permanently delete</strong> ${versions} with a token valid for 15 minutes:</p>
<ul class="plain">${rows}</ul>
<p class="error">Deleting removes the files and cannot be undone.</p>`;
  }
  return markup`<p class="sub">A command-line client asks to <strong>yank</strong> ${versions} with a token valid for 15 minutes; a yanked version is no longer offered for new installs:</p>
<ul class="plain">${rows}</ul>`;
}

/** A form with one button. */
function button(id: string, name: string, label: string, kind: "primary" | "secondary"): SafeHtml {
  const cls = kind === "primary" ? "block" : "block secondary";
  return markup`<form method="post" action="${action(id, name)}"><button type="submit" class="${cls}">${label}</button></form>`;
}

/** The line under the buttons: who is signed in, and a way out. */
function foot(id: string, project: string): SafeHtml {
  return markup`<div class="card-foot">Signed in as <strong>${project}</strong> · <form class="inline-form" method="post" action="${action(id, "switch")}"><button type="submit" class="link">Use another login</button></form></div>`;
}

/** The first step of the sign-in: the project and its password. */
export function authorizeSignInPage(
  ctx: PageContext,
  id: string,
  session: LoginSession,
  checks: readonly ScopeCheck[],
  options: { error?: string; project?: string } = {},
): string {
  return centredLayout(
    ctx,
    "Sign in to approve",
    markup`<h1>Sign in</h1>
${operation(session, checks)}
${errorMessage(options.error)}
<form method="post" action="${action(id, "login")}" class="login">
<label for="project">Login</label>
<input id="project" name="project" type="text" autocomplete="username" spellcheck="false" placeholder="project" value="${options.project ?? ""}" required>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" spellcheck="false" required>
<button type="submit" class="block">Sign in</button>
</form>`,
    { page: "authorize" },
  );
}

/** The second step of the sign-in: the one-time code of a login whose password was right. */
export function authorizeCodePage(
  ctx: PageContext,
  id: string,
  session: LoginSession,
  checks: readonly ScopeCheck[],
  options: { error?: string; project: string },
): string {
  return centredLayout(
    ctx,
    "One-time code",
    markup`<h1>One-time code</h1>
${operation(session, checks)}
<p class="sub">Enter the code from your authenticator app to sign in as <strong>${options.project}</strong>.</p>
${errorMessage(options.error)}
<form method="post" action="${action(id, "code")}" class="login">
<label for="code">One-time code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="8" spellcheck="false" required autofocus>
<button type="submit" class="block">Verify</button>
</form>
<div class="card-foot"><form class="inline-form" method="post" action="${action(id, "switch")}"><button type="submit" class="link">Start over</button></form></div>`,
    { page: "authorize" },
  );
}

/** What the approval form needs. */
export interface ApproveData {
  id: string;
  session: LoginSession;
  checks: readonly ScopeCheck[];
  project: string;
  /** Why this login cannot approve (wrong kind, grants), or `undefined`. */
  problem?: string;
  /** The approval needs a fresh one-time code first. */
  needsCode?: boolean;
  /** Hours of the extended validity offered for a pull, or `undefined` for no choice. */
  extendedHours?: number;
  error?: string;
}

/** The approval form of an authorize page. */
export function authorizeApprovePage(ctx: PageContext, data: ApproveData): string {
  const { id } = data;
  let body: SafeHtml;
  if (data.problem !== undefined) {
    body = markup`${errorMessage(data.problem)}
<div class="card-actions">${button(id, "deny", "Refuse", "primary")}</div>`;
  } else if (data.needsCode === true) {
    body = markup`<p>Enter a new one-time code to approve this request.</p>
<form method="post" action="${action(id, "totp")}">
<label for="code">One-time code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="8" spellcheck="false" required>
<div class="card-actions"><button type="submit" class="block">Verify</button></div>
</form>
<div class="card-actions">${button(id, "deny", "Refuse", "secondary")}</div>`;
  } else {
    const extended =
      data.extendedHours === undefined
        ? ""
        : markup`<label class="check"><input type="checkbox" name="extended" value="1"> Extended validity (${data.extendedHours} hours instead of 1 hour)</label>`;
    body = markup`<form method="post" action="${action(id, "approve")}">
${extended}
<div class="card-actions"><button type="submit" class="block">Approve</button></div>
</form>
<div class="card-actions">${button(id, "deny", "Refuse", "secondary")}</div>`;
  }
  return centredLayout(
    ctx,
    "Approve",
    markup`<h1>Approve</h1>
${operation(data.session, data.checks)}
${errorMessage(data.error)}
${body}
${foot(id, data.project)}`,
    { page: "authorize" },
  );
}

/** The final page: the decision was recorded. */
export function authorizeDonePage(ctx: PageContext, approved: boolean): string {
  return centredLayout(
    ctx,
    approved ? "Approved" : "Refused",
    markup`<h1>${approved ? "Approved" : "Refused"}</h1>
<p class="sub">${approved ? "The command-line client now has its token." : "Nothing was approved."} You can close this window.</p>`,
    { page: "authorize" },
  );
}
