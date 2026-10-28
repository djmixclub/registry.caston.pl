import { describe, expect, it } from "vitest";
import {
  compareVersions,
  isPrerelease,
  isValidRange,
  parseRange,
  parseVersion,
  satisfies,
  type Dialect,
} from "../../src/core/semver";

describe("parseVersion", () => {
  it.each([
    ["1.2.3", { major: 1, minor: 2, patch: 3, prerelease: [], build: [] }],
    ["v1.2.3", { major: 1, minor: 2, patch: 3, prerelease: [], build: [] }],
    ["V0.0.0", { major: 0, minor: 0, patch: 0, prerelease: [], build: [] }],
    [
      "1.0.0-beta.1+build.5",
      { major: 1, minor: 0, patch: 0, prerelease: ["beta", 1], build: ["build", "5"] },
    ],
    ["1.0.0-rc2", { major: 1, minor: 0, patch: 0, prerelease: ["rc2"], build: [] }],
    ["1.0.0-0.3.7", { major: 1, minor: 0, patch: 0, prerelease: [0, 3, 7], build: [] }],
    ["1.0.0-x-y.z", { major: 1, minor: 0, patch: 0, prerelease: ["x-y", "z"], build: [] }],
    [" 2.0.0 ", { major: 2, minor: 0, patch: 0, prerelease: [], build: [] }],
  ])("parses %s", (input, expected) => {
    expect(parseVersion(input)).toEqual(expected);
  });

  it.each([
    "",
    "1",
    "1.2",
    "1.2.3.4",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3-",
    "1.2.3+",
    "1.2.3-beta..1",
    "vv1.2.3",
    "dev-main",
    "1.x.0",
    "99999999999999999999.0.0",
  ])("rejects %j", (input) => {
    expect(parseVersion(input)).toBeNull();
  });
});

describe("compareVersions", () => {
  // Ascending order from the semver specification, plus build metadata and numeric parts.
  const ordered = [
    "0.0.1",
    "0.1.0",
    "0.9.0",
    "0.10.0",
    "1.0.0-0",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.2.0",
    "1.10.0",
    "2.0.0",
    "10.0.0",
  ];

  it("orders versions by precedence", () => {
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        const a = ordered[i] ?? "";
        const b = ordered[j] ?? "";
        expect(Math.sign(compareVersions(a, b)), `${a} vs ${b}`).toBe(Math.sign(i - j));
      }
    }
  });

  it("sorts with Array.prototype.sort", () => {
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort(compareVersions)).toEqual(ordered);
  });

  it("ignores build metadata and the v prefix", () => {
    expect(compareVersions("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  it("throws on invalid versions", () => {
    expect(() => compareVersions("1.0", "1.0.0")).toThrow(TypeError);
  });
});

describe("isPrerelease", () => {
  it.each([
    ["1.0.0-beta", true],
    ["1.0.0-0", true],
    ["1.0.0", false],
    ["1.0.0+build", false],
    ["nope", false],
  ])("%s → %s", (v, expected) => {
    expect(isPrerelease(v)).toBe(expected);
  });
});

type Case = [range: string, version: string, expected: boolean];

function table(dialect: Dialect, cases: Case[]): void {
  it.each(cases)(`${dialect}: %j against %s → %s`, (range, version, expected) => {
    expect(satisfies(version, range, dialect)).toBe(expected);
  });
}

describe("satisfies (common to all dialects)", () => {
  for (const dialect of ["npm", "composer", "cargo"] as const) {
    table(dialect, [
      ["*", "1.2.3", true],
      ["*", "0.0.0", true],
      ["", "5.0.0", true],
      ["  ", "5.0.0", true],
      ["x", "3.1.4", true],
      ["*", "1.0.0-beta", false],
      ["=1.2.3", "1.2.3", true],
      ["=1.2.3", "1.2.4", false],
      [">1.2.3", "1.2.4", true],
      [">1.2.3", "1.2.3", false],
      [">=1.2.3", "1.2.3", true],
      [">=1.2.3", "1.2.2", false],
      ["<1.2.3", "1.2.2", true],
      ["<1.2.3", "1.2.3", false],
      ["<=1.2.3", "1.2.3", true],
      ["<=1.2.3", "1.2.4", false],
      ["^1.2.3", "1.2.3", true],
      ["^1.2.3", "1.9.9", true],
      ["^1.2.3", "2.0.0", false],
      ["^1.2.3", "1.2.2", false],
      ["^0.2.3", "0.2.9", true],
      ["^0.2.3", "0.3.0", false],
      ["^0.2.3", "0.2.2", false],
      ["^0.0.3", "0.0.3", true],
      ["^0.0.3", "0.0.4", false],
      ["^0.0", "0.0.9", true],
      ["^0.0", "0.1.0", false],
      ["^0", "0.9.9", true],
      ["^0", "1.0.0", false],
      ["^1.2", "1.2.0", true],
      ["^1.2", "1.99.0", true],
      ["^1.2", "2.0.0", false],
      ["~1.2.3", "1.2.3", true],
      ["~1.2.3", "1.2.99", true],
      ["~1.2.3", "1.3.0", false],
      ["~1.2.3", "1.2.2", false],
      ["~1", "1.99.0", true],
      ["~1", "2.0.0", false],
      ["1.2.*", "1.2.7", true],
      ["1.2.*", "1.3.0", false],
      ["1.*", "1.9.0", true],
      ["1.*", "2.0.0", false],
      ["1.*", "0.9.0", false],
      ["v1.2.3", "1.2.3", true],
      [">= 1.2.3", "1.2.3", true],
      ["1.2.3", "v1.2.3", true],
      // Prerelease rule: only prereleases of a tuple named with a prerelease in the set.
      [">=1.0.0-beta", "1.0.0-beta.2", true],
      [">=1.0.0-beta", "1.0.0-alpha", false],
      [">=1.0.0-beta", "1.0.1-alpha", false],
      [">=1.0.0-beta", "1.0.1", true],
      ["^1.2.3-beta.2", "1.2.3-beta.4", true],
      ["^1.2.3-beta.2", "1.2.3", true],
      ["^1.2.3-beta.2", "1.2.4-beta.1", false],
      ["^1.2.3", "1.5.0-rc.1", false],
      ["<2.0.0", "2.0.0-rc.1", false],
      ["=1.0.0-rc.1", "1.0.0-rc.1", true],
      ["=1.0.0-rc.1", "1.0.0", false],
      [">=1.0.0", "1.0.0+build.7", true],
      // Invalid input never satisfies.
      ["^1.2.3", "not-a-version", false],
      ["^1.2.3", "1.2", false],
      [">>1.0.0", "1.0.0", false],
      ["^1.2.3.4", "1.2.3", false],
      ["1.x.3", "1.0.3", false],
    ]);
  }
});

describe("satisfies (npm)", () => {
  table("npm", [
    // Bare partial versions are x-ranges.
    ["1.2", "1.2.0", true],
    ["1.2", "1.2.9", true],
    ["1.2", "1.3.0", false],
    ["1", "1.9.9", true],
    ["1", "2.0.0", false],
    ["1.2.3", "1.2.3", true],
    ["1.2.3", "1.2.4", false],
    ["1.2.x", "1.2.5", true],
    ["1.X", "1.5.0", true],
    ["=1.2", "1.2.5", true],
    // Partial comparators.
    [">1.2", "1.2.9", false],
    [">1.2", "1.3.0", true],
    [">=1.2", "1.2.0", true],
    ["<1.2", "1.1.9", true],
    ["<1.2", "1.2.0", false],
    ["<=1.2", "1.2.9", true],
    ["<=1.2", "1.3.0", false],
    ["<*", "1.0.0", false],
    [">*", "1.0.0", false],
    // Tilde.
    ["~1.2", "1.2.9", true],
    ["~1.2", "1.3.0", false],
    ["~0.2.3", "0.2.9", true],
    ["~0.2.3", "0.3.0", false],
    ["~>1.2.3", "1.2.5", true],
    ["~>1.2.3", "1.3.0", false],
    // Caret with wildcards.
    ["^1.x", "1.9.0", true],
    ["^0.x", "0.9.0", true],
    ["^0.x", "1.0.0", false],
    ["^0.0.x", "0.0.9", true],
    ["^0.0.x", "0.1.0", false],
    // Conjunctions and alternatives.
    [">=1.2.3 <2.0.0", "1.5.0", true],
    [">=1.2.3 <2.0.0", "2.0.0", false],
    [">= 1.2.3 < 2.0.0", "1.9.9", true],
    ["1.x || >=2.5.0", "2.6.0", true],
    ["1.x || >=2.5.0", "2.4.0", false],
    ["1.x || >=2.5.0", "1.0.0", true],
    ["^1.0.0 || ^3.0.0", "3.1.0", true],
    ["^1.0.0 || ^3.0.0", "2.1.0", false],
    // Hyphen ranges.
    ["1.2.3 - 2.3.4", "1.2.3", true],
    ["1.2.3 - 2.3.4", "2.3.4", true],
    ["1.2.3 - 2.3.4", "2.3.5", false],
    ["1.2 - 2.3.4", "1.2.0", true],
    ["1.2.3 - 2.3", "2.3.9", true],
    ["1.2.3 - 2.3", "2.4.0", false],
    ["1.2.3 - 2", "2.9.9", true],
    ["1.2.3 - 2", "3.0.0", false],
    ["1.2 - 2.3", "2.3.1", true],
    ["* - 2", "0.0.1", true],
    // Syntax from other dialects is rejected.
    ["!=1.2.3", "1.2.4", false],
    [">=1.0.0, <2.0.0", "1.5.0", false],
    ["1.0.0 -", "1.0.0", false],
  ]);
});

describe("satisfies (composer)", () => {
  table("composer", [
    // Bare partial versions are exact.
    ["1.2", "1.2.0", true],
    ["1.2", "1.2.1", false],
    ["1", "1.0.0", true],
    ["1", "1.1.0", false],
    ["=1.2", "1.2.0", true],
    ["==1.2.3", "1.2.3", true],
    // Partial comparators fill zeros.
    [">1.2", "1.2.1", true],
    [">1.2", "1.2.0", false],
    ["<=1.2", "1.2.0", true],
    ["<=1.2", "1.2.1", false],
    [">=1.2", "1.2.0", true],
    ["<2", "1.99.99", true],
    // Not equal.
    ["!=1.2.3", "1.2.4", true],
    ["!=1.2.3", "1.2.3", false],
    ["<>1.2.3", "1.2.3", false],
    [">=1.0 !=1.5.0", "1.5.0", false],
    [">=1.0 !=1.5.0", "1.5.1", true],
    ["!=1.*", "1.0.0", false],
    // Tilde: the last given part may change.
    ["~1.2", "1.2.0", true],
    ["~1.2", "1.9.9", true],
    ["~1.2", "2.0.0", false],
    ["~1.2", "1.1.9", false],
    ["~1.2.3", "1.2.9", true],
    ["~1.2.3", "1.3.0", false],
    ["~1", "1.5.0", true],
    ["~1", "2.0.0", false],
    // Caret.
    ["^1.2", "1.9.0", true],
    ["^0.3", "0.3.5", true],
    ["^0.3", "0.4.0", false],
    // Conjunctions: comma or space; alternatives: || or |.
    [">=1.4, <2", "1.5.0", true],
    [">=1.4,<2", "2.0.0", false],
    [">=1.4 <2", "1.4.0", true],
    [">=1.4 , <2", "1.3.0", false],
    ["^1.0 || ^2.0", "2.5.0", true],
    ["^1.0 | ^2.0", "2.5.0", true],
    ["^1.0||^2.0", "3.0.0", false],
    // Hyphen ranges.
    ["1.0 - 2.0", "2.0.9", true],
    ["1.0 - 2.0", "2.1.0", false],
    ["1.0.0 - 2.1.0", "2.1.0", true],
    // Stability flags are ignored.
    ["@stable", "1.0.0", true],
    ["@dev", "1.0.0", true],
    ["^1.0@stable", "1.5.0", true],
    ["1.0.*@beta", "1.0.3", true],
    [">=1.0@dev", "0.9.0", false],
    // Composer prerelease comparison.
    [">=1.0.0-RC1", "1.0.0-rc2", true],
    [">=1.0.0-rc2", "1.0.0-rc10", true],
    [">=1.0.0-beta2", "1.0.0-beta.1", false],
    ["=1.0.0-rc.2", "1.0.0-RC2", true],
    [">=1.0.0-alpha", "1.0.0-beta1", true],
    // Syntax from other dialects is rejected.
    ["~>1.2.3", "1.2.3", false],
  ]);
});

describe("satisfies (cargo)", () => {
  table("cargo", [
    // Bare versions are caret requirements.
    ["1.2", "1.9.0", true],
    ["1.2", "1.1.0", false],
    ["1.2", "2.0.0", false],
    ["1.2.3", "1.4.0", true],
    ["1.2.3", "1.2.2", false],
    ["0.2.3", "0.2.9", true],
    ["0.2.3", "0.3.0", false],
    ["0.0.3", "0.0.4", false],
    ["1", "1.9.9", true],
    ["0", "0.9.0", true],
    ["0", "1.0.0", false],
    // `=` with a partial version is a range.
    ["=1.2", "1.2.7", true],
    ["=1.2", "1.3.0", false],
    ["=1", "1.5.0", true],
    // Tilde.
    ["~1.2", "1.2.9", true],
    ["~1.2", "1.3.0", false],
    // Partial comparators.
    [">1.2", "1.2.9", false],
    [">1.2", "1.3.0", true],
    ["<=1.2", "1.2.9", true],
    ["<=1.2", "1.3.0", false],
    // Comma-separated conjunctions.
    [">=1.4, <2", "1.4.0", true],
    [">=1.4, <2", "1.9.9", true],
    [">=1.4, <2", "2.0.0", false],
    [">=1.4, <2", "1.3.9", false],
    [">= 1.4 , < 2", "1.5.0", true],
    [">=1.2.3,<1.8", "1.7.0", true],
    ["1.2.x", "1.2.5", true],
    ["1.X", "1.5.0", true],
    // Syntax from other dialects is rejected.
    ["^1.0 || ^2.0", "1.0.0", false],
    [">=1.4 <2", "1.5.0", false],
    ["1.0 - 2.0", "1.5.0", false],
    ["!=1.0.0", "1.1.0", false],
    ["~>1.2", "1.2.0", false],
    [">=1.4,", "1.5.0", false],
  ]);
});

describe("parseRange / isValidRange", () => {
  it.each([
    ["*", "npm"],
    ["^2.0", "npm"],
    [">=1.4, <2", "cargo"],
    ["~1.2 || ^2.0@stable", "composer"],
    ["", "cargo"],
  ] as [string, Dialect][])("accepts %j in %s", (range, dialect) => {
    expect(isValidRange(range, dialect)).toBe(true);
  });

  it.each([
    ["^", "npm"],
    ["1.2.3 ||", "npm"],
    ["|| 1.0.0", "composer"],
    ["latest", "npm"],
    ["dev-main", "composer"],
    ["1.2-beta", "npm"],
    [">=1.0 <2", "cargo"],
    ["1.0 | 2.0", "cargo"],
    ["!=1.0.0", "npm"],
    ["!=*", "composer"],
  ] as [string, Dialect][])("rejects %j in %s", (range, dialect) => {
    expect(isValidRange(range, dialect)).toBe(false);
  });

  it("returns alternatives of comparator sets", () => {
    expect(parseRange("^1.2.3 || 2.x", "npm")).toEqual([
      [
        { op: ">=", version: { major: 1, minor: 2, patch: 3, prerelease: [], build: [] } },
        { op: "<", version: { major: 2, minor: 0, patch: 0, prerelease: [], build: [] } },
      ],
      [
        { op: ">=", version: { major: 2, minor: 0, patch: 0, prerelease: [], build: [] } },
        { op: "<", version: { major: 3, minor: 0, patch: 0, prerelease: [], build: [] } },
      ],
    ]);
  });
});
