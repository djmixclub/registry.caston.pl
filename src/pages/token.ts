/**
 * The one-time token page: a new token (a first admin, a new credential, a new `key` secret)
 * is shown once, on the response to the form that created it, in the centred card with a
 * "Copy" button and a link to go on. Nothing stores the token for a later page.
 */

import { copyBlock } from "./components";
import { markup, type SafeHtml } from "./html";
import { centredLayout, type PageContext } from "./layout";

/** What the token page shows. */
export interface TokenPageData {
  /** The page title and heading ("Credential created"). */
  title: string;
  /** What was created and how to use the token. */
  text: SafeHtml;
  token: string;
  /** Where to go on, e.g. the credential's page. */
  next: { href: string; label: string };
}

/** The token page. */
export function tokenPage(ctx: PageContext, data: TokenPageData): string {
  return centredLayout(
    ctx,
    data.title,
    markup`<h1>${data.title}</h1>
<p class="sub">${data.text}</p>
<p class="once">The token is shown <strong>only once</strong>. Copy it now and store it in a password manager or a CI secret.</p>
${copyBlock(data.token)}
<a class="button block" href="${data.next.href}">${data.next.label}</a>`,
    { page: "token" },
  );
}

/** What the one-time login page shows. */
export interface LoginPageData {
  /** The credential's project: the login. */
  project: string;
  password: string;
  /** The one-time code enrolment, when the secret has TOTP. */
  totp?: { secret: string; otpauthUri: string };
  next: { href: string; label: string };
}

/**
 * The one-time page of a new `login` secret: the login and password, and the shared secret of
 * the one-time codes as a link authenticator apps open. Nothing stores them for a later page.
 */
export function loginSecretPage(ctx: PageContext, data: LoginPageData): string {
  const totp =
    data.totp === undefined
      ? ""
      : markup`<p class="once">Add the one-time code to an authenticator app with this link, or enter the key by hand. Without it nobody can sign in with this login.</p>
${copyBlock(data.totp.otpauthUri, "Authenticator link")}
${copyBlock(data.totp.secret, "Key")}`;
  return centredLayout(
    ctx,
    "Login created",
    markup`<h1>Login created</h1>
<p class="sub">Sign in as <strong>${data.project}</strong> with <code>sreg login</code> or the approval page the command opens.</p>
<p class="once">The password is shown <strong>only once</strong>. Copy it now and store it in a password manager.</p>
${copyBlock(data.password, "Password")}
${totp}
<a class="button block" href="${data.next.href}">${data.next.label}</a>`,
    { page: "token" },
  );
}
