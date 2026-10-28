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
