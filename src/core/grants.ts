import { isEco, type Eco } from "../adapters/types";
import { ValidationError } from "./errors";

/** What a credential may install (`read`) or release (`publish`); docs/api.md 5.1. */
export interface Grant {
  eco: Eco;
  /** Exact package name, or a pattern whose only `*` is its last character. */
  package: string;
  /** Version constraint in the ecosystem's syntax; `*` = all versions. */
  versions: string;
}

/** The ecosystem's `satisfies(version, constraint)`, looked up by the caller. */
export type Satisfies = (version: string, constraint: string) => boolean;

/**
 * Whether a version constraint parses in an ecosystem's syntax: the adapter's
 * `validateRange`, looked up by the caller (see `validateRange` in `src/adapters/index.ts`).
 */
export type ValidateRange = (eco: Eco, constraint: string) => boolean;

/** npm and Composer package names are case-insensitive; cargo names are compared as written. */
function foldCase(eco: Eco | undefined, value: string): string {
  return eco === "npm" || eco === "composer" ? value.toLowerCase() : value;
}

/**
 * Whether a grant pattern matches a package name. `*` alone matches every package; otherwise
 * a trailing `*` matches any sequence of characters without `/`. Pass `eco` to compare npm
 * and Composer names case-insensitively.
 */
export function matchesPackage(pattern: string, name: string, eco?: Eco): boolean {
  if (pattern === "*") return true;
  const p = foldCase(eco, pattern);
  const n = foldCase(eco, name);
  if (!p.endsWith("*")) return p === n;
  const prefix = p.slice(0, -1);
  return n.startsWith(prefix) && !n.slice(prefix.length).includes("/");
}

/** `*` (or an empty constraint) means every version, prereleases included. */
function allVersions(versions: string): boolean {
  const v = versions.trim();
  return v === "*" || v === "";
}

/**
 * Whether any grant of the ecosystem covers the package and version. A grant whose
 * `versions` is `*` covers every version, including prereleases, without consulting
 * `satisfies` (whose ranges exclude prereleases unless they name one).
 */
export function isAllowed(
  grants: readonly Grant[],
  eco: Eco,
  name: string,
  version: string,
  satisfies: Satisfies,
): boolean {
  return grants.some(
    (g) =>
      g.eco === eco &&
      matchesPackage(g.package, name, eco) &&
      (allVersions(g.versions) || satisfies(version, g.versions)),
  );
}

/** Whether any grant of the ecosystem covers the package, whatever the version. */
export function isPackageAllowed(grants: readonly Grant[], eco: Eco, name: string): boolean {
  return grants.some((g) => g.eco === eco && matchesPackage(g.package, name, eco));
}

/** The distinct package patterns granted for an ecosystem, in grant order. */
export function allowedPackages(grants: readonly Grant[], eco: Eco): string[] {
  return [...new Set(grants.filter((g) => g.eco === eco).map((g) => g.package))];
}

/** Whether a package pattern is well formed: no whitespace, `*` only as the last character. */
export function isValidPackagePattern(pattern: string): boolean {
  if (pattern === "" || pattern.length > 214 || /\s/.test(pattern)) return false;
  const star = pattern.indexOf("*");
  return star === -1 || star === pattern.length - 1;
}

/**
 * Validates one grant from a request body; throws `400 invalid_request`. The version
 * constraint is checked with the ecosystem adapter's rules through `validateRange`.
 */
export function validateGrant(value: unknown, validateRange: ValidateRange): Grant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("invalid_request", "A grant must be an object.");
  }
  const { eco, package: pkg, versions = "*" } = value as Record<string, unknown>;
  if (!isEco(eco)) {
    throw new ValidationError(
      "invalid_request",
      "Grant `eco` must be composer, npm, cargo, generic or nuget.",
    );
  }
  if (typeof pkg !== "string" || !isValidPackagePattern(pkg)) {
    throw new ValidationError(
      "invalid_request",
      "Grant `package` must be a package name or a pattern with `*` as its last character.",
    );
  }
  if (
    typeof versions !== "string" ||
    !(allVersions(versions) || validateRange(eco, versions.trim()))
  ) {
    throw new ValidationError(
      "invalid_request",
      `Grant \`versions\` is not a valid ${eco} version constraint.`,
    );
  }
  return { eco, package: pkg, versions: versions.trim() === "" ? "*" : versions.trim() };
}

/** Validates a list of grants from a request body; throws `400 invalid_request`. */
export function validateGrants(value: unknown, validateRange: ValidateRange): Grant[] {
  if (!Array.isArray(value)) {
    throw new ValidationError("invalid_request", "`grants` must be an array.");
  }
  return value.map((grant) => validateGrant(grant, validateRange));
}

/**
 * Parses the CLI shorthand `eco:package[:versions]`, split at the first two `:`
 * (`versions` defaults to `*`). Throws `400 invalid_request` when invalid.
 */
export function parseGrantShorthand(shorthand: string, validateRange: ValidateRange): Grant {
  const first = shorthand.indexOf(":");
  if (first === -1) {
    throw new ValidationError("invalid_request", "A grant must look like eco:package[:versions].");
  }
  const second = shorthand.indexOf(":", first + 1);
  const eco = shorthand.slice(0, first);
  const pkg = second === -1 ? shorthand.slice(first + 1) : shorthand.slice(first + 1, second);
  const versions = second === -1 ? "*" : shorthand.slice(second + 1);
  return validateGrant({ eco, package: pkg, versions }, validateRange);
}
