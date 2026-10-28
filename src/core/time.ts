/** Timestamps as the API writes and accepts them (docs/api.md 1.2). */

/** RFC 3339 in UTC with second precision and a `Z` suffix, e.g. `2026-10-28T10:12:00Z`. */
export function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * Parses a request timestamp: RFC 3339 with a time zone, or a date-only `YYYY-MM-DD` meaning
 * `00:00:00Z` of that day. Returns `null` when invalid.
 */
export function parseTimestamp(value: string): Date | null {
  if (DATE_RE.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) || rfc3339(date).slice(0, 10) !== value ? null : date;
  }
  if (!DATE_TIME_RE.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
