import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEND_WINDOW_HOURS,
  DEFAULT_BUCKET_NAME,
  DEFAULT_CHECK_UPDATES,
  DEFAULT_MAX_PUBLISH_SCOPES,
  DEFAULT_TOKEN_PREFIX,
  appendWindowHours,
  checkUpdates,
  enabledEcosystems,
  DEFAULT_MAX_UPLOAD_BYTES,
  maxPublishScopes,
  maxUploadBytes,
  missingRequired,
  presignConfig,
  publicUrl,
  setupStatus,
  tokenPrefix,
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

  it("defaults to the bucket_name in wrangler.jsonc when R2_BUCKET_NAME is unset", () => {
    const unset: PresignEnv = { ...FULL };
    delete unset.R2_BUCKET_NAME;
    expect(presignConfig(unset).bucket).toBe("serverless-registry");
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
    const all = ["composer", "npm", "cargo", "generic", "nuget", "swift", "maven"];
    expect(enabledEcosystems(env)).toEqual(all);
    expect(enabledEcosystems({ ECOSYSTEMS: " " })).toEqual(all);
  });

  it("parses a list, ignoring unknown names, case and duplicates", () => {
    expect(enabledEcosystems({ ECOSYSTEMS: " Cargo, npm,pypi,npm ," })).toEqual(["npm", "cargo"]);
    expect(enabledEcosystems({ ECOSYSTEMS: "generic" })).toEqual(["generic"]);
    expect(enabledEcosystems({ ECOSYSTEMS: "NuGet,composer" })).toEqual(["composer", "nuget"]);
    expect(enabledEcosystems({ ECOSYSTEMS: "pypi" })).toEqual([]);
    expect(enabledEcosystems({ ECOSYSTEMS: "maven,Swift" })).toEqual(["swift", "maven"]);
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

describe("maxPublishScopes", () => {
  it("parses the variable", () => {
    expect(maxPublishScopes({})).toBe(DEFAULT_MAX_PUBLISH_SCOPES);
    expect(maxPublishScopes({ MAX_PUBLISH_SCOPES: "1" })).toBe(1);
    expect(maxPublishScopes({ MAX_PUBLISH_SCOPES: " 50 " })).toBe(50);
    expect(maxPublishScopes({ MAX_PUBLISH_SCOPES: "100" })).toBe(100);
  });

  it.each(["", "0", "101", "-1", "1.5", "many"])("falls back to the default for %j", (value) => {
    expect(maxPublishScopes({ MAX_PUBLISH_SCOPES: value })).toBe(DEFAULT_MAX_PUBLISH_SCOPES);
  });
});

describe("defaults of unset settings", () => {
  it("has a default for every optional setting", () => {
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(536870912);
    expect(DEFAULT_APPEND_WINDOW_HOURS).toBe(24);
    expect(DEFAULT_MAX_PUBLISH_SCOPES).toBe(20);
    expect(DEFAULT_TOKEN_PREFIX).toBe("");
    expect(DEFAULT_CHECK_UPDATES).toBe(true);
    expect(DEFAULT_BUCKET_NAME).toBe("serverless-registry");
  });

  it("applies the defaults when nothing is set", () => {
    expect(maxUploadBytes({})).toBe(536870912);
    expect(appendWindowHours({})).toBe(24);
    expect(tokenPrefix({})).toBe("");
    expect(checkUpdates({})).toBe(true);
    expect(enabledEcosystems({})).toEqual([
      "composer",
      "npm",
      "cargo",
      "generic",
      "nuget",
      "swift",
      "maven",
    ]);
  });
});

describe("tokenPrefix", () => {
  it("returns the configured prefix", () => {
    expect(tokenPrefix({ TOKEN_PREFIX: "srg_" })).toBe("srg_");
    expect(tokenPrefix({ TOKEN_PREFIX: "" })).toBe("");
  });
});

describe("checkUpdates", () => {
  it("is enabled when unset, blank or true", () => {
    expect(checkUpdates({ CHECK_UPDATES: "" })).toBe(true);
    expect(checkUpdates({ CHECK_UPDATES: "  " })).toBe(true);
    expect(checkUpdates({ CHECK_UPDATES: " TRUE " })).toBe(true);
  });

  it.each(["false", "0", "no", "off"])("is disabled by %j", (value) => {
    expect(checkUpdates({ CHECK_UPDATES: value })).toBe(false);
  });
});

describe("setupStatus", () => {
  it("lists the settings by level and whether they are present", () => {
    const items = setupStatus({
      SESSION_SECRET: "a-session-secret",
      S3_ENDPOINT: " ",
      S3_ACCESS_KEY_ID: "an-access-key",
      TOKEN_PREFIX: "srg_",
    });
    const by = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(items.map((i) => i.name)).toEqual([
      "SESSION_SECRET",
      "S3_ENDPOINT",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "PUBLIC_URL",
      "ECOSYSTEMS",
      "MAX_UPLOAD_BYTES",
      "APPEND_WINDOW_HOURS",
      "TOKEN_PREFIX",
      "LOGIN_TOKEN_EXTENDED_TTL_HOURS",
      "MAX_PUBLISH_SCOPES",
      "CHECK_UPDATES",
      "R2_BUCKET_NAME",
    ]);
    expect(by.SESSION_SECRET).toMatchObject({ level: "required", set: true, secret: true });
    expect(by.S3_ENDPOINT).toMatchObject({ level: "required", set: false, secret: false });
    expect(by.S3_SECRET_ACCESS_KEY).toMatchObject({ set: false, docsAnchor: "r2-api-token-s3_" });
    expect(by.PUBLIC_URL).toMatchObject({ level: "recommended", set: false });
    expect(by.TOKEN_PREFIX).toMatchObject({ level: "optional", set: true, default: "" });
    expect(by.MAX_UPLOAD_BYTES).toMatchObject({ set: false, default: "536870912" });
    expect(missingRequired(items).map((i) => i.name)).toEqual([
      "S3_ENDPOINT",
      "S3_SECRET_ACCESS_KEY",
    ]);
  });

  it("never carries a value", () => {
    const env = {
      SESSION_SECRET: "session-secret-value",
      S3_ACCESS_KEY_ID: "access-key-value",
      S3_SECRET_ACCESS_KEY: "secret-key-value",
      PUBLIC_URL: "https://registry.internal.example",
      TOKEN_PREFIX: "srgprefix_",
    };
    const text = JSON.stringify(setupStatus(env));
    for (const value of Object.values(env)) expect(text).not.toContain(value);
  });
});
