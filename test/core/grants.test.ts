import { describe, expect, it } from "vitest";
import type { Eco } from "../../src/adapters/types";
import { ValidationError } from "../../src/core/errors";
import {
  allowedPackages,
  dialectOf,
  isAllowed,
  isPackageAllowed,
  isValidPackagePattern,
  matchesPackage,
  parseGrantShorthand,
  validateGrant,
  validateGrants,
  type Grant,
  type Satisfies,
} from "../../src/core/grants";
import { satisfies } from "../../src/core/semver";

const satisfiesFor =
  (eco: Eco): Satisfies =>
  (version, constraint) =>
    satisfies(version, constraint, dialectOf(eco));

describe("dialectOf", () => {
  it("maps each ecosystem to its range dialect", () => {
    expect(dialectOf("composer")).toBe("composer");
    expect(dialectOf("npm")).toBe("npm");
    expect(dialectOf("cargo")).toBe("cargo");
    expect(dialectOf("generic")).toBe("npm");
  });

  it("validates generic grants with npm ranges", () => {
    expect(
      validateGrant({ eco: "generic", package: "acme-tool", versions: "^1.2 || 2.x" }),
    ).toEqual({ eco: "generic", package: "acme-tool", versions: "^1.2 || 2.x" });
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
    ["composer:acme/*:*", { eco: "composer", package: "acme/*", versions: "*" }],
    ["composer:acme/*", { eco: "composer", package: "acme/*", versions: "*" }],
    ["npm:@acme/sdk:^2.0", { eco: "npm", package: "@acme/sdk", versions: "^2.0" }],
    ["cargo:acme-core:>=1.4, <2", { eco: "cargo", package: "acme-core", versions: ">=1.4, <2" }],
    ["npm:@acme/sdk:", { eco: "npm", package: "@acme/sdk", versions: "*" }],
    [
      "composer:acme/sdk:^1.0 || ^2.0",
      { eco: "composer", package: "acme/sdk", versions: "^1.0 || ^2.0" },
    ],
  ])("parses %j", (input, expected) => {
    expect(parseGrantShorthand(input)).toEqual(expected);
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
  ])("rejects %j", (input) => {
    let error: unknown;
    try {
      parseGrantShorthand(input);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("invalid_request");
  });
});

describe("validateGrant / validateGrants", () => {
  it("defaults versions to `*`", () => {
    expect(validateGrant({ eco: "npm", package: "@acme/*" })).toEqual({
      eco: "npm",
      package: "@acme/*",
      versions: "*",
    });
  });

  it("drops unknown fields", () => {
    expect(validateGrant({ eco: "cargo", package: "x", versions: "1", extra: true })).toEqual({
      eco: "cargo",
      package: "x",
      versions: "1",
    });
  });

  it.each([null, [], "npm:x", { eco: "npm" }, { eco: "npm", package: "x", versions: 1 }])(
    "rejects %j",
    (value) => {
      expect(() => validateGrant(value)).toThrow(ValidationError);
    },
  );

  it("validates arrays", () => {
    expect(validateGrants([{ eco: "npm", package: "@a/b", versions: "^1" }])).toHaveLength(1);
    expect(() => validateGrants({})).toThrow(ValidationError);
    expect(() => validateGrants([{ eco: "npm", package: "" }])).toThrow(ValidationError);
  });
});
