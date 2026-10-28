/**
 * The login page (`GET /` without a session): one "token" field, or "login / password"
 * fields. The toggle between the two is done by `public/app.js`; without scripts the token
 * field is used. The form posts to `/login` as `application/x-www-form-urlencoded`.
 */

import { attr, errorMessage } from "./components";
import { markup } from "./html";
import { layout, type PageContext } from "./layout";

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
  const pw = options.mode === "password";
  return layout(
    ctx,
    "Log in",
    markup`<section class="card narrow">
<h1>Log in</h1>
${errorMessage(options.error)}
<form method="post" action="/login" class="login" data-login>
<fieldset class="toggle" data-login-toggle hidden>
<legend>Sign in with</legend>
<label><input type="radio" name="mode" value="token"${attr("checked", !pw)}> Token</label>
<label><input type="radio" name="mode" value="password"${attr("checked", pw)}> Login and password</label>
</fieldset>
<div data-login-mode="token"${attr("hidden", pw)}>
<label for="token">Token</label>
<input id="token" name="token" type="password" autocomplete="current-password" spellcheck="false"${attr("disabled", pw)}>
</div>
<div data-login-mode="password"${attr("hidden", !pw)}>
<label for="login">Login</label>
<input id="login" name="login" type="text" autocomplete="username" spellcheck="false" value="${options.login ?? ""}"${attr("disabled", !pw)}>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" spellcheck="false"${attr("disabled", !pw)}>
</div>
<button type="submit">Log in</button>
</form>
<p class="hint">A token looks like <code>project:secret</code>; its login and password are the two sides of the colon.</p>
</section>`,
  );
}
