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
 * group for assistive technology, `checked` is the selected value. Several controls on a
 * page need distinct `idPrefix`es (the radios' ids); `required` makes a choice mandatory.
 */
export function segmented(
  name: string,
  label: string,
  segments: readonly Segment[],
  checked: string,
  options: { required?: boolean; idPrefix?: string } = {},
): SafeHtml {
  const prefix = options.idPrefix ?? name;
  const required = options.required === true;
  const items = segments.map(
    (s) =>
      markup`<input type="radio" name="${name}" id="${prefix}-${s.value}" value="${s.value}"${attr("checked", s.value === checked)}${attr("required", required)}><label for="${prefix}-${s.value}">${s.label}</label>`,
  );
  return markup`<div class="seg" role="radiogroup" aria-label="${label}">
${items}
</div>`;
}

/** One switch of a {@link toggles} group: the value posted when it is on, its name and a hint. */
export interface Toggle {
  value: string;
  label: string;
  hint?: string;
}

/**
 * A group of on/off switches (checkboxes drawn as switches, CSS only) that post `name` once for
 * every one that is on: `checked` lists the values switched on. `idPrefix` keeps the ids of
 * several groups on one page apart. At least one has to be on where a group is mandatory; the
 * server says so, and `app.js` stops the browser from submitting an empty group (`data-toggles`).
 */
export function toggles(
  name: string,
  label: string,
  items: readonly Toggle[],
  checked: readonly string[],
  options: { idPrefix?: string } = {},
): SafeHtml {
  const prefix = options.idPrefix ?? name;
  const rows = items.map((t) => {
    const hint = t.hint === undefined ? "" : markup`<small>${t.hint}</small>`;
    return markup`<div class="toggle" data-toggle="${t.value}"><input type="checkbox" name="${name}" id="${prefix}-${t.value}" value="${t.value}"${attr("checked", checked.includes(t.value))}><label for="${prefix}-${t.value}"><span class="track" aria-hidden="true"></span><span class="toggle-text"><strong>${t.label}</strong>${hint}</span></label></div>`;
  });
  return markup`<div class="toggles" role="group" aria-label="${label}" data-toggles>
${rows}
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
