/**
 * The page a browser login opens (`GET /authorize/<session>`, docs/api.md 2.6): what the CLI
 * asks for, then either the sign-in form (project, password, one-time code) or, when the
 * browser already has a login session, only the approval. A publish login lists every
 * operation and approves only when the credential's grants allow them all. All forms post back
 * under `/authorize/<session>/`.
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
  const rows = checks.map(
    (c) =>
      markup`<li><code>${c.scope.eco}</code> <strong>${c.scope.package}</strong> <code>${c.scope.version}</code>${c.allowed ? "" : markup` <span class="badge warn">not allowed</span>`}</li>`,
  );
  return markup`<p class="sub">A command-line client asks to <strong>publish</strong> only the following ${checks.length === 1 ? "version" : "versions"} with a token valid for 15 minutes:</p>
<ul class="plain">${rows}</ul>`;
}

/** The sign-in form of an authorize page. */
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
<label for="code">One-time code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="8" spellcheck="false">
<p class="hint">Only if your login has two-factor authentication.</p>
<button type="submit" class="block">Sign in</button>
</form>`,
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
  const signedIn = markup`<div class="hint">Signed in as <strong>${data.project}</strong>.
<form class="inline-form" method="post" action="${action(id, "switch")}"><button type="submit" class="link">Use another login</button></form></div>`;
  let body: SafeHtml;
  if (data.problem !== undefined) {
    body = markup`${errorMessage(data.problem)}
<form method="post" action="${action(id, "deny")}"><button type="submit" class="block">Refuse</button></form>`;
  } else if (data.needsCode === true) {
    body = markup`<p>Enter a new one-time code to approve this publish.</p>
<form method="post" action="${action(id, "totp")}">
<label for="code">One-time code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="8" spellcheck="false" required>
<button type="submit" class="block">Verify</button>
</form>
<form method="post" action="${action(id, "deny")}"><button type="submit" class="link">Refuse</button></form>`;
  } else {
    const extended =
      data.extendedHours === undefined
        ? ""
        : markup`<label class="check"><input type="checkbox" name="extended" value="1"> Extended validity (${data.extendedHours} hours instead of 1 hour)</label>`;
    body = markup`<form method="post" action="${action(id, "approve")}">
${extended}
<button type="submit" class="block">Approve</button>
</form>
<form method="post" action="${action(id, "deny")}"><button type="submit" class="link">Refuse</button></form>`;
  }
  return centredLayout(
    ctx,
    "Approve",
    markup`<h1>Approve</h1>
${operation(data.session, data.checks)}
${errorMessage(data.error)}
${body}
${signedIn}`,
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
