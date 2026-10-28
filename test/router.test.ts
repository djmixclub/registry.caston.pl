import { describe, expect, it } from "vitest";
import { Router } from "../src/router";

describe("Router", () => {
  const router = new Router<string>()
    .add("GET", "/api/v1/packages", "list")
    .add("GET", "/api/v1/packages/:eco/:name", "get")
    .add("DELETE", "/api/v1/packages/:eco/:name/:version", "delete")
    .add("post", "/api/v1/packages/:eco/:name/reindex", "reindex");

  it("matches literal paths and methods", () => {
    expect(router.match("GET", "/api/v1/packages")).toEqual({ value: "list", params: {} });
    expect(router.match("POST", "/api/v1/packages")).toBeNull();
    expect(router.match("GET", "/api/v1/packages/")).toBeNull();
    expect(router.match("GET", "/api/v1/package")).toBeNull();
  });

  it("decodes each parameter segment on its own", () => {
    expect(router.match("GET", "/api/v1/packages/npm/%40acme%2Fsdk")).toEqual({
      value: "get",
      params: { eco: "npm", name: "@acme/sdk" },
    });
    expect(router.match("get", "/api/v1/packages/composer/acme%2fsdk")?.params.name).toBe(
      "acme/sdk",
    );
    expect(router.match("GET", "/api/v1/packages/composer/acme/sdk")).toBeNull();
  });

  it("tells routes apart by method and segment count", () => {
    expect(router.match("DELETE", "/api/v1/packages/composer/a%2Fb/reindex")?.value).toBe("delete");
    expect(router.match("POST", "/api/v1/packages/composer/a%2Fb/reindex")?.value).toBe("reindex");
  });

  it("rejects empty and malformed parameters", () => {
    expect(router.match("GET", "/api/v1/packages//x")).toBeNull();
    expect(router.match("GET", "/api/v1/packages/npm/%E0%A4%A")).toBeNull();
  });

  it("requires patterns to start with a slash", () => {
    expect(() => new Router<string>().add("GET", "api", "x")).toThrow(TypeError);
  });
});
