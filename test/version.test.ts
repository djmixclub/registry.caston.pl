import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import { MIN_CLIENT_VERSION, SCHEMA_VERSION, VERSION } from "../src/version";

describe("GET /api/v1/version", () => {
  it("returns the worker version, minimum client version and schema version", async () => {
    const response = await exports.default.fetch("https://registry.test/api/v1/version");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-min-client-version")).toBe(MIN_CLIENT_VERSION);
    expect(await response.json()).toEqual({
      version: VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
      schemaVersion: SCHEMA_VERSION,
    });
  });

  it("keeps VERSION equal to the package version", () => {
    expect(VERSION).toBe(packageJson.version);
  });

  it("does not answer other methods", async () => {
    const response = await exports.default.fetch("https://registry.test/api/v1/version", {
      method: "POST",
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("x-min-client-version")).toBe(MIN_CLIENT_VERSION);
    expect(await response.json()).toEqual({ error: "not_found", message: "Not found." });
  });
});
