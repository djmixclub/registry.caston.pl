/** Small pieces of markup shared by several pages. */

import { markup, type SafeHtml } from "./html";

/**
 * A block of text with a "Copy" button (wired up by `public/app.js`). The button sits in a
 * header row above the text, next to the label, so it never covers the text.
 */
export function copyBlock(text: string, label?: string): SafeHtml {
  const title = label === undefined ? "" : markup`<div class="copyable-label">${label}</div>`;
  return markup`<div class="copyable">
<div class="copyable-head">
${title}
<button type="button" class="copy" data-copy>Copy</button>
</div>
<pre><code>${text}</code></pre>
</div>`;
}

/** An error message announced to assistive technology. */
export function errorMessage(message: string | undefined): SafeHtml {
  return message === undefined ? markup`` : markup`<p class="error" role="alert">${message}</p>`;
}

/** ` name` when `on` is true, for boolean attributes such as `checked` or `hidden`. */
export function attr(name: string, on: boolean): SafeHtml {
  return markup`${on ? ` ${name}` : ""}`;
}
