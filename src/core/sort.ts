/** How names are ordered in the panel's lists: packages and package groups. */

import type { PackageSummary } from "./packages";

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The name as compared when sorting: lower case, only letters and digits (no `@`, `-`, `/`, `.`, …). */
export function sortKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Compares two names, ignoring case and everything but letters and digits; names that differ
 * only in those respects by their original spelling in byte order.
 */
export function compareNames(a: string, b: string): number {
  return byteOrder(sortKey(a), sortKey(b)) || byteOrder(a, b);
}

/**
 * Sorted by name like {@link compareNames}; the same name in two ecosystems by ecosystem,
 * names that differ only in those respects in byte order.
 */
export function sortPackages<T extends PackageSummary>(packages: readonly T[]): T[] {
  return [...packages].sort(
    (a, b) =>
      byteOrder(sortKey(a.name), sortKey(b.name)) ||
      byteOrder(a.eco, b.eco) ||
      byteOrder(a.name, b.name),
  );
}
