import { describe, expect, it } from "vitest";
import {
  compareMavenVersions,
  isMavenPrerelease,
  isValidMavenRange,
  isValidMavenVersion,
  parseMavenRange,
  satisfiesMavenRange,
} from "../../src/adapters/maven/version";

/** Every version is lower than the next one (and equal to itself). */
function checkOrder(versions: readonly string[]): void {
  for (let i = 0; i < versions.length; i++) {
    const a = versions[i] ?? "";
    expect(compareMavenVersions(a, a), a).toBe(0);
    for (let j = i + 1; j < versions.length; j++) {
      const b = versions[j] ?? "";
      expect(compareMavenVersions(a, b), `${a} < ${b}`).toBe(-1);
      expect(compareMavenVersions(b, a), `${b} > ${a}`).toBe(1);
    }
  }
}

describe("compareMavenVersions", () => {
  it("orders the classic cases", () => {
    expect(compareMavenVersions("1.0", "1.0.0")).toBe(0);
    expect(compareMavenVersions("1", "1.0.0.0")).toBe(0);
    checkOrder(["1.0-alpha", "1.0-beta", "1.0-milestone", "1.0-rc", "1.0", "1.0-sp"]);
    expect(compareMavenVersions("1.0.1", "1.0")).toBe(1);
    expect(compareMavenVersions("2.3.1.Final", "2.3.1")).toBe(0);
    expect(compareMavenVersions("2.3.1.Final", "2.3.1.GA")).toBe(0);
    checkOrder(["2.3.1.CR1", "2.3.1.Final", "2.3.1.SP1", "2.3.2.Final"]);
    checkOrder(["1.0-beta-2", "1.0-SNAPSHOT", "1.0"]);
    checkOrder(["1.0-rc1-SNAPSHOT", "1.0-rc1", "1.0-rc2", "1.0-rc10"]);
  });

  it("orders Maven's qualifier test versions", () => {
    checkOrder([
      "1-alpha2snapshot",
      "1-alpha2",
      "1-alpha-123",
      "1-beta-2",
      "1-beta123",
      "1-m2",
      "1-m11",
      "1-rc",
      "1-cr2",
      "1-rc123",
      "1-SNAPSHOT",
      "1",
      "1-sp",
      "1-sp2",
      "1-sp123",
      "1-abc",
      "1-def",
      "1-pom-1",
      "1-1-snapshot",
      "1-1",
      "1-2",
      "1-123",
    ]);
  });

  it("orders Maven's number test versions", () => {
    checkOrder([
      "2.0",
      "2.0.a",
      "2-1",
      "2.0.2",
      "2.0.123",
      "2.1.0",
      "2.1-a",
      "2.1b",
      "2.1-c",
      "2.1-1",
      "2.1.0.1",
      "2.2",
      "2.123",
      "11.a2",
      "11.a11",
      "11.b2",
      "11.b11",
      "11.m2",
      "11.m11",
      "11",
      "11.a",
      "11b",
      "11c",
      "11m",
    ]);
  });

  it("treats aliases, separators and case alike", () => {
    const equal: [string, string][] = [
      ["1", "1-0"],
      ["1", "1.0-0"],
      ["1a", "1-a"],
      ["1a", "1.0.0-a"],
      ["1.0.0x", "1-x"],
      ["1cr", "1rc"],
      ["1a1", "1-alpha-1"],
      ["1b2", "1-beta-2"],
      ["1m3", "1-milestone-3"],
      ["1X", "1x"],
      ["1Ga", "1"],
      ["1RELEASE", "1"],
      ["1FinaL", "1"],
      ["1m3", "1MileStone3"],
      ["0000000000000000001", "1"],
      ["1.0.0-0000000000000000001", "1.0.0-1"],
    ];
    for (const [a, b] of equal) expect(compareMavenVersions(a, b), `${a} = ${b}`).toBe(0);
  });

  it("follows Maven's ordering of the regression cases", () => {
    const ordered: [string, string][] = [
      ["1", "2"],
      ["1.5", "2"],
      ["1.0", "1.1"],
      ["1.0.0", "1.1"],
      ["1.0-alpha-1", "1.0"],
      ["1.0-alpha-1", "1.0-alpha-2"],
      ["1.0-alpha-1-SNAPSHOT", "1.0-alpha-1"],
      ["1.0", "1.0-1"],
      ["1.0.0", "1.0-1"],
      ["2.0-1", "2.0.1"],
      ["2.0.1-klm", "2.0.1-lmn"],
      ["2.0.1", "2.0.1-xyz"],
      ["2.0.1-xyz", "2.0.1-123"],
      ["6.1.0rc3", "6.1.0"],
      ["6.1.0rc3", "6.1H.5-beta"],
      ["20190126.230843", "1234567890.12345"],
      ["1234567890.12345", "123456789012345.1H.5-beta"],
      ["1-0.alpha", "1"],
      ["1-0.alpha", "1-0.beta"],
      ["1.9", "1.10"],
    ];
    for (const [a, b] of ordered) expect(compareMavenVersions(a, b), `${a} < ${b}`).toBe(-1);
  });
});

describe("isValidMavenVersion and isMavenPrerelease", () => {
  it("accepts repository versions but not snapshots", () => {
    for (const v of ["1.0", "1.0.0", "2.3.1.Final", "1.0.0-rc.1+build.5", "20261028", "1_0"]) {
      expect(isValidMavenVersion(v), v).toBe(true);
    }
    for (const v of ["", "1.0 beta", "1/0", "1.0.0-SNAPSHOT", "1.0-snapshot", "x".repeat(129)]) {
      expect(isValidMavenVersion(v), v).toBe(false);
    }
  });

  it("finds qualifiers ordered before the release", () => {
    for (const v of ["1.0-alpha", "1.0-a1", "1.0-beta-2", "2.0.0-M3", "1.5.0-rc1", "1.0.CR2"]) {
      expect(isMavenPrerelease(v), v).toBe(true);
    }
    for (const v of ["1.0", "2.3.1.Final", "1.0-sp1", "1.0-GA", "1.0-1", "1.0-jre", "1.0-a"]) {
      expect(isMavenPrerelease(v), v).toBe(false);
    }
  });
});

describe("Maven ranges", () => {
  it("parses intervals, exact versions, unions and minimums", () => {
    expect(parseMavenRange("[1.0,2.0)")).toEqual({
      kind: "restrictions",
      restrictions: [{ lower: "1.0", lowerInclusive: true, upper: "2.0", upperInclusive: false }],
    });
    expect(parseMavenRange(" 1.0 ")).toEqual({ kind: "minimum", version: "1.0" });
    for (const range of ["[1.0,2.0)", "(,1.0]", "[1.0]", "(1.0,)", "[ 1.0 , 2.0 ]", "(,)"]) {
      expect(isValidMavenRange(range), range).toBe(true);
    }
    expect(isValidMavenRange("[1.0,2.0),[3.0,)")).toBe(true);
    for (const range of [
      "",
      "[1.0",
      "1.0]",
      "(1.0)",
      "[1.0)",
      "[2.0,1.0]",
      "[1.0,1.0]",
      "[1.0,2.0),",
      "[1.0,2.0) 3.0",
      "[1.0,2.0,3.0]",
      "[1 0,2]",
      "^1.0",
      ">=1.0",
    ]) {
      expect(isValidMavenRange(range), range).toBe(false);
    }
  });

  it("evaluates versions against ranges", () => {
    const cases: [string, string, boolean][] = [
      ["1.0", "[1.0,2.0)", true],
      ["1.5.3", "[1.0,2.0)", true],
      ["2.0", "[1.0,2.0)", false],
      ["2.0-rc1", "[1.0,2.0)", true],
      ["0.9", "[1.0,2.0)", false],
      ["1.0", "(,1.0]", true],
      ["1.0.1", "(,1.0]", false],
      ["1.0.0", "[1.0]", true],
      ["1.0.1", "[1.0]", false],
      ["1.0", "(1.0,)", false],
      ["1.0.1", "(1.0,)", true],
      ["1.0", "1.0", true],
      ["7.3", "1.0", true],
      ["0.9", "1.0", false],
      ["3.1", "[1.0,2.0),[3.0,)", true],
      ["2.5", "[1.0,2.0),[3.0,)", false],
      ["5.0", "(,)", true],
      ["1.0", "nonsense range", false],
    ];
    for (const [version, range, expected] of cases) {
      expect(satisfiesMavenRange(version, range), `${version} in ${range}`).toBe(expected);
    }
  });
});
