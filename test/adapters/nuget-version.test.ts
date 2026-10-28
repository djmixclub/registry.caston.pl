import { describe, expect, it } from "vitest";
import {
  compareNuGetVersions,
  isNuGetPrerelease,
  isValidNuGetRange,
  isValidNuGetVersion,
  normalizeNuGetVersion,
  parseNuGetRange,
  satisfiesNuGetRange,
} from "../../src/adapters/nuget/version";

describe("NuGet versions", () => {
  it.each([
    "1",
    "1.0",
    "1.2.3",
    "1.2.3.4",
    "01.2.3.0",
    "1.2.3-beta",
    "1.2.3-Beta.1",
    "1.2.3-rc-1.x",
    "1.2.3+abc",
    "1.2.3-beta+abc.def",
    "2147483647.0.0",
  ])("accepts %s", (v) => expect(isValidNuGetVersion(v)).toBe(true));

  it.each([
    "",
    "v1.0.0",
    "1.2.3.4.5",
    "1.",
    ".1",
    "1..2",
    "1.2.3-",
    "1.2.3-beta..1",
    "1.2.3-beta.01",
    "1.2.3+",
    "1.2.3-be_ta",
    "2147483648.0.0",
    " 1.0.0",
    "1.0.0 ",
    "latest",
  ])("rejects %j", (v) => expect(isValidNuGetVersion(v)).toBe(false));

  it.each([
    ["1", "1.0.0"],
    ["1.2", "1.2.0"],
    ["1.2.3", "1.2.3"],
    ["1.2.3.0", "1.2.3"],
    ["1.2.3.4", "1.2.3.4"],
    ["01.02.003", "1.2.3"],
    ["01.2.3.0-Beta+abc", "1.2.3-beta"],
    ["1.0.0-RC.1", "1.0.0-rc.1"],
    ["1.0.0+build", "1.0.0"],
    ["1.0.0.0-alpha", "1.0.0-alpha"],
  ])("normalises %s to %s", (v, expected) => expect(normalizeNuGetVersion(v)).toBe(expected));

  it("refuses to normalise an invalid version", () => {
    expect(() => normalizeNuGetVersion("x")).toThrow(TypeError);
  });

  it("orders versions the way NuGet does", () => {
    const sorted = [
      "1.0.0",
      "1.0.0.1",
      "1.0.0-beta.10",
      "1.0.0-beta.2",
      "1.0.0-beta",
      "1.0.0-alpha",
      "1.0.0-beta.x",
      "1.0.0-1",
      "0.9",
      "1.10.0",
      "1.2.0",
    ].sort(compareNuGetVersions);
    expect(sorted).toEqual([
      "0.9",
      "1.0.0-1",
      "1.0.0-alpha",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.10",
      "1.0.0-beta.x",
      "1.0.0",
      "1.0.0.1",
      "1.2.0",
      "1.10.0",
    ]);
  });

  it.each([
    ["1.2", "1.2.0.0"],
    ["1.0.0-BETA", "1.0.0-beta"],
    ["1.0.0+a", "1.0.0+b"],
  ])("treats %s and %s as equal", (a, b) => expect(compareNuGetVersions(a, b)).toBe(0));

  it("recognises prereleases", () => {
    expect(isNuGetPrerelease("1.0.0-beta")).toBe(true);
    expect(isNuGetPrerelease("1.0.0+beta")).toBe(false);
    expect(isNuGetPrerelease("x")).toBe(false);
  });
});

describe("NuGet version ranges", () => {
  it.each([
    "",
    "1.0",
    "1.0.0-beta",
    "[1.0]",
    "[1.0,2.0)",
    "[1.0, 2.0]",
    "(1.0,2.0)",
    "(,1.0]",
    "(,1.0)",
    "(1.0,)",
    "[1.0,)",
    "[13.0.1, )",
    " [ 1.0 , 2.0 ) ",
    "[1.0,1.0]",
    "*",
    "*-*",
    "1.*",
    "1.2.*",
    "1.2.3.*",
    "1.*-*",
    "1.0.0-*",
    "1.0.0-beta*",
    "1.0.0-beta.*",
  ])("accepts %j", (range) => expect(isValidNuGetRange(range)).toBe(true));

  it.each([
    "[1.0",
    "1.0]",
    "(1.0)",
    "(1.0]",
    "[1.0)",
    "[,]",
    "(,)",
    "[2.0,1.0]",
    "[1.0,1.0)",
    "(1.0,1.0]",
    "[1.0,2.0,3.0]",
    "[1.*,2.0)",
    "1.*.3",
    "1.2.3.4.*",
    "**",
    "1.0.0-be*ta",
    "^1.0",
    ">=1.0",
    "1.0 - 2.0",
    "x",
  ])("rejects %j", (range) => expect(isValidNuGetRange(range)).toBe(false));

  it("parses intervals with their bounds", () => {
    expect(parseNuGetRange("[1.0,2.0)")).toEqual({
      kind: "interval",
      min: { version: { parts: [1, 0, 0, 0], prerelease: [] }, inclusive: true },
      max: { version: { parts: [2, 0, 0, 0], prerelease: [] }, inclusive: false },
    });
    expect(parseNuGetRange("1.*-*")).toEqual({ kind: "float", prefix: [1], prerelease: true });
  });

  it.each<[string, string, boolean]>([
    // A bare version is a minimum.
    ["1.0.0", "1.0", true],
    ["0.9.0", "1.0", false],
    ["5.0.0", "1.0", true],
    ["1.0.0-beta", "1.0", false],
    // Exact versions, in any notation.
    ["1.0.0", "[1.0]", true],
    ["1.0.0.0", "[1.0]", true],
    ["1.0.1", "[1.0]", false],
    // Intervals.
    ["1.0.0", "[1.0,2.0)", true],
    ["1.9.9.9", "[1.0,2.0)", true],
    ["2.0.0", "[1.0,2.0)", false],
    ["2.0.0", "[1.0,2.0]", true],
    ["1.0.0", "(1.0,2.0)", false],
    ["1.5.0-beta", "[1.0,2.0)", true],
    ["2.0.0-beta", "[1.0,2.0)", true],
    ["0.1.0", "(,1.0]", true],
    ["1.0.0", "(,1.0)", false],
    ["1.0.1", "(1.0,)", true],
    ["13.0.3", "[13.0.1, )", true],
    ["13.0.0", "[13.0.1, )", false],
    // Floating ranges match a prefix.
    ["0.0.1", "*", true],
    ["1.0.0-beta", "*", false],
    ["1.0.0-beta", "*-*", true],
    ["1.0.0", "1.*", true],
    ["1.99.0.1", "1.*", true],
    ["2.0.0", "1.*", false],
    ["1.5.0-beta", "1.*", false],
    ["1.5.0-beta", "1.*-*", true],
    ["1.2.7", "1.2.*", true],
    ["1.3.0", "1.2.*", false],
    ["1.2.3.9", "1.2.3.*", true],
    ["1.2.4", "1.2.3.*", false],
    ["1.0.0-alpha.1", "1.0.0-*", true],
    ["1.0.0", "1.0.0-*", true],
    ["1.0.1-alpha", "1.0.0-*", false],
    ["1.0.0-BETA.2", "1.0.0-beta*", true],
    ["1.0.0-alpha", "1.0.0-beta*", false],
    // An empty range admits everything.
    ["1.0.0-beta", "", true],
    // Invalid input never matches.
    ["x", "*", false],
    ["1.0.0", "^1.0", false],
  ])("%s in %j is %s", (version, range, expected) =>
    expect(satisfiesNuGetRange(version, range)).toBe(expected),
  );
});
