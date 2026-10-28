import { describe, expect, it } from "vitest";
import { isSlug, parseAuthorization, parseToken } from "../../src/core/auth";

const KEY = "k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.SflKxw-_Rj";

function basic(value: string): string {
  return `Basic ${btoa(value)}`;
}

describe("isSlug", () => {
  it.each(["ab", "shop-frontend", "a1", "0-0", "a".repeat(63)])("accepts %j", (s) => {
    expect(isSlug(s)).toBe(true);
  });

  it.each(["", "a", "-ab", "Shop", "shop_frontend", "shop.frontend", "a".repeat(64)])(
    "rejects %j",
    (s) => {
      expect(isSlug(s)).toBe(false);
    },
  );
});

describe("parseToken", () => {
  it.each([
    [
      `shop-frontend:${KEY}`,
      "",
      { source: null, project: "shop-frontend", type: "key", secret: KEY, login: "shop-frontend" },
    ],
    [
      `ci-acme-sdk:gh.${JWT}`,
      "",
      { source: null, project: "ci-acme-sdk", type: "gh", secret: JWT, login: "ci-acme-sdk" },
    ],
    [
      `shop-frontend:key.${KEY}`,
      "",
      { source: null, project: "shop-frontend", type: "key", secret: KEY, login: "shop-frontend" },
    ],
    [
      `okta.shop-frontend:${KEY}`,
      "",
      {
        source: "okta",
        project: "shop-frontend",
        type: "key",
        secret: KEY,
        login: "okta.shop-frontend",
      },
    ],
    [
      `okta.ci-acme-sdk:gh.${JWT}`,
      "",
      {
        source: "okta",
        project: "ci-acme-sdk",
        type: "gh",
        secret: JWT,
        login: "okta.ci-acme-sdk",
      },
    ],
    [
      `srg_shop-frontend:${KEY}`,
      "srg_",
      { source: null, project: "shop-frontend", type: "key", secret: KEY, login: "shop-frontend" },
    ],
    [
      `shop-frontend:${KEY}`,
      "srg_",
      { source: null, project: "shop-frontend", type: "key", secret: KEY, login: "shop-frontend" },
    ],
  ])("parses %s (prefix %j)", (token, prefix, expected) => {
    expect(parseToken(token, prefix)).toEqual(expected);
  });

  it.each([
    ["", ""],
    [KEY, ""],
    ["shop-frontend", ""],
    [`:${KEY}`, ""],
    [`a.b.c:${KEY}`, ""],
    [`.shop:${KEY}`, ""],
    [`Shop:${KEY}`, ""],
    [`x:${KEY}`, ""],
    ["shop-frontend:", ""],
    ["shop-frontend:short", ""],
    [`shop-frontend:${KEY}x`, ""],
    [`shop-frontend:pw.${KEY}`, ""],
    [`shop-frontend:gh.${KEY}`, ""],
    ["shop-frontend:gh.not-a-jwt", ""],
    [`srg_shop-frontend:${KEY}`, ""],
    [`Okta.shop:${KEY}`, ""],
  ])("rejects %j (prefix %j)", (token, prefix) => {
    expect(parseToken(token, prefix)).toBeNull();
  });
});

describe("parseAuthorization", () => {
  const expected = {
    source: null,
    project: "shop-frontend",
    type: "key",
    secret: KEY,
    login: "shop-frontend",
  };
  const token = `shop-frontend:${KEY}`;

  it.each([
    ["Bearer", `Bearer ${token}`],
    ["lower-case bearer", `bearer ${token}`],
    ["Basic token", basic(token)],
    ["lower-case basic", `basic ${btoa(token)}`],
    ["Basic pasted", basic(`shop-frontend:${token}`)],
    ["raw", token],
    ["raw with whitespace", `  ${token} `],
  ])("accepts %s", (_, header) => {
    expect(parseAuthorization(header)).toEqual(expected);
  });

  it("accepts a gh token in every form", () => {
    const gh = `ci-acme-sdk:gh.${JWT}`;
    for (const header of [`Bearer ${gh}`, basic(gh), basic(`ci-acme-sdk:${gh}`), gh]) {
      expect(parseAuthorization(header)?.type).toBe("gh");
    }
  });

  it("handles TOKEN_PREFIX with and without the prefix", () => {
    const prefixed = `srg_${token}`;
    for (const header of [
      `Bearer ${prefixed}`,
      `Bearer ${token}`,
      basic(prefixed),
      basic(`shop-frontend:${prefixed}`),
      basic(`srg_shop-frontend:${prefixed}`),
      basic(`srg_shop-frontend:${token}`),
      prefixed,
    ]) {
      expect(parseAuthorization(header, "srg_"), header).toEqual(expected);
    }
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["Bearer without token", "Bearer"],
    ["Bearer with garbage", "Bearer nope"],
    ["Basic with bad base64", "Basic !!!"],
    ["Basic with invalid UTF-8", `Basic ${btoa("\xff\xfe:\xff")}`],
    ["Basic login mismatch", basic(`someone-else:${token}`)],
    ["Basic with only a login", basic("shop-frontend")],
    ["Basic with wrong secret format", basic("shop-frontend:short")],
    ["Digest scheme", `Digest ${token}`],
  ])("rejects %s", (_, header) => {
    expect(parseAuthorization(header)).toBeNull();
  });
});
