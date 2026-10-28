import { describe, expect, it } from "vitest";
import { ECOS, isEco } from "../../src/adapters/types";

describe("isEco", () => {
  it("accepts the three ecosystems", () => {
    for (const eco of ECOS) expect(isEco(eco)).toBe(true);
    expect(ECOS).toEqual(["composer", "npm", "cargo"]);
  });

  it("rejects anything else", () => {
    for (const value of ["pypi", "", "NPM", null, 1, undefined]) expect(isEco(value)).toBe(false);
  });
});
