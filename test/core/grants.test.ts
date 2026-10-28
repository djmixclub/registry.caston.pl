import { describe, expect, it } from "vitest";
import type { Eco } from "../../src/adapters/types";
import { ValidationError } from "../../src/core/errors";
import {
  allowedPackages,
  isAllowed,
  isPackageAllowed,
  isValidPackagePattern,
  matchesPackage,
  parseGrantShorthand,
  validateGrant,
  validateGrants,
  type Grant,
  type Satisfies,
  type ValidateRange,
} from "../../src/core/grants";
import { isValidRange, satisfies, type Dialect } from "../../src/core/semver";

function dialectOf(eco: Eco): Dialect {
  return eco === "composer" || eco === "cargo" ? eco : "npm";
}

const satisfiesFor =
  (eco: Eco): Satisfies =>
  (version, constraint) =>
    satisfies(version, constraint, dialectOf(eco));

/** Range validation as the adapters do it (generic and nuget with npm ranges for now). */
const ranges: ValidateRange = (eco, constraint) => isValidRange(constraint, dialectOf(eco));

describe("validateGrant range lookup", () => {
  it("validates the constraint with the ecosystem's rules", () => {
    expect(
      validateGrant({ eco: "generic", package: "acme-tool", versions: "^1.2 || 2.x" }, ranges),
    ).toEqual({ eco: "generic", package: "acme-tool", versions: "^1.2 || 2.x", transitive: true });
  });

  it("asks the lookup with the trimmed constraint and never for `*`", () => {
    const seen: [Eco, string][] = [];
    const lookup: ValidateRange = (eco, constraint) => {
      seen.push([eco, constraint]);
      return constraint === "custom";
    };
    expect(
      validateGrant({ eco: "nuget", package: "Acme.Core", versions: " custom " }, lookup),
    ).toEqual({ eco: "nuget", package: "Acme.Core", versions: "custom", transitive: true });
    expect(
      validateGrant({ eco: "nuget", package: "Acme.Core", versions: "*" }, lookup).versions,
    ).toBe("*");
    expect(() => validateGrant({ eco: "nuget", package: "x", versions: "^1" }, lookup)).toThrow(
      ValidationError,
    );
    expect(seen).toEqual([
      ["nuget", "custom"],
      ["nuget", "^1"],
    ]);
  });
});

describe("matchesPackage", () => {
  it.each([
    ["*", "acme/sdk", undefined, true],
    ["*", "@acme/sdk", undefined, true],
    ["*", "acme-core", undefined, true],
    ["acme/sdk", "acme/sdk", undefined, true],
    ["acme/sdk", "acme/sdk2", undefined, false],
    ["acme/*", "acme/sdk", undefined, true],
    ["acme/*", "acme/sdk/extra", undefined, false],
    ["acme/*", "other/sdk", undefined, false],
    ["acme/*", "acme", undefined, false],
    ["@acme/*", "@acme/sdk", undefined, true],
    ["@acme/*", "@other/sdk", undefined, false],
    ["acme-*", "acme-core", undefined, true],
    ["acme-*", "acme-core/x", undefined, false],
    ["acme-*", "acme", undefined, false],
    ["acme*", "acme/sdk", undefined, false],
    ["Acme/*", "acme/sdk", undefined, false],
    ["Acme/*", "acme/sdk", "composer", true],
    ["acme/SDK", "acme/sdk", "composer", true],
    ["@Acme/sdk", "@acme/sdk", "npm", true],
    ["Acme-core", "acme-core", "cargo", false],
    ["acme-*", "acme-Core", "cargo", true],
    ["com.acme:*", "com.acme:sdk", "maven", true],
    ["com.acme:*", "com.acmex:sdk", "maven", false],
    ["com.acme:sdk", "comxacme:sdk", "maven", false],
    ["com.acme:Sdk", "com.acme:sdk", "maven", false],
    ["com.acme*", "com.acme.tools:sdk", "maven", true],
    ["acme.*", "acme.Networking", "swift", true],
    ["acme.networking", "Acme.Networking", "swift", true],
    ["acme.networking", "acmexnetworking", "swift", false],
    ["Acme.*", "acme.sdk", "nuget", true],
    ["acme.sdk", "Acme.Sdk", "nuget", true],
    ["Acme.*", "other.sdk", "nuget", false],
    ["acme-tool", "Acme-tool", "generic", false],
  ] as [string, string, Eco | undefined, boolean][])(
    "%j matches %j (%s) → %s",
    (pattern, name, eco, expected) => {
      expect(matchesPackage(pattern, name, eco)).toBe(expected);
    },
  );
});

describe("isAllowed", () => {
  const grants: Grant[] = [
    { eco: "composer", package: "acme/*", versions: "*" },
    { eco: "npm", package: "@acme/sdk", versions: "^2.0" },
    { eco: "cargo", package: "acme-core", versions: ">=1.4, <2" },
  ];

  it.each([
    ["composer", "acme/sdk", "1.0.0", true],
    ["composer", "acme/sdk", "3.0.0-beta.1", true],
    ["composer", "ACME/sdk", "1.0.0", true],
    ["composer", "other/sdk", "1.0.0", false],
    ["npm", "@acme/sdk", "2.3.1", true],
    ["npm", "@acme/sdk", "3.0.0", false],
    ["npm", "@acme/sdk", "2.4.0-rc.1", false],
    ["npm", "@acme/other", "2.3.1", false],
    ["npm", "acme/sdk", "1.0.0", false],
    ["cargo", "acme-core", "1.4.2", true],
    ["cargo", "acme-core", "2.0.0", false],
    ["cargo", "acme-core", "1.3.0", false],
    ["cargo", "acme/sdk", "1.0.0", false],
  ] as [Eco, string, string, boolean][])("%s %s@%s → %s", (eco, name, version, expected) => {
    expect(isAllowed(grants, eco, name, version, satisfiesFor(eco))).toBe(expected);
  });

  it("grants nothing without grants", () => {
    expect(isAllowed([], "npm", "@acme/sdk", "1.0.0", satisfiesFor("npm"))).toBe(false);
  });

  it("does not call satisfies for `*`", () => {
    const calls: string[] = [];
    const spy: Satisfies = (v, c) => {
      calls.push(`${v} ${c}`);
      return false;
    };
    expect(
      isAllowed([{ eco: "npm", package: "*", versions: " * " }], "npm", "x", "1.0.0", spy),
    ).toBe(true);
    expect(calls).toEqual([]);
  });

  it("succeeds when any one grant matches", () => {
    const two: Grant[] = [
      { eco: "npm", package: "@acme/*", versions: "^1.0" },
      { eco: "npm", package: "@acme/sdk", versions: "^2.0" },
    ];
    expect(isAllowed(two, "npm", "@acme/sdk", "2.0.0", satisfiesFor("npm"))).toBe(true);
    expect(isAllowed(two, "npm", "@acme/web", "2.0.0", satisfiesFor("npm"))).toBe(false);
  });
});

describe("isPackageAllowed / allowedPackages", () => {
  const grants: Grant[] = [
    { eco: "npm", package: "@acme/*", versions: "^1.0" },
    { eco: "npm", package: "@acme/sdk", versions: "^2.0" },
    { eco: "npm", package: "@acme/*", versions: "^3.0" },
    { eco: "cargo", package: "acme-core", versions: "*" },
  ];

  it("checks the package regardless of version", () => {
    expect(isPackageAllowed(grants, "npm", "@acme/web")).toBe(true);
    expect(isPackageAllowed(grants, "npm", "@other/web")).toBe(false);
    expect(isPackageAllowed(grants, "composer", "acme/web")).toBe(false);
  });

  it("lists distinct patterns per ecosystem", () => {
    expect(allowedPackages(grants, "npm")).toEqual(["@acme/*", "@acme/sdk"]);
    expect(allowedPackages(grants, "cargo")).toEqual(["acme-core"]);
    expect(allowedPackages(grants, "composer")).toEqual([]);
  });
});

describe("isValidPackagePattern", () => {
  it.each(["*", "acme/*", "@acme/*", "acme-*", "acme/sdk", "acme-core"])("accepts %j", (p) => {
    expect(isValidPackagePattern(p)).toBe(true);
  });

  it.each(["", "*/sdk", "acme/*/x", "a*b", "**", "acme sdk", "x".repeat(215)])(
    "rejects %j",
    (p) => {
      expect(isValidPackagePattern(p)).toBe(false);
    },
  );
});

describe("parseGrantShorthand", () => {
  it.each([
    ["composer:acme/*:*", { eco: "composer", package: "acme/*", versions: "*", transitive: true }],
    ["composer:acme/*", { eco: "composer", package: "acme/*", versions: "*", transitive: true }],
    [
      "npm:@acme/sdk:^2.0",
      { eco: "npm", package: "@acme/sdk", versions: "^2.0", transitive: true },
    ],
    [
      "cargo:acme-core:>=1.4, <2",
      { eco: "cargo", package: "acme-core", versions: ">=1.4, <2", transitive: true },
    ],
    ["npm:@acme/sdk:", { eco: "npm", package: "@acme/sdk", versions: "*", transitive: true }],
    [
      "composer:acme/sdk:^1.0 || ^2.0",
      { eco: "composer", package: "acme/sdk", versions: "^1.0 || ^2.0", transitive: true },
    ],
    [
      "npm:@acme/sdk:^2.0:false",
      { eco: "npm", package: "@acme/sdk", versions: "^2.0", transitive: false },
    ],
    [
      "npm:@acme/sdk:^2.0:true",
      { eco: "npm", package: "@acme/sdk", versions: "^2.0", transitive: true },
    ],
    [
      "composer:acme/*::false",
      { eco: "composer", package: "acme/*", versions: "*", transitive: false },
    ],
    [
      "cargo:acme-core:>=1.4, <2:false",
      { eco: "cargo", package: "acme-core", versions: ">=1.4, <2", transitive: false },
    ],
    [
      "maven:com.acme:sdk",
      { eco: "maven", package: "com.acme:sdk", versions: "*", transitive: true },
    ],
    [
      "maven:com.acme:*:*:false",
      { eco: "maven", package: "com.acme:*", versions: "*", transitive: false },
    ],
    [
      "maven:com.acme:sdk:>=1.0.0",
      { eco: "maven", package: "com.acme:sdk", versions: ">=1.0.0", transitive: true },
    ],
    [
      "swift:acme.Networking:^1.2.0",
      { eco: "swift", package: "acme.Networking", versions: "^1.2.0", transitive: true },
    ],
  ])("parses %j", (input, expected) => {
    expect(parseGrantShorthand(input, ranges)).toEqual(expected);
  });

  it.each([
    "composer",
    "pypi:acme:*",
    ":acme:*",
    "npm::*",
    "npm:@acme/*/x:*",
    "npm:@acme/sdk:latest",
    "cargo:acme-core:^1.0 || ^2.0",
    "composer:acme/sdk:dev-main",
    "composer:acme/sdk:false",
    "composer:acme/sdk:^1.0:maybe",
  ])("rejects %j", (input) => {
    let error: unknown;
    try {
      parseGrantShorthand(input, ranges);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("invalid_request");
  });
});

describe("validateGrant / validateGrants", () => {
  it("defaults versions to `*` and transitive to true", () => {
    expect(validateGrant({ eco: "npm", package: "@acme/*" }, ranges)).toEqual({
      eco: "npm",
      package: "@acme/*",
      versions: "*",
      transitive: true,
    });
  });

  it("keeps an explicit transitive flag for every ecosystem", () => {
    expect(
      validateGrant({ eco: "cargo", package: "x", versions: "1", transitive: false }, ranges),
    ).toMatchObject({ transitive: false });
    expect(validateGrant({ eco: "generic", package: "x", transitive: true }, ranges)).toMatchObject(
      { transitive: true },
    );
  });

  it("drops unknown fields", () => {
    expect(
      validateGrant({ eco: "cargo", package: "x", versions: "1", extra: true }, ranges),
    ).toEqual({
      eco: "cargo",
      package: "x",
      versions: "1",
      transitive: true,
    });
  });

  it.each([
    null,
    [],
    "npm:x",
    { eco: "npm" },
    { eco: "npm", package: "x", versions: 1 },
    { eco: "npm", package: "x", transitive: "false" },
    { eco: "npm", package: "x", transitive: null },
  ])("rejects %j", (value) => {
    expect(() => validateGrant(value, ranges)).toThrow(ValidationError);
  });

  it("validates arrays", () => {
    expect(validateGrants([{ eco: "npm", package: "@a/b", versions: "^1" }], ranges)).toHaveLength(
      1,
    );
    expect(() => validateGrants({}, ranges)).toThrow(ValidationError);
    expect(() => validateGrants([{ eco: "npm", package: "" }], ranges)).toThrow(ValidationError);
  });
});
