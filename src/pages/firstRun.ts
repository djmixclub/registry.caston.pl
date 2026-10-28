/**
 * First run (docs/spec.md "Home page and panel"): while KV holds no credential at all, `GET /`
 * shows a "create admin" form. `POST /first-run` creates the admin with a `login` secret and
 * shows its password (and one-time code enrolment) once; afterwards the form is never shown
 * again.
 */

import { missingRequired, type SetupItem } from "../core/config";
import { errorMessage, passwordFields, totpField } from "./components";
import { markup } from "./html";
import { centredLayout, type PageContext } from "./layout";
import { firstRunSetup } from "./setup";

export interface FirstRunOptions {
  error?: string;
  /** The project name to prefill after a validation error. */
  project?: string;
  /** The setup checklist shown above the form. */
  setup?: SetupItem[];
  /** Whether the one-time code box is ticked after a validation error. */
  totp?: boolean;
}

/** The project slug as an HTML `pattern` (`-` is escaped for the `v` flag). */
export const SLUG_PATTERN = "[a-z0-9][a-z0-9\\-]{1,62}";

/** The "create admin" form. */
export function firstRunPage(ctx: PageContext, options: FirstRunOptions = {}): string {
  const setup = options.setup;
  return centredLayout(
    ctx,
    "Set up",
    markup`<h1>Create the first admin</h1>
<p class="sub">This registry has no credentials yet. Create an admin credential to open the
panel. You sign in with the project name as the login and a password, and can require a
one-time code from an authenticator app as well. Leave the password empty and the registry
generates one; either way it is shown once.</p>
${setup === undefined ? "" : firstRunSetup(setup)}
${errorMessage(options.error)}
<form method="post" action="/first-run">
<label for="project">Project name</label>
<input id="project" name="project" type="text" required pattern="${SLUG_PATTERN}" autocomplete="off" spellcheck="false" placeholder="e.g. admin" value="${options.project ?? ""}">
<p class="hint">Lower-case letters, digits and dashes, 2 to 63 characters.</p>
${passwordFields()}
${totpField(options.totp === true)}
<button type="submit" class="block">Create admin</button>
</form>`,
    {
      page: "first-run",
      wide: setup !== undefined && missingRequired(setup).length > 0,
    },
  );
}
