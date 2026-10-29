/** How names are ordered in the panel's lists: packages and package groups. */

import type { PackageSummary } from "./packages";

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Printable ASCII only: the usual package name, which needs no Unicode-aware pattern. */
const ASCII = /^[ -~]*$/;

/**
 * The name as compared when sorting: lower case, only letters and digits (no `@`, `-`, `/`, `.`,
 * …). Names in ASCII, nearly all of them, take a plain pattern: a Unicode property pattern is
 * far slower to run in a cold isolate.
 */
export function sortKey(name: string): string {
  const lower = name.toLowerCase();
  return ASCII.test(lower) ? lower.replace(/[^a-z0-9]/g, "") : lower.replace(/[^\p{L}\p{N}]/gu, "");
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
  // Each key is made once, not on every comparison.
  const keyed = packages.map((item) => ({ item, key: sortKey(item.name) }));
  keyed.sort(
    (a, b) =>
      byteOrder(a.key, b.key) ||
      byteOrder(a.item.eco, b.item.eco) ||
      byteOrder(a.item.name, b.item.name),
  );
  return keyed.map(({ item }) => item);
}
