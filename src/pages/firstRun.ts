/**
 * First run (docs/spec.md "Home page and panel"): while KV holds no credential at all, `GET /`
 * shows a "create admin" form. `POST /first-run` creates the admin and shows its token once;
 * afterwards the form is never shown again.
 */

import { errorMessage, passwordFields } from "./components";
import { markup } from "./html";
import { centredLayout, type PageContext } from "./layout";
import { tokenPage } from "./token";

export interface FirstRunOptions {
  error?: string;
  /** The project name to prefill after a validation error. */
  project?: string;
}

/** The project slug as an HTML `pattern` (`-` is escaped for the `v` flag). */
export const SLUG_PATTERN = "[a-z0-9][a-z0-9\\-]{1,62}";

/** The "create admin" form. */
export function firstRunPage(ctx: PageContext, options: FirstRunOptions = {}): string {
  return centredLayout(
    ctx,
    "Set up",
    markup`<h1>Create the first admin</h1>
<p class="sub">This registry has no credentials yet. Create an admin credential to open the
panel. Either leave the password empty and the registry generates its token, or choose a
password and sign in with the project name as the login and that password. Either way the
whole token is shown once.</p>
${errorMessage(options.error)}
<form method="post" action="/first-run">
<label for="project">Project name</label>
<input id="project" name="project" type="text" required pattern="${SLUG_PATTERN}" autocomplete="off" spellcheck="false" placeholder="e.g. admin" value="${options.project ?? ""}">
<p class="hint">Lower-case letters, digits and dashes, 2 to 63 characters.</p>
${passwordFields()}
<button type="submit" class="block">Create admin</button>
</form>`,
    { page: "first-run" },
  );
}

/**
 * The login of a token whose secret is `password`, or `null` when the token has another
 * secret (the registry generated it).
 */
export function passwordLogin(token: string, password: string): string | null {
  const colon = token.indexOf(":");
  if (password === "" || colon < 0 || token.slice(colon + 1) !== password) return null;
  return token.slice(0, colon);
}

/**
 * The confirmation page with the new admin token, shown once. `login` is set when the admin
 * chose its password: it can then also log in with that login and the password.
 */
export function firstRunDonePage(
  ctx: PageContext,
  project: string,
  token: string,
  login: string | null = null,
): string {
  const how =
    login === null
      ? markup`Sign in with its token below.`
      : markup`Sign in with the login <code>${login}</code> and the password you chose. Below is
its whole token, for clients that take a single token.`;
  return tokenPage(ctx, {
    title: "Admin created",
    text: markup`The admin credential <strong>${project}</strong> has been created. ${how}`,
    token,
    next: { href: "/", label: "Continue to sign in" },
  });
}
