import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEND_WINDOW_HOURS,
  DEFAULT_BUCKET_NAME,
  appendWindowHours,
  enabledEcosystems,
  DEFAULT_MAX_UPLOAD_BYTES,
  maxUploadBytes,
  presignConfig,
  publicUrl,
  type PresignEnv,
} from "../../src/core/config";
import { ValidationError } from "../../src/core/errors";

const FULL: PresignEnv = {
  S3_ENDPOINT: "https://0123456789abcdef.r2.cloudflarestorage.com/",
  S3_ACCESS_KEY_ID: "access",
  S3_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET_NAME: "my-bucket",
};

describe("presignConfig", () => {
  it("reads the endpoint, bucket and key", () => {
    expect(presignConfig(FULL)).toEqual({
      endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
      bucket: "my-bucket",
      accessKeyId: "access",
      secretAccessKey: "secret",
    });
  });

  it("defaults the bucket name", () => {
    expect(presignConfig({ ...FULL, R2_BUCKET_NAME: "" }).bucket).toBe(DEFAULT_BUCKET_NAME);
  });

  it("uses the bucket name from wrangler.jsonc", () => {
    expect(env.R2_BUCKET_NAME).toBe("serverless-registry");
  });

  it("names every missing setting without leaking values", () => {
    let error: unknown;
    try {
      presignConfig({ R2_BUCKET_NAME: "b", S3_SECRET_ACCESS_KEY: "top-secret" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    const v = error as ValidationError;
    expect(v.code).toBe("internal_error");
    expect(v.status).toBe(500);
    expect(v.message).toContain("S3_ENDPOINT, S3_ACCESS_KEY_ID");
    expect(v.message).not.toContain("S3_SECRET_ACCESS_KEY");
    expect(v.message).not.toContain("top-secret");
  });

  it("treats blank values as missing", () => {
    expect(() => presignConfig({ ...FULL, S3_ACCESS_KEY_ID: "  " })).toThrow(/S3_ACCESS_KEY_ID/);
  });

  it("rejects an endpoint that is not a URL", () => {
    expect(() => presignConfig({ ...FULL, S3_ENDPOINT: "r2.example" })).toThrow(ValidationError);
    expect(() => presignConfig({ ...FULL, S3_ENDPOINT: "ftp://r2.example" })).toThrow(
      /http\(s\) URL/,
    );
  });
});

describe("publicUrl", () => {
  const request = new Request("https://worker.example.workers.dev/api/v1/version");

  it("prefers PUBLIC_URL without trailing slashes", () => {
    expect(publicUrl({ PUBLIC_URL: "https://packages.example.com//" }, request)).toBe(
      "https://packages.example.com",
    );
  });

  it.each([undefined, "", "  "])("falls back to the request origin for %j", (value) => {
    expect(publicUrl({ PUBLIC_URL: value }, request)).toBe("https://worker.example.workers.dev");
  });
});

describe("maxUploadBytes", () => {
  it("parses the variable", () => {
    expect(maxUploadBytes({ MAX_UPLOAD_BYTES: "1048576" })).toBe(1048576);
    expect(maxUploadBytes(env)).toBe(536870912);
  });

  it.each(["", "0", "-1", "1e9", "12MB", "99999999999999999999"])(
    "falls back to the default for %j",
    (value) => {
      expect(maxUploadBytes({ MAX_UPLOAD_BYTES: value })).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    },
  );
});

describe("enabledEcosystems", () => {
  it("enables every ecosystem by default", () => {
    expect(enabledEcosystems(env)).toEqual(["composer", "npm", "cargo", "generic", "nuget"]);
    expect(enabledEcosystems({ ECOSYSTEMS: " " })).toEqual([
      "composer",
      "npm",
      "cargo",
      "generic",
      "nuget",
    ]);
  });

  it("parses a list, ignoring unknown names, case and duplicates", () => {
    expect(enabledEcosystems({ ECOSYSTEMS: " Cargo, npm,pypi,npm ," })).toEqual(["npm", "cargo"]);
    expect(enabledEcosystems({ ECOSYSTEMS: "generic" })).toEqual(["generic"]);
    expect(enabledEcosystems({ ECOSYSTEMS: "NuGet,composer" })).toEqual(["composer", "nuget"]);
    expect(enabledEcosystems({ ECOSYSTEMS: "pypi" })).toEqual([]);
  });
});

describe("appendWindowHours", () => {
  it("parses the variable", () => {
    expect(appendWindowHours(env)).toBe(24);
    expect(appendWindowHours({ APPEND_WINDOW_HOURS: "72" })).toBe(72);
    expect(appendWindowHours({ APPEND_WINDOW_HOURS: "0" })).toBe(0);
  });

  it.each(["", "-1", "1.5", "a day", "99999999999999999999"])(
    "falls back to the default for %j",
    (value) => {
      expect(appendWindowHours({ APPEND_WINDOW_HOURS: value })).toBe(DEFAULT_APPEND_WINDOW_HOURS);
    },
  );
});
