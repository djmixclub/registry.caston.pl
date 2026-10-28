import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker", () => {
  it("answers unknown paths with a JSON 404", async () => {
    const response = await exports.default.fetch("https://registry.test/nope");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({ error: "not_found", message: "Not found." });
  });

  it("has KV and R2 bindings", async () => {
    await env.AUTH.put("schema_version", "1");
    await env.R2_BUCKET.put("_meta/probe", "ok");

    expect(await env.AUTH.get("schema_version")).toBe("1");
    expect(await (await env.R2_BUCKET.get("_meta/probe"))?.text()).toBe("ok");
  });
});
