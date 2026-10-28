/**
 * The login page (`GET /` without a session), in the centred card: a pill switch between one
 * "token" field and "login / password" fields, and the "Sign in" button; a failed login shows
 * its error above the switch. The switch is two radios (`mode`) styled by CSS; `public/app.js`
 * shows only the chosen fields and disables the others, and without scripts both sets stay
 * visible (the server reads the fields of the chosen mode). The form posts to `/login` as
 * `application/x-www-form-urlencoded`.
 */

import { errorMessage, revealable, segmented } from "./components";
import { markup } from "./html";
import { centredLayout, type PageContext } from "./layout";

/** How the user signs in: the whole token, or its two halves. */
export type LoginMode = "token" | "password";

export interface LoginOptions {
  /** Shown after a failed login. */
  error?: string;
  /** The mode selected when the page is shown; default `token`. */
  mode?: LoginMode;
  /** The login to prefill in password mode (never the token or password). */
  login?: string;
}

/** The login page. */
export function loginPage(ctx: PageContext, options: LoginOptions = {}): string {
  const mode = options.mode ?? "token";
  const modes = [
    { value: "token", label: "Token" },
    { value: "password", label: "Login & password" },
  ];
  return centredLayout(
    ctx,
    "Sign in",
    markup`<h1>Sign in</h1>
<p class="sub">Use a credential issued by an administrator.</p>
${errorMessage(options.error)}
<form method="post" action="/login" class="login" data-login>
${segmented("mode", "Sign in with", modes, mode)}
<div class="pane" data-login-mode="token">
<label for="token">Token</label>
${revealable(markup`<input id="token" name="token" type="password" class="mono" autocomplete="current-password" spellcheck="false" placeholder="project:secret">`, "token")}
</div>
<div class="pane" data-login-mode="password">
<label for="login">Login</label>
<input id="login" name="login" type="text" autocomplete="username" spellcheck="false" placeholder="project" value="${options.login ?? ""}">
<label for="password">Password</label>
${revealable(markup`<input id="password" name="password" type="password" autocomplete="current-password" spellcheck="false">`, "password")}
</div>
<button type="submit" class="block">Sign in</button>
</form>`,
    { page: "login" },
  );
}
