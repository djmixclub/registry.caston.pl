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

/** The minimum length of a password chosen for a `login` secret. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * The optional "password" and "repeat password" fields of a `login` secret: when they are left
 * empty the registry generates the password. `showWhen` (`type:login`, `first_secret:login`)
 * names the radio choice of the form that shows them; `public/app.js` hides, clears and
 * disables them for any other choice, and checks that both match and are long enough.
 */
export function passwordFields(showWhen?: string, shown = true): SafeHtml {
  const rule = showWhen === undefined ? "" : markup`="${showWhen}"`;
  return markup`<div data-password${rule}${attr("hidden", !shown)}>
<label>Password (optional, at least ${MIN_PASSWORD_LENGTH} characters) <input type="password" name="password" minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password" spellcheck="false"${attr("disabled", !shown)}></label>
<label>Repeat password <input type="password" name="password_repeat" minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password" spellcheck="false"${attr("disabled", !shown)}></label>
<p class="hint">Leave both empty to have the registry generate the password. Either way it is shown once.</p>
</div>`;
}

/** The "require a one-time code" checkbox of a `login` secret. */
export function totpField(checked: boolean): SafeHtml {
  return markup`<label class="inline"><input type="checkbox" name="totp"${attr("checked", checked)}> Require a one-time code (TOTP) besides the password</label>
<p class="hint">The shared secret is shown once, with the password, as a QR code and a link for an authenticator app.</p>`;
}

/** The optional description field of a secret (at most 200 characters). */
export function descriptionField(value: string): SafeHtml {
  return markup`<label for="description">Description (optional)</label>
<input type="text" id="description" name="description" maxlength="200" autocomplete="off" placeholder="e.g. Jane's laptop, release workflow" value="${value}">`;
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

/** One choice of a {@link segmented} control. */
export interface Segment {
  value: string;
  label: string;
}

/**
 * Radios drawn as a pill switch (CSS only): `name` is the radios' name, `label` names the
 * group for assistive technology, `checked` is the selected value.
 */
export function segmented(
  name: string,
  label: string,
  segments: readonly Segment[],
  checked: string,
): SafeHtml {
  const items = segments.map(
    (s) =>
      markup`<input type="radio" name="${name}" id="${name}-${s.value}" value="${s.value}"${attr("checked", s.value === checked)}><label for="${name}-${s.value}">${s.label}</label>`,
  );
  return markup`<div class="seg" role="radiogroup" aria-label="${label}">
${items}
</div>`;
}

const EYE_ICON = markup`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`;

/**
 * An input with a "show" button inside its right edge that switches it between `password`
 * and `text` (`public/app.js`; the button stays hidden without scripts). `input` is the
 * `<input>` element; `what` names the value for the button's label ("token", "password").
 */
export function revealable(input: SafeHtml, what: string): SafeHtml {
  return markup`<div class="field-wrap">${input}<button type="button" class="reveal" data-reveal aria-label="Show ${what}" aria-pressed="false" hidden>${EYE_ICON}</button></div>`;
}
