/**
 * Dependency-free semantic versions and version ranges for the three ecosystems.
 *
 * Versions follow semver 2.0.0 (an optional leading `v`/`V` is accepted). Ranges are parsed in
 * the syntax of a dialect:
 *
 * - `npm`: node-semver ranges (space-separated comparators, `||`, `^`, `~`/`~>`, x-ranges,
 *   hyphen ranges, partial versions as x-ranges).
 * - `composer`: Composer constraints (`,` or space as AND, `||` or `|` as OR, `!=`/`<>`, `==`,
 *   `^`, `~` with Composer's "last given part may change" rule, wildcards, hyphen ranges,
 *   bare partial versions as exact versions, `@stability` flags ignored).
 * - `cargo`: cargo `VersionReq` (`,` as AND, no OR, bare versions as caret requirements).
 *
 * Prereleases follow the npm rule in every dialect: a prerelease version satisfies a set of
 * comparators only if one comparator in the set names the same `major.minor.patch` with a
 * prerelease. For Composer, prerelease identifiers are compared the way Composer does it:
 * case-insensitively, with a trailing number split off (`rc2` == `rc.2`, `rc2` < `rc10`).
 */

export type Dialect = "npm" | "composer" | "cargo";

export type PrereleaseId = string | number;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: PrereleaseId[];
  build: string[];
}

type Op = "<" | "<=" | ">" | ">=" | "=" | "!=";

interface Comparator {
  op: Op;
  version: SemVer;
}

/** A parsed range: alternatives (OR) of comparator sets (AND). */
export type Range = Comparator[][];

const NUM = "0|[1-9]\\d*";
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)";
const PRE = `${PRE_ID}(?:\\.${PRE_ID})*`;
const BUILD = "[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*";

const VERSION_RE = new RegExp(
  `^[vV]?(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE}))?(?:\\+(${BUILD}))?$`,
);
const PART = `${NUM}|[xX*]`;
const PARTIAL_RE = new RegExp(
  `^[vV]?(${PART})(?:\\.(${PART})(?:\\.(${PART})(?:-(${PRE}))?(?:\\+(${BUILD}))?)?)?$`,
);
const OP_RE = /^(<=|>=|<>|!=|==|~>|<|>|=|\^|~)?(.*)$/;
const OP_SPACE_RE = /(<=|>=|<>|!=|==|~>|<|>|=|\^|~)\s+/g;
const STABILITY_RE = /@(?:stable|rc|beta|alpha|dev)$/i;

class RangeSyntaxError extends Error {}

function toNumber(part: string): number {
  const n = Number(part);
  if (!Number.isSafeInteger(n)) throw new RangeSyntaxError("number too large");
  return n;
}

function parsePrerelease(pre: string | undefined): PrereleaseId[] {
  if (pre === undefined) return [];
  return pre.split(".").map((id) => (/^\d+$/.test(id) ? toNumber(id) : id));
}

/** Parses a full semver version, with an optional leading `v`; `null` when invalid. */
export function parseVersion(v: string): SemVer | null {
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  try {
    return {
      major: toNumber(m[1] ?? ""),
      minor: toNumber(m[2] ?? ""),
      patch: toNumber(m[3] ?? ""),
      prerelease: parsePrerelease(m[4]),
      build: m[5] === undefined ? [] : m[5].split("."),
    };
  } catch {
    return null;
  }
}

/** Whether `v` is a valid version with a prerelease part. */
export function isPrerelease(v: string): boolean {
  const parsed = parseVersion(v);
  return parsed !== null && parsed.prerelease.length > 0;
}

function compareIds(a: PrereleaseId, b: PrereleaseId): number {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function comparePrerelease(a: PrereleaseId[], b: PrereleaseId[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const c = compareIds(x, y);
    if (c !== 0) return c;
  }
  return 0;
}

function compareParsed(a: SemVer, b: SemVer): number {
  return (
    Math.sign(a.major - b.major) ||
    Math.sign(a.minor - b.minor) ||
    Math.sign(a.patch - b.patch) ||
    comparePrerelease(a.prerelease, b.prerelease)
  );
}

function toSemVer(v: string | SemVer): SemVer {
  if (typeof v !== "string") return v;
  const parsed = parseVersion(v);
  if (!parsed) throw new TypeError("Invalid version.");
  return parsed;
}

/**
 * Semver precedence of two versions: negative when `a < b`, `0` when equal (build metadata is
 * ignored), positive when `a > b`. Throws a `TypeError` on an invalid version string.
 */
export function compareVersions(a: string | SemVer, b: string | SemVer): number {
  return compareParsed(toSemVer(a), toSemVer(b));
}

/** Composer compares prerelease labels case-insensitively and splits `rc2` into `rc`, `2`. */
function composerPrerelease(pre: PrereleaseId[]): PrereleaseId[] {
  return pre.flatMap((id) => {
    if (typeof id === "number") return [id];
    const lower = id.toLowerCase();
    const m = /^([a-z]+)(\d+)$/.exec(lower);
    const n = Number(m?.[2]);
    return m && Number.isSafeInteger(n) ? [m[1] ?? "", n] : [lower];
  });
}

function normalise(v: SemVer, dialect: Dialect): SemVer {
  return dialect === "composer" ? { ...v, prerelease: composerPrerelease(v.prerelease) } : v;
}

interface Partial {
  major: number | null;
  minor: number | null;
  patch: number | null;
  prerelease: PrereleaseId[];
  /** An explicit `x`, `X` or `*` was written (as opposed to a part being left out). */
  wildcard: boolean;
}

function parsePartial(text: string, dialect: Dialect): Partial {
  const m = PARTIAL_RE.exec(text);
  if (!m) throw new RangeSyntaxError("invalid version");
  const parts = [m[1], m[2], m[3]];
  const values: (number | null)[] = [];
  let wildcard = false;
  for (const part of parts) {
    if (part === undefined || /^[xX*]$/.test(part)) {
      if (part !== undefined) wildcard = true;
      values.push(null);
    } else {
      if (values.includes(null)) throw new RangeSyntaxError("number after a wildcard");
      values.push(toNumber(part));
    }
  }
  const [major = null, minor = null, patch = null] = values;
  if (m[4] !== undefined && patch === null) throw new RangeSyntaxError("prerelease on partial");
  const prerelease = parsePrerelease(m[4]);
  return {
    major,
    minor,
    patch,
    prerelease: dialect === "composer" ? composerPrerelease(prerelease) : prerelease,
    wildcard,
  };
}

function ver(major: number, minor: number, patch: number, prerelease: PrereleaseId[] = []) {
  return { major, minor, patch, prerelease, build: [] };
}

/** The partial with missing parts set to 0 (keeps the prerelease of a full version). */
function floor(p: Partial): SemVer {
  return ver(p.major ?? 0, p.minor ?? 0, p.patch ?? 0, p.patch === null ? [] : p.prerelease);
}

/** The first version above every version an x-range over `p` covers (`p` must be partial). */
function ceiling(p: Partial): SemVer {
  if (p.major === null) throw new RangeSyntaxError("no ceiling");
  if (p.minor === null) return ver(p.major + 1, 0, 0);
  return ver(p.major, p.minor + 1, 0);
}

const isFull = (p: Partial): boolean => p.patch !== null;

/** Matches nothing: no version is lower than `0.0.0-0`. */
const NEVER: Comparator[] = [{ op: "<", version: ver(0, 0, 0, [0]) }];

function xRange(p: Partial): Comparator[] {
  if (p.major === null) return [];
  return [
    { op: ">=", version: floor(p) },
    { op: "<", version: ceiling(p) },
  ];
}

function caret(p: Partial): Comparator[] {
  if (p.major === null) return [];
  let upper: SemVer;
  if (p.major > 0) upper = ver(p.major + 1, 0, 0);
  else if (p.minor === null) upper = ver(1, 0, 0);
  else if (p.minor > 0) upper = ver(0, p.minor + 1, 0);
  else if (p.patch === null) upper = ver(0, 1, 0);
  else upper = ver(0, 0, p.patch + 1);
  return [
    { op: ">=", version: floor(p) },
    { op: "<", version: upper },
  ];
}

function tilde(p: Partial, dialect: Dialect): Comparator[] {
  if (p.major === null) return [];
  const majorOnly = p.minor === null || (dialect === "composer" && p.patch === null);
  const upper = majorOnly ? ver(p.major + 1, 0, 0) : ver(p.major, (p.minor ?? 0) + 1, 0);
  return [
    { op: ">=", version: floor(p) },
    { op: "<", version: upper },
  ];
}

const ALLOWED_OPS: Record<Dialect, readonly string[]> = {
  npm: ["", "=", "<", "<=", ">", ">=", "^", "~", "~>"],
  composer: ["", "=", "==", "!=", "<>", "<", "<=", ">", ">=", "^", "~"],
  cargo: ["", "=", "<", "<=", ">", ">=", "^", "~"],
};

function comparators(token: string, dialect: Dialect): Comparator[] {
  const m = OP_RE.exec(token);
  const op = m?.[1] ?? "";
  if (!ALLOWED_OPS[dialect].includes(op)) throw new RangeSyntaxError("unsupported operator");
  const p = parsePartial(m?.[2] ?? "", dialect);
  // Composer reads a left-out part as 0 (`1.2` is `1.2.0`); an explicit wildcard is a range.
  const exactPartial = dialect === "composer" && !p.wildcard;

  if (p.major === null) {
    if (op === ">" || op === "<") return NEVER;
    if (op === "!=" || op === "<>") throw new RangeSyntaxError("wildcard with !=");
    return [];
  }
  switch (op) {
    case "!=":
    case "<>":
      if (p.wildcard) throw new RangeSyntaxError("wildcard with !=");
      return [{ op: "!=", version: floor(p) }];
    case "":
    case "=":
    case "==":
      if (dialect === "cargo" && op === "" && !p.wildcard) return caret(p);
      if (isFull(p) || exactPartial) return [{ op: "=", version: floor(p) }];
      return xRange(p);
    case ">":
      if (isFull(p) || exactPartial) return [{ op: ">", version: floor(p) }];
      return [{ op: ">=", version: ceiling(p) }];
    case ">=":
      return [{ op: ">=", version: floor(p) }];
    case "<":
      return [{ op: "<", version: floor(p) }];
    case "<=":
      if (isFull(p) || exactPartial) return [{ op: "<=", version: floor(p) }];
      return [{ op: "<", version: ceiling(p) }];
    case "^":
      return caret(p);
    default:
      return tilde(p, dialect);
  }
}

function hyphen(from: string, to: string, dialect: Dialect): Comparator[] {
  const low = parsePartial(from, dialect);
  const high = parsePartial(to, dialect);
  const result: Comparator[] = [];
  if (low.major !== null) result.push({ op: ">=", version: floor(low) });
  if (high.major !== null) {
    result.push(
      isFull(high) ? { op: "<=", version: floor(high) } : { op: "<", version: ceiling(high) },
    );
  }
  return result;
}

function parseSet(text: string, dialect: Dialect): Comparator[] {
  const compact = text.trim().replace(OP_SPACE_RE, "$1");
  if (compact === "") throw new RangeSyntaxError("empty alternative");
  let tokens: string[];
  if (dialect === "cargo") {
    tokens = compact.split(",").map((t) => t.trim());
    if (tokens.some((t) => t === "" || /\s/.test(t))) throw new RangeSyntaxError("bad list");
  } else {
    tokens = compact.split(dialect === "composer" ? /[\s,]+/ : /\s+/).filter((t) => t !== "");
    if (dialect === "composer") tokens = tokens.map((t) => t.replace(STABILITY_RE, ""));
  }
  const result: Comparator[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (dialect !== "cargo" && tokens[i + 1] === "-") {
      const to = tokens[i + 2];
      if (to === undefined) throw new RangeSyntaxError("incomplete hyphen range");
      result.push(...hyphen(token, to, dialect));
      i += 2;
    } else if (token === "-") {
      throw new RangeSyntaxError("stray hyphen");
    } else if (token !== "") {
      result.push(...comparators(token, dialect));
    }
  }
  return result;
}

/** Parses a range in a dialect's syntax; `null` when it does not parse. */
export function parseRange(range: string, dialect: Dialect): Range | null {
  let text = range.trim();
  if (dialect === "composer" && STABILITY_RE.test(text) && text.startsWith("@")) text = "";
  if (text === "") return [[]];
  if (dialect === "cargo" && text.includes("|")) return null;
  try {
    const alternatives = text.split(dialect === "composer" ? /\|\|?/ : "||");
    return alternatives.map((alt) => parseSet(alt, dialect));
  } catch (err) {
    if (err instanceof RangeSyntaxError) return null;
    throw err;
  }
}

/** Whether a range parses in the dialect's syntax. */
export function isValidRange(range: string, dialect: Dialect): boolean {
  return parseRange(range, dialect) !== null;
}

function test(c: Comparator, v: SemVer): boolean {
  const cmp = compareParsed(v, c.version);
  switch (c.op) {
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "=":
      return cmp === 0;
    case "!=":
      return cmp !== 0;
  }
}

function testSet(set: Comparator[], v: SemVer): boolean {
  if (!set.every((c) => test(c, v))) return false;
  if (v.prerelease.length === 0) return true;
  return set.some(
    (c) =>
      c.version.prerelease.length > 0 &&
      c.version.major === v.major &&
      c.version.minor === v.minor &&
      c.version.patch === v.patch,
  );
}

/** Whether a version satisfies a parsed range in a dialect. */
export function satisfiesRange(version: string, range: Range, dialect: Dialect): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const v = normalise(parsed, dialect);
  return range.some((set) => testSet(set, v));
}

/**
 * Whether `version` satisfies `range` in the dialect's syntax. An invalid version or an
 * unparsable range never satisfies.
 */
export function satisfies(version: string, range: string, dialect: Dialect): boolean {
  const parsed = parseRange(range, dialect);
  return parsed !== null && satisfiesRange(version, parsed, dialect);
}
