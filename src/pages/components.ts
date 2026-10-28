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

/** The minimum length of a password chosen for an admin credential. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * The optional "password" and "repeat password" fields of an admin credential: when they are
 * left empty the registry generates the token's secret. `showWhen` (`kind:admin`, `type:key`)
 * names the radio choice of the form that shows them; `public/app.js` hides, clears and
 * disables them for any other choice, and checks that both match and are long enough.
 */
export function passwordFields(showWhen?: string, shown = true): SafeHtml {
  const rule = showWhen === undefined ? "" : markup`="${showWhen}"`;
  return markup`<div data-password${rule}${attr("hidden", !shown)}>
<label>Password (optional, at least ${MIN_PASSWORD_LENGTH} characters) <input type="password" name="password" minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password" spellcheck="false"${attr("disabled", !shown)}></label>
<label>Repeat password <input type="password" name="password_repeat" minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password" spellcheck="false"${attr("disabled", !shown)}></label>
<p class="hint">Leave both empty to have the registry generate the token. Either way the whole token is shown once.</p>
</div>`;
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/**
 * A byte count for people, in powers of 1024 with binary units: `512 B`, `1.5 KiB`,
 * `12 MiB` (one decimal below 10, none above). Every page shows sizes through this.
 */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${shown} ${UNITS[unit]}`;
}

/** An error message announced to assistive technology. */
export function errorMessage(message: string | undefined): SafeHtml {
  return message === undefined ? markup`` : markup`<p class="error" role="alert">${message}</p>`;
}

/** ` name` when `on` is true, for boolean attributes such as `checked` or `hidden`. */
export function attr(name: string, on: boolean): SafeHtml {
  return markup`${on ? ` ${name}` : ""}`;
}

/**
 * A URL or path with a line-break opportunity (`<wbr>`) after each `/` that does not start
 * another (`https://` stays whole), so long URLs wrap between segments, not inside words.
 */
export function breakAfterSlashes(text: string): SafeHtml {
  const parts = text.split(/(?<=\/)(?!\/|$)/);
  return markup`${parts.map((part, i) => (i === 0 ? part : markup`<wbr>${part}`))}`;
}
