import { describe, expect, it } from "vitest";
import { ERROR_STATUS, ValidationError, type ErrorCode } from "../../src/core/errors";
import { errorResponse, jsonResponse } from "../../src/core/http";

describe("ValidationError", () => {
  it.each(Object.entries(ERROR_STATUS) as [ErrorCode, number][])(
    "maps %s to %i",
    (code, status) => {
      const err = new ValidationError(code);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(err.message).not.toBe("");
    },
  );

  it("keeps a custom message", () => {
    expect(new ValidationError("invalid_request", "Field `name` is required.").message).toBe(
      "Field `name` is required.",
    );
  });
});

describe("jsonResponse", () => {
  it("serialises the body with JSON and no-store headers", async () => {
    const response = jsonResponse({ ok: true }, 201, { "x-extra": "1" });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-extra")).toBe("1");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("defaults to 200", () => {
    expect(jsonResponse([]).status).toBe(200);
  });
});

describe("errorResponse", () => {
  it("renders a ValidationError", async () => {
    const response = errorResponse(new ValidationError("version_exists", "Already there."));
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "version_exists", message: "Already there." });
  });

  it("appends the details of an error after error and message", async () => {
    const details = { version: "1.0.0", files: ["a", "b"], error: "x", message: "y" };
    const response = errorResponse(new ValidationError("ambiguous", "Two files.", details));
    expect(response.status).toBe(409);
    expect(await response.text()).toBe(
      '{"error":"ambiguous","message":"Two files.","version":"1.0.0","files":["a","b"]}',
    );
  });

  it("adds WWW-Authenticate to 401", () => {
    const response = errorResponse(new ValidationError("unauthorized"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="serverless-registry"');
  });

  it("hides unexpected errors behind internal_error", async () => {
    const response = errorResponse(new Error("secret detail"));
    expect(response.status).toBe(500);
    const body = await response.json<{ error: string; message: string }>();
    expect(body.error).toBe("internal_error");
    expect(body.message).not.toContain("secret");
  });

  it("passes extra headers", () => {
    const response = errorResponse(new ValidationError("not_found"), { "x-min": "1" });
    expect(response.headers.get("x-min")).toBe("1");
  });
});
