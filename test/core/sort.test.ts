import { describe, expect, it } from "vitest";
import { compareNames, sortKey, sortPackages } from "../../src/core/sort";

const pkg = (eco: "npm" | "composer" | "cargo", name: string) => ({
  eco,
  name,
  versions: [{ version: "1.0.0" }],
});

describe("sortKey", () => {
  it("keeps lower-case letters and digits only", () => {
    expect(sortKey("@Licensing-Kit/Activation.Client_2")).toBe("licensingkitactivationclient2");
    expect(sortKey("")).toBe("");
    expect(sortKey("---")).toBe("");
  });

  it("keeps letters of other scripts and drops what is not a letter or a digit", () => {
    expect(sortKey("Zażółć-Gęślą/Jaźń")).toBe("zażółćgęśląjaźń");
    expect(sortKey("名前-ひらがな")).toBe("名前ひらがな");
    expect(sortKey("café ☕ 2")).toBe("café2");
  });
});

describe("compareNames", () => {
  it("orders by the key, then by the spelling", () => {
    expect(["b-a", "Ba", "a/b", "ab"].sort(compareNames)).toEqual(["a/b", "ab", "Ba", "b-a"]);
  });
});

describe("sortPackages", () => {
  it("orders by key, then ecosystem, then spelling, without changing its input", () => {
    const input = [
      pkg("npm", "@acme/b"),
      pkg("npm", "acme-a"),
      pkg("composer", "acme/a"),
      pkg("cargo", "acme.a"),
      pkg("npm", "ACME-A"),
    ];
    const copy = [...input];
    expect(sortPackages(input).map((p) => `${p.eco}:${p.name}`)).toEqual([
      "cargo:acme.a",
      "composer:acme/a",
      "npm:ACME-A",
      "npm:acme-a",
      "npm:@acme/b",
    ]);
    expect(input).toEqual(copy);
  });
});
