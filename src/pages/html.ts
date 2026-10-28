/**
 * HTML building blocks for the server-rendered pages. Every interpolated value goes through
 * {@link escapeHtml}: the {@link markup} tag escapes everything that is not already
 * {@link SafeHtml}, so markup can only come from the templates themselves.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for use in HTML element content and in quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** A fragment of markup that is already safe to insert as is. */
export class SafeHtml {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

/** What a template may interpolate; `null`, `undefined` and `false` render nothing. */
export type HtmlValue = SafeHtml | string | number | boolean | null | undefined | HtmlValue[];

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(String(value));
}

/**
 * Tagged template that escapes every interpolated value (arrays are concatenated). It is not
 * called `html` so that Prettier leaves the templates as written.
 */
export function markup(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? "");
  }
  return new SafeHtml(out);
}
