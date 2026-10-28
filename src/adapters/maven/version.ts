/**
 * Maven versions and version ranges (docs/api.md 5.1 and 5.2), dependency-free.
 *
 * Versions are ordered like Maven's `ComparableVersion` (Maven 3.9): the lower-cased version is
 * split into items at `.` and `-` and at every transition between digits and letters; numbers
 * compare numerically, qualifiers in the order `alpha` (`a1`) < `beta` (`b1`) < `milestone`
 * (`m1`) < `rc` = `cr` < `snapshot` < the release (`""` = `ga` = `final` = `release`) < `sp`,
 * and unknown qualifiers come after `sp`, alphabetically. A `-` (or a digit-to-letter
 * transition) opens a sub-list; trailing "null" items (`0`, the release qualifier, empty
 * lists) are trimmed, so `1` = `1.0` = `1.0.0` = `1-ga`. A qualifier followed by a number
 * (`rc1`, `alpha-2`) forms one combination item.
 *
 * Ranges use Maven's syntax: `[1.0,2.0)`, `(,1.0]`, `[1.0]`, `(1.0,)`, unions of those
 * separated by `,` (`[1.0,2.0),[3.0,)`), and a plain version, which this registry reads as a
 * minimum (`1.0` = `>=1.0`, docs/api.md 5.1) for grants.
 */

/** One item of a parsed version. */
type Item =
  | { kind: "int"; value: bigint }
  | { kind: "string"; value: string }
  | { kind: "combination"; text: StringItem; number: IntItem }
  | { kind: "list"; items: Item[] };

type IntItem = Extract<Item, { kind: "int" }>;
type StringItem = Extract<Item, { kind: "string" }>;
type ListItem = Extract<Item, { kind: "list" }>;

/** Known qualifiers in ascending order; `""` is the release. */
const QUALIFIERS = ["alpha", "beta", "milestone", "rc", "snapshot", "", "sp"];
const RELEASE_INDEX = String(QUALIFIERS.indexOf(""));
const ALIASES: Readonly<Record<string, string>> = { ga: "", final: "", release: "", cr: "rc" };

/** Versions as the registry accepts them (docs/api.md 5.2). */
const VERSION_CHARS_RE = /^[A-Za-z0-9._+-]{1,128}$/;
const SNAPSHOT_RE = /-snapshot$/i;

function intItem(digits: string): IntItem {
  return { kind: "int", value: BigInt(digits === "" ? "0" : digits) };
}

function stringItem(value: string, followedByDigit: boolean): StringItem {
  let text = value;
  if (followedByDigit && text.length === 1) {
    text = { a: "alpha", b: "beta", m: "milestone" }[text] ?? text;
  }
  return { kind: "string", value: ALIASES[text] ?? text };
}

function parseItem(isCombination: boolean, isDigit: boolean, text: string): Item {
  if (isCombination) {
    const value = text.replaceAll("-", "");
    const at = value.search(/\d/);
    const index = at === -1 ? 0 : at;
    return {
      kind: "combination",
      text: stringItem(value.slice(0, index), true),
      number: intItem(value.slice(index)),
    };
  }
  return isDigit ? intItem(text) : stringItem(text, false);
}

/** `ComparableVersion` of the `comparableQualifier`: the index, or after every known one. */
function comparableQualifier(value: string): string {
  const i = QUALIFIERS.indexOf(value);
  return i === -1 ? `${QUALIFIERS.length}-${value}` : String(i);
}

function isNullItem(item: Item): boolean {
  switch (item.kind) {
    case "int":
      return item.value === 0n;
    case "string":
      return comparableQualifier(item.value) === RELEASE_INDEX;
    case "list":
      return item.items.length === 0;
    case "combination":
      return false;
  }
}

/** Trims null items that end a list or precede a qualifier (Maven 3.9 `normalize`). */
function normalize(list: ListItem): void {
  const items = list.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item === undefined || !isNullItem(item)) continue;
    const next = items[i + 1];
    if (next === undefined || next.kind === "string") {
      items.splice(i, 1);
    } else if (next.kind === "list") {
      const first = next.items[0];
      if (first !== undefined && (first.kind === "combination" || first.kind === "string")) {
        items.splice(i, 1);
      }
    }
  }
}

const isDigitChar = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/** Parses a version into `ComparableVersion` items (any string parses). */
function parse(version: string): ListItem {
  const text = version.toLowerCase();
  const root: ListItem = { kind: "list", items: [] };
  let list = root;
  const stack: ListItem[] = [root];
  const push = () => {
    const next: ListItem = { kind: "list", items: [] };
    list.items.push(next);
    list = next;
    stack.push(next);
  };
  let isDigit = false;
  let isCombination = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === ".") {
      list.items.push(
        i === start ? intItem("0") : parseItem(isCombination, isDigit, text.slice(start, i)),
      );
      isCombination = false;
      start = i + 1;
    } else if (c === "-") {
      if (i === start) {
        list.items.push(intItem("0"));
      } else {
        // `X-1` is read as `X1`.
        if (!isDigit && i !== text.length - 1 && isDigitChar(text[i + 1])) {
          isCombination = true;
          continue;
        }
        list.items.push(parseItem(isCombination, isDigit, text.slice(start, i)));
      }
      start = i + 1;
      push();
      isCombination = false;
    } else if (isDigitChar(c)) {
      if (!isDigit && i > start) {
        // `X1`
        isCombination = true;
        if (list.items.length > 0) push();
      }
      isDigit = true;
    } else {
      if (isDigit && i > start) {
        list.items.push(parseItem(isCombination, true, text.slice(start, i)));
        start = i;
        push();
        isCombination = false;
      }
      isDigit = false;
    }
  }
  if (text.length > start) {
    // `1.0.0.X1` < `1.0.0-X2`: `.X` is read as `-X` for any qualifier `X`.
    if (!isDigit && list.items.length > 0) push();
    list.items.push(parseItem(isCombination, isDigit, text.slice(start)));
  }
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) normalize(next);
  return root;
}

function compareStrings(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** `left.compareTo(right)` of `ComparableVersion`'s items; `right` may be `null`. */
function compareItems(left: Item, right: Item | null): number {
  switch (left.kind) {
    case "int":
      if (right === null) return left.value === 0n ? 0 : 1;
      if (right.kind !== "int") return 1;
      return left.value === right.value ? 0 : left.value < right.value ? -1 : 1;
    case "string": {
      const q = comparableQualifier(left.value);
      if (right === null) return compareStrings(q, RELEASE_INDEX);
      switch (right.kind) {
        case "string":
          return compareStrings(q, comparableQualifier(right.value));
        case "combination": {
          const result = compareItems(left, right.text);
          return result === 0 ? -1 : result;
        }
        default:
          return -1;
      }
    }
    case "combination":
      if (right === null) return compareItems(left.text, null);
      switch (right.kind) {
        case "string": {
          const result = compareItems(left.text, right);
          return result === 0 ? 1 : result;
        }
        case "combination": {
          const result = compareItems(left.text, right.text);
          return result === 0 ? compareItems(left.number, right.number) : result;
        }
        default:
          return -1;
      }
    case "list": {
      if (right === null) {
        const first = left.items[0];
        return first === undefined ? 0 : compareItems(first, null);
      }
      if (right.kind === "int") return -1;
      if (right.kind !== "list") return 1;
      const n = Math.max(left.items.length, right.items.length);
      for (let i = 0; i < n; i++) {
        const l = left.items[i] ?? null;
        const r = right.items[i] ?? null;
        const result = l === null ? (r === null ? 0 : -compareItems(r, null)) : compareItems(l, r);
        if (result !== 0) return result;
      }
      return 0;
    }
  }
}

/**
 * `ComparableVersion` order of two versions: negative when `a < b`, `0` when equal (`1.0` and
 * `1.0.0` are equal), positive when `a > b`. Every string is a version to Maven.
 */
export function compareMavenVersions(a: string, b: string): number {
  return Math.sign(compareItems(parse(a), parse(b)));
}

/** Whether a version is accepted for publishing: `[A-Za-z0-9._+-]{1,128}`, no `-SNAPSHOT`. */
export function isValidMavenVersion(version: string): boolean {
  return VERSION_CHARS_RE.test(version) && !SNAPSHOT_RE.test(version);
}

function hasPrereleaseQualifier(item: Item): boolean {
  switch (item.kind) {
    case "int":
      return false;
    case "string":
      return comparableQualifier(item.value) < RELEASE_INDEX;
    case "combination":
      return hasPrereleaseQualifier(item.text);
    case "list":
      return item.items.some(hasPrereleaseQualifier);
  }
}

/**
 * Whether a version carries a qualifier ordered before the release (`alpha`, `beta`,
 * `milestone`, `rc`/`cr`, `snapshot`), e.g. `1.0-rc1`, `2.0.0-M3`, `1.0-beta-2`.
 */
export function isMavenPrerelease(version: string): boolean {
  return hasPrereleaseQualifier(parse(version));
}

// ---------------------------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------------------------

/** One interval of a range; a `null` bound is unbounded. */
interface Restriction {
  lower: string | null;
  lowerInclusive: boolean;
  upper: string | null;
  upperInclusive: boolean;
}

/** A parsed Maven version range. */
export type MavenRange =
  { kind: "minimum"; version: string } | { kind: "restrictions"; restrictions: Restriction[] };

const BOUND_RE = /^[A-Za-z0-9._+-]{1,128}$/;

function parseBound(text: string): string | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  return BOUND_RE.test(t) ? t : undefined;
}

function parseRestriction(spec: string): Restriction | null {
  const lowerInclusive = spec.startsWith("[");
  const upperInclusive = spec.endsWith("]");
  const inner = spec.slice(1, -1).trim();
  const comma = inner.indexOf(",");
  if (comma === -1) {
    // `[1.0]`: exactly one version.
    const exact = parseBound(inner);
    if (!lowerInclusive || !upperInclusive || exact === null || exact === undefined) return null;
    return { lower: exact, lowerInclusive: true, upper: exact, upperInclusive: true };
  }
  const lower = parseBound(inner.slice(0, comma));
  const upper = parseBound(inner.slice(comma + 1));
  if (lower === undefined || upper === undefined) return null;
  if (lower !== null && upper !== null) {
    if (lower === upper || compareMavenVersions(upper, lower) < 0) return null;
  }
  return { lower, lowerInclusive, upper, upperInclusive };
}

/** Parses a Maven version range; `null` when invalid. */
export function parseMavenRange(range: string): MavenRange | null {
  let rest = range.trim();
  if (rest === "") return null;
  if (!rest.startsWith("[") && !rest.startsWith("(")) {
    return BOUND_RE.test(rest) ? { kind: "minimum", version: rest } : null;
  }
  const restrictions: Restriction[] = [];
  while (rest.startsWith("[") || rest.startsWith("(")) {
    const close = rest.search(/[\])]/);
    if (close === -1) return null;
    const restriction = parseRestriction(rest.slice(0, close + 1));
    if (restriction === null) return null;
    restrictions.push(restriction);
    rest = rest.slice(close + 1).trim();
    if (rest.startsWith(",")) {
      rest = rest.slice(1).trim();
      if (rest === "") return null;
    }
  }
  return rest === "" ? { kind: "restrictions", restrictions } : null;
}

/** Whether a range parses in Maven's syntax. */
export function isValidMavenRange(range: string): boolean {
  return parseMavenRange(range) !== null;
}

function contains(r: Restriction, version: string): boolean {
  if (r.lower !== null) {
    const c = compareMavenVersions(version, r.lower);
    if (c < 0 || (c === 0 && !r.lowerInclusive)) return false;
  }
  if (r.upper !== null) {
    const c = compareMavenVersions(version, r.upper);
    if (c > 0 || (c === 0 && !r.upperInclusive)) return false;
  }
  return true;
}

/** Whether a version satisfies a Maven range; `false` when the range does not parse. */
export function satisfiesMavenRange(version: string, range: string): boolean {
  const parsed = parseMavenRange(range);
  if (parsed === null) return false;
  if (parsed.kind === "minimum") return compareMavenVersions(version, parsed.version) >= 0;
  return parsed.restrictions.some((r) => contains(r, version));
}
