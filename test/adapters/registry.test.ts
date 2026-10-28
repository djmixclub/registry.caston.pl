import { describe, expect, it } from "vitest";
import { ADAPTERS, enabledAdapters, getAdapter, validateRange } from "../../src/adapters/index";
import { placeholderAdapter } from "../../src/adapters/placeholder";
import { ECOS, type PublishInit } from "../../src/adapters/types";
import { ValidationError } from "../../src/core/errors";

describe("ADAPTERS", () => {
  it("has one adapter per ecosystem, created once", () => {
    for (const eco of ECOS) {
      expect(ADAPTERS[eco].eco).toBe(eco);
      expect(ADAPTERS[eco]).toBe(ADAPTERS[eco]);
    }
    expect(Object.keys(ADAPTERS)).toEqual([...ECOS]);
  });
});

describe("getAdapter", () => {
  it("returns enabled adapters only", () => {
    const env = { ECOSYSTEMS: "composer, npm" };
    expect(getAdapter(env, "composer")?.eco).toBe("composer");
    expect(getAdapter(env, "npm")?.eco).toBe("npm");
    expect(getAdapter(env, "cargo")).toBeNull();
    expect(getAdapter(env, "pypi")).toBeNull();
    expect(getAdapter(env, "")).toBeNull();
  });

  it("enables every ecosystem when ECOSYSTEMS is blank", () => {
    for (const eco of ECOS) expect(getAdapter({ ECOSYSTEMS: "" }, eco)?.eco).toBe(eco);
  });
});

describe("enabledAdapters", () => {
  it("lists the enabled adapters in canonical order", () => {
    expect(enabledAdapters({ ECOSYSTEMS: "nuget,composer" }).map((a) => a.eco)).toEqual([
      "composer",
      "nuget",
    ]);
  });
});

describe("validateRange", () => {
  it("uses each adapter's range syntax", () => {
    expect(validateRange("composer", "^1.0 || ^2.0")).toBe(true);
    expect(validateRange("cargo", ">=1.4, <2")).toBe(true);
    expect(validateRange("cargo", "^1.0 || ^2.0")).toBe(false);
    expect(validateRange("npm", "latest")).toBe(false);
  });
});

describe("placeholderAdapter", () => {
  const adapter = placeholderAdapter("npm");

  it("answers 404 for format-specific operations", () => {
    const input: PublishInit = {
      eco: "npm",
      name: "@acme/sdk",
      version: "1.0.0",
      files: [{ name: "sdk-1.0.0.tgz", size: 1, sha256: "0".repeat(64) }],
      manifest: {},
    };
    let error: unknown;
    try {
      adapter.parseManifest(input);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).status).toBe(404);
    expect(() => adapter.buildIndex("@acme/sdk", [], { publicUrl: "https://r.test" })).toThrow(
      ValidationError,
    );
  });

  it("routes nothing and has no snippets", () => {
    const url = new URL("https://r.test/npm/@acme%2fsdk");
    expect(adapter.route(new Request(url), url)).toBeNull();
    expect(adapter.clientConfig("https://r.test", "p:x", [])).toEqual([]);
  });

  it("evaluates semver versions", () => {
    expect(adapter.validateVersion("1.2.3-beta.1")).toBe(true);
    expect(adapter.validateVersion("v1.2.3")).toBe(false);
    expect(adapter.validateVersion("1.2.3+build")).toBe(false);
    expect(adapter.compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(adapter.satisfies("2.1.0", "^2.0")).toBe(true);
  });
});
