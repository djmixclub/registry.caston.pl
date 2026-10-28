/**
 * The view of a `publish` credential: it can only publish (with the `sreg` CLI, usually from
 * CI) and sees nothing else in the panel.
 */

import { markup } from "./html";
import { layout, type PageContext } from "./layout";

export function publishPage(ctx: PageContext): string {
  return layout(
    ctx,
    "Publish credential",
    markup`<section class="card narrow">
<h1>Publish credential</h1>
<p>This credential can only publish. Use it with the <code>sreg</code> command-line tool,
usually from CI; it cannot list or install packages.</p>
</section>`,
  );
}
