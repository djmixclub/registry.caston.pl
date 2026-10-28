import { describe, expect, it } from "vitest";
import { ECOS, isEco, isManifestFile } from "../../src/adapters/types";

describe("isEco", () => {
  it("accepts the four ecosystems", () => {
    for (const eco of ECOS) expect(isEco(eco)).toBe(true);
    expect(ECOS).toEqual(["composer", "npm", "cargo", "generic"]);
  });

  it("rejects anything else", () => {
    for (const value of ["pypi", "", "NPM", null, 1, undefined]) expect(isEco(value)).toBe(false);
  });
});

describe("isManifestFile", () => {
  it("accepts files with optional role and labels", () => {
    expect(isManifestFile({ name: "a.zip", size: 1, sha256: "0".repeat(64) })).toBe(true);
    expect(
      isManifestFile({
        name: "a.tar.gz",
        size: 1,
        sha256: "0".repeat(64),
        role: "archive",
        labels: { os: "linux", arch: "x86_64" },
      }),
    ).toBe(true);
  });

  it.each([
    null,
    [],
    { name: "a", size: "1", sha256: "x" },
    { name: "a", size: 1 },
    { name: "a", size: 1, sha256: "x", role: 1 },
    { name: "a", size: 1, sha256: "x", labels: { os: 1 } },
    { name: "a", size: 1, sha256: "x", labels: ["linux"] },
  ])("rejects %j", (value) => {
    expect(isManifestFile(value)).toBe(false);
  });
});
