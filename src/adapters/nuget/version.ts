/**
 * NuGet versions and version ranges (docs/api.md 5.1 and 5.2), dependency-free.
 *
 * Versions have 1 to 4 numeric parts, an optional SemVer 2.0.0 prerelease and optional build
 * metadata, which is ignored. The normalised form is lower case, without leading zeros, with at
 * least three parts and without a fourth part of `0` (`01.2.3.0-Beta+abc` → `1.2.3-beta`).
 *
 * Versions are compared the way NuGet does it: the four numeric parts (missing parts are `0`),
 * then a stable version above any prerelease, then the prerelease identifiers one by one
 * (numeric identifiers numerically and below alphanumeric ones, alphanumeric identifiers
 * case-insensitively; with equal identifiers the longer list is higher).
 *
 * Ranges use NuGet's syntax:
 *
 * - `1.0` – `>= 1.0`; `[1.0]` – exactly `1.0`; `[1.0,2.0)`, `(1.0,)`, `(,1.0]` – intervals
 *   with inclusive `[` `]` and exclusive `(` `)` bounds (blanks around the bounds are allowed).
 *   As in NuGet, an interval admits every version within its bounds, prereleases included.
 * - Floating ranges match a prefix: `*` every stable version, `1.*` the stable versions with
 *   major `1`, `1.2.*` those with `1.2`, `1.2.3.*` those with `1.2.3`; a `-*` suffix
 *   (`*-*`, `1.*-*`) admits prereleases too. `1.2.3-*` (or `1.2.3-beta*`) admits the stable
 *   `1.2.3` and its prereleases (whose label starts with `beta`).
 * - An empty range admits every version, as a `.nuspec` dependency without a version does.
 */

/** A parsed NuGet version. */
export interface NuGetVersion {
  /** The four numeric parts; missing parts are `0`. */
  parts: [number, number, number, number];
  /** The prerelease identifiers as written; empty for a stable version. */
  prerelease: string[];
}

/** NuGet stores each numeric part as a 32-bit signed integer. */
const MAX_PART = 2147483647;

const IDS = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const VERSION_RE = new RegExp(
  `^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-(${IDS}))?(?:\\+(${IDS}))?$`,
);

function toPart(text: string | undefined): number | null {
  if (text === undefined) return 0;
  const n = Number(text);
  return Number.isSafeInteger(n) && n <= MAX_PART ? n : null;
}

/** Parses a NuGet version; `null` when invalid. */
export function parseNuGetVersion(version: string): NuGetVersion | null {
  const m = VERSION_RE.exec(version);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map(toPart);
  if (parts.some((p) => p === null)) return null;
  const prerelease = m[5] === undefined ? [] : m[5].split(".");
  // SemVer 2.0.0: numeric prerelease identifiers have no leading zeros.
  if (prerelease.some((id) => /^0\d+$/.test(id))) return null;
  return { parts: parts as NuGetVersion["parts"], prerelease };
}

/** Whether a string is a valid NuGet version (as sent or normalised). */
export function isValidNuGetVersion(version: string): boolean {
  return parseNuGetVersion(version) !== null;
}

/** Whether a valid NuGet version has a prerelease label. */
export function isNuGetPrerelease(version: string): boolean {
  return (parseNuGetVersion(version)?.prerelease.length ?? 0) > 0;
}

function format(v: NuGetVersion): string {
  const [major, minor, patch, revision] = v.parts;
  const base = `${major}.${minor}.${patch}${revision === 0 ? "" : `.${revision}`}`;
  return v.prerelease.length === 0 ? base : `${base}-${v.prerelease.join(".").toLowerCase()}`;
}

/** The NuGet normalised form of a version; throws a `TypeError` when it is invalid. */
export function normalizeNuGetVersion(version: string): string {
  const v = parseNuGetVersion(version);
  if (v === null) throw new TypeError("Invalid version.");
  return format(v);
}

function compareIds(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Math.sign(Number(a) - Number(b));
  if (na !== nb) return na ? -1 : 1;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y ? 0 : x < y ? -1 : 1;
}

function compareParsed(a: NuGetVersion, b: NuGetVersion): number {
  for (let i = 0; i < 4; i++) {
    const d = Math.sign((a.parts[i] ?? 0) - (b.parts[i] ?? 0));
    if (d !== 0) return d;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const n = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i++) {
    const d = compareIds(a.prerelease[i] ?? "", b.prerelease[i] ?? "");
    if (d !== 0) return d;
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

function parseOrThrow(version: string): NuGetVersion {
  const v = parseNuGetVersion(version);
  if (v === null) throw new TypeError("Invalid version.");
  return v;
}

/**
 * NuGet precedence of two valid versions: negative when `a < b`, `0` when equal (`1.2` and
 * `1.2.0.0` are equal, build metadata is ignored), positive when `a > b`.
 */
export function compareNuGetVersions(a: string, b: string): number {
  return compareParsed(parseOrThrow(a), parseOrThrow(b));
}

// ---------------------------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------------------------

interface Bound {
  version: NuGetVersion;
  inclusive: boolean;
}

/** A parsed NuGet version range. */
export type NuGetRange =
  | { kind: "all" }
  | { kind: "interval"; min: Bound | null; max: Bound | null }
  /** `*`, `1.*`, `1.2.*`, `1.2.3.*`, optionally with `-*`. */
  | { kind: "float"; prefix: number[]; prerelease: boolean }
  /** `1.2.3-*`, `1.2.3-beta*`. */
  | { kind: "prereleaseFloat"; release: NuGetVersion; label: string };

const NUMERIC_FLOAT_RE = /^(?:((?:\d+\.){1,3})\*|\*)(-\*)?$/;
const PRERELEASE_FLOAT_RE = /^(\d+(?:\.\d+){0,3})-([0-9A-Za-z.-]*)\*$/;

function parseBound(text: string, inclusive: boolean): Bound | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  const version = parseNuGetVersion(t);
  return version === null ? undefined : { version, inclusive };
}

function parseInterval(range: string): NuGetRange | null {
  const open = range[0];
  const close = range[range.length - 1];
  if ((close !== "]" && close !== ")") || range.length < 3) return null;
  const minInclusive = open === "[";
  const maxInclusive = close === "]";
  const inner = range.slice(1, -1);
  const pieces = inner.split(",");
  if (pieces.length === 1) {
    // Only `[1.0]` (exactly one version) is valid without a comma.
    const exact = parseBound(inner, true);
    if (!minInclusive || !maxInclusive || !exact) return null;
    return { kind: "interval", min: exact, max: exact };
  }
  if (pieces.length !== 2) return null;
  const min = parseBound(pieces[0] ?? "", minInclusive);
  const max = parseBound(pieces[1] ?? "", maxInclusive);
  if (min === undefined || max === undefined || (min === null && max === null)) return null;
  if (min !== null && max !== null) {
    const c = compareParsed(min.version, max.version);
    if (c > 0 || (c === 0 && !(min.inclusive && max.inclusive))) return null;
  }
  return { kind: "interval", min, max };
}

function parseFloating(range: string): NuGetRange | null {
  const numeric = NUMERIC_FLOAT_RE.exec(range);
  if (numeric) {
    const prefix = (numeric[1] ?? "")
      .split(".")
      .filter((p) => p !== "")
      .map(toPart);
    if (prefix.some((p) => p === null)) return null;
    return { kind: "float", prefix: prefix as number[], prerelease: numeric[2] !== undefined };
  }
  const pre = PRERELEASE_FLOAT_RE.exec(range);
  if (pre) {
    const release = parseNuGetVersion(pre[1] ?? "");
    const label = pre[2] ?? "";
    if (release === null || label.startsWith(".") || label.includes("..")) return null;
    return { kind: "prereleaseFloat", release, label: label.toLowerCase() };
  }
  return null;
}

/** Parses a NuGet version range; `null` when invalid. */
export function parseNuGetRange(range: string): NuGetRange | null {
  const t = range.trim();
  if (t === "") return { kind: "all" };
  if (t.startsWith("[") || t.startsWith("(")) return parseInterval(t);
  if (t.includes("*")) return parseFloating(t);
  const version = parseNuGetVersion(t);
  return version === null
    ? null
    : { kind: "interval", min: { version, inclusive: true }, max: null };
}

/** Whether a range parses in NuGet's syntax. */
export function isValidNuGetRange(range: string): boolean {
  return parseNuGetRange(range) !== null;
}

function inRange(v: NuGetVersion, range: NuGetRange): boolean {
  switch (range.kind) {
    case "all":
      return true;
    case "interval": {
      const { min, max } = range;
      if (min !== null) {
        const c = compareParsed(v, min.version);
        if (c < 0 || (c === 0 && !min.inclusive)) return false;
      }
      if (max !== null) {
        const c = compareParsed(v, max.version);
        if (c > 0 || (c === 0 && !max.inclusive)) return false;
      }
      return true;
    }
    case "float":
      if (v.prerelease.length > 0 && !range.prerelease) return false;
      return range.prefix.every((part, i) => v.parts[i] === part);
    case "prereleaseFloat":
      if (!v.parts.every((part, i) => part === range.release.parts[i])) return false;
      return (
        v.prerelease.length === 0 || v.prerelease.join(".").toLowerCase().startsWith(range.label)
      );
  }
}

/** Whether a version satisfies a NuGet range; `false` when either does not parse. */
export function satisfiesNuGetRange(version: string, range: string): boolean {
  const v = parseNuGetVersion(version);
  const r = parseNuGetRange(range);
  return v !== null && r !== null && inRange(v, r);
}
