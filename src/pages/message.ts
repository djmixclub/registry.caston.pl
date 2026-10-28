/** A page with a heading, one message and a link back home (errors, notices). */

import { markup } from "./html";
import { layout, type PageContext } from "./layout";

export function messagePage(ctx: PageContext, title: string, message: string): string {
  return layout(
    ctx,
    title,
    markup`<section class="card narrow">
<h1>${title}</h1>
<p>${message}</p>
<p><a href="/">Back to the home page</a></p>
</section>`,
  );
}
