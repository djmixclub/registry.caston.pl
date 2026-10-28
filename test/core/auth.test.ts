import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  GITHUB_ISSUER,
  GITHUB_JWKS_URL,
  authEntryId,
  authenticate,
  deleteCredential,
  formatToken,
  generateSecret,
  getCredential,
  hashSecret,
  isActive,
  isSlug,
  listCredentials,
  parseAuthorization,
  parseToken,
  putCredential,
  randomBase62,
  requireKind,
  sha256Hex,
  timingSafeEqual,
  toCredential,
  verifyGithubJwt,
  type AuthDeps,
  type AuthEnv,
  type CredentialRecord,
  type GhAuthRecord,
} from "../../src/core/auth";
import { ValidationError } from "../../src/core/errors";

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

// Fixed clock: 2026-10-28T10:00:00Z.
const NOW = Date.parse("2026-10-28T10:00:00Z");
const NOW_SEC = NOW / 1000;
const PUBLIC_URL = "https://registry.test";

function authEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return { AUTH: env.AUTH, PUBLIC_URL, TOKEN_PREFIX: "", ...overrides };
}

function request(authorization?: string): Request {
  const headers: Record<string, string> = authorization ? { authorization } : {};
  return new Request("https://registry.test/api/v1/whoami", { headers });
}

let projectCounter = 0;
function uniqueProject(base: string): string {
  projectCounter += 1;
  return `${base}-${projectCounter}`;
}

describe("secrets", () => {
  it("hashes with SHA-256", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await hashSecret("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("generates 32 base62 characters", () => {
    const secrets = new Set(Array.from({ length: 50 }, generateSecret));
    expect(secrets.size).toBe(50);
    for (const secret of secrets) expect(secret).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  it("uses the whole base62 alphabet", () => {
    const seen = new Set(randomBase62(20000));
    expect(seen.size).toBe(62);
  });

  it("formats tokens that parse back", () => {
    const secret = generateSecret();
    expect(formatToken("shop", secret)).toBe(`shop:${secret}`);
    expect(formatToken("shop", secret, "srg_")).toBe(`srg_shop:${secret}`);
    expect(parseToken(formatToken("shop", secret, "srg_"), "srg_")?.secret).toBe(secret);
  });

  it("compares strings in constant time", () => {
    expect(timingSafeEqual("sha256:abc", "sha256:abc")).toBe(true);
    expect(timingSafeEqual("sha256:abc", "sha256:abd")).toBe(false);
    expect(timingSafeEqual("sha256:abc", "sha256:ab")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("auth entries", () => {
  const key = {
    type: "key",
    hash: "sha256:3f9a1c0b7d2e11112222333344445555666677778888999900001111aaaabbbb",
    created: "2026-10-28T09:00:00Z",
    expires: null,
  } as const;
  const gh: GhAuthRecord = {
    type: "gh",
    repository: "acme/shop-frontend",
    ref: "refs/heads/main",
    workflow: null,
    created: "2026-10-28T09:05:00Z",
    expires: null,
  };

  it("derives the key id from the stored digest", async () => {
    expect(await authEntryId(key)).toBe("3f9a1c0b7d2e");
  });

  it("derives a stable gh id from its claims and creation time", async () => {
    const id = await authEntryId(gh);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(await authEntryId({ ...gh })).toBe(id);
    expect(await authEntryId({ ...gh, expires: "2027-01-01" })).toBe(id);
    expect(await authEntryId({ ...gh, ref: null })).not.toBe(id);
    expect(await authEntryId({ ...gh, workflow: "CI" })).not.toBe(id);
    expect(await authEntryId({ ...gh, created: "2026-10-29T00:00:00Z" })).not.toBe(id);
    expect(id).toBe(
      (await sha256Hex(JSON.stringify([gh.repository, gh.ref, gh.workflow, gh.created]))).slice(
        0,
        12,
      ),
    );
  });

  it.each([
    [null, true],
    ["2026-10-28T10:00:01Z", true],
    ["2026-10-28T10:00:00Z", false],
    ["2026-10-29", true],
    ["2026-10-28", false],
    ["not a date", false],
  ])("isActive with expires %j → %s", (expires, expected) => {
    expect(isActive({ ...key, expires }, NOW)).toBe(expected);
  });

  it("exposes ids instead of hashes", async () => {
    const credential = await toCredential({
      project: "shop",
      kind: "read",
      auth: [key, gh],
      grants: [{ eco: "npm", package: "@acme/sdk", versions: "^2.0" }],
    });
    expect(credential.auth[0]).toEqual({
      id: "3f9a1c0b7d2e",
      type: "key",
      created: key.created,
      expires: null,
    });
    expect(credential.auth[1]).toMatchObject({ type: "gh", repository: "acme/shop-frontend" });
    expect(JSON.stringify(credential)).not.toContain(key.hash);
  });

  it("hides grants of admin credentials", async () => {
    const credential = await toCredential({
      project: "root",
      kind: "admin",
      auth: [],
      grants: [{ eco: "npm", package: "*", versions: "*" }],
    });
    expect(credential.grants).toEqual([]);
  });
});

describe("credential storage", () => {
  it("writes, reads, lists and deletes records", async () => {
    const records: CredentialRecord[] = ["store-b", "store-a", "store-c"].map((project) => ({
      project,
      kind: "read",
      auth: [],
      grants: [],
    }));
    for (const record of records) await putCredential(env, record);
    await env.AUTH.put("session:unrelated", "{}");

    expect(await getCredential(env, "store-a")).toEqual(records[1]);
    expect(await env.AUTH.get("cred:store-a", "json")).toEqual(records[1]);
    const listed = (await listCredentials(env)).map((r) => r.project);
    expect(listed.filter((p) => p.startsWith("store-"))).toEqual(["store-a", "store-b", "store-c"]);

    await deleteCredential(env, "store-b");
    expect(await getCredential(env, "store-b")).toBeNull();
  });

  it("ignores malformed records", async () => {
    await env.AUTH.put("cred:broken", JSON.stringify({ project: "broken", kind: "root" }));
    await env.AUTH.put(
      "cred:mismatch",
      JSON.stringify({ project: "other", kind: "read", auth: [], grants: [] }),
    );
    await env.AUTH.put("cred:garbage", "not json at all");
    expect(await getCredential(env, "broken")).toBeNull();
    expect(await getCredential(env, "mismatch")).toBeNull();
    expect(await getCredential(env, "garbage")).toBeNull();
    await env.AUTH.delete("cred:garbage");
  });
});

describe("authenticate with key secrets", () => {
  const secret = "k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e";
  const oldSecret = "Q2w9Er7Ty5Ui3Op1As8Df6Gh4Jk2Lz0X";
  let project: string;
  let record: CredentialRecord;

  beforeEach(async () => {
    project = uniqueProject("shop");
    record = {
      project,
      kind: "read",
      auth: [
        { type: "key", hash: await hashSecret(secret), created: "2026-10-28", expires: null },
        {
          type: "key",
          hash: await hashSecret(oldSecret),
          created: "2026-06-01",
          expires: "2026-10-01T00:00:00Z",
        },
      ],
      grants: [{ eco: "npm", package: "@acme/sdk", versions: "^2.0" }],
    };
    await putCredential(env, record);
  });

  const deps: AuthDeps = { now: () => NOW };

  it("accepts a valid secret in every header form", async () => {
    const token = `${project}:${secret}`;
    for (const header of [
      `Bearer ${token}`,
      `Basic ${btoa(token)}`,
      `Basic ${btoa(`${project}:${token}`)}`,
      token,
    ]) {
      const result = await authenticate(request(header), authEnv(), deps);
      expect(result?.via).toBe("key");
      expect(result?.identity).toEqual({
        project,
        kind: "read",
        grants: record.grants,
        record,
        entryId: (await hashSecret(secret)).slice(7, 19),
      });
    }
  });

  it("accepts the prefixed and unprefixed token when TOKEN_PREFIX is set", async () => {
    const e = authEnv({ TOKEN_PREFIX: "srg_" });
    expect(await authenticate(request(`Bearer srg_${project}:${secret}`), e, deps)).not.toBeNull();
    expect(await authenticate(request(`Bearer ${project}:${secret}`), e, deps)).not.toBeNull();
  });

  it("rejects a wrong secret", async () => {
    const wrong = `${project}:${"A".repeat(32)}`;
    expect(await authenticate(request(`Bearer ${wrong}`), authEnv(), deps)).toBeNull();
  });

  it("rejects an expired entry and accepts it before expiry", async () => {
    const token = `Bearer ${project}:${oldSecret}`;
    expect(await authenticate(request(token), authEnv(), deps)).toBeNull();
    const before = { now: () => Date.parse("2026-09-30T00:00:00Z") };
    expect(await authenticate(request(token), authEnv(), before)).not.toBeNull();
  });

  it("rejects an unknown project, a missing header and a source", async () => {
    expect(await authenticate(request(`Bearer nobody-here:${secret}`), authEnv(), deps)).toBeNull();
    expect(await authenticate(request(), authEnv(), deps)).toBeNull();
    expect(
      await authenticate(request(`Bearer okta.${project}:${secret}`), authEnv(), deps),
    ).toBeNull();
  });

  it("rejects a key secret sent as gh and vice versa", async () => {
    expect(
      await authenticate(request(`Bearer ${project}:gh.${secret}`), authEnv(), deps),
    ).toBeNull();
  });

  it("returns no grants for admin", async () => {
    await putCredential(env, { ...record, kind: "admin" });
    const result = await authenticate(request(`Bearer ${project}:${secret}`), authEnv(), deps);
    expect(result?.identity.kind).toBe("admin");
    expect(result?.identity.grants).toEqual([]);
  });
});

describe("requireKind", () => {
  it("passes a listed kind", () => {
    expect(() => requireKind({ kind: "publish" }, "publish")).not.toThrow();
    expect(() => requireKind({ kind: "admin" }, "read", "admin")).not.toThrow();
  });

  it("throws forbidden otherwise", () => {
    let error: unknown;
    try {
      requireKind({ kind: "read" }, "publish", "admin");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("forbidden");
    expect((error as ValidationError).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------
// GitHub OIDC
// ---------------------------------------------------------------------------------------------

const KID = "test-key-1";
const ALGORITHM = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: { keys: JsonWebKey[] };

function base64Url(bytes: Uint8Array | ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signJwt(
  claims: Record<string, unknown>,
  options: { key?: CryptoKey; header?: Record<string, unknown> } = {},
): Promise<string> {
  const header = options.header ?? { alg: "RS256", typ: "JWT", kid: KID };
  const input = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    options.key ?? signingKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(signature)}`;
}

function githubClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: GITHUB_ISSUER,
    aud: PUBLIC_URL,
    sub: "repo:acme/shop-frontend:ref:refs/heads/main",
    repository: "acme/shop-frontend",
    ref: "refs/heads/main",
    workflow: "Release",
    iat: NOW_SEC - 30,
    nbf: NOW_SEC - 30,
    exp: NOW_SEC + 300,
    ...overrides,
  };
}

interface FakeFetch {
  fetch: typeof fetch;
  calls: string[];
}

function fakeFetch(body: () => unknown = () => jwks, status = 200): FakeFetch {
  const calls: string[] = [];
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url !== GITHUB_JWKS_URL) return new Response("not found", { status: 404 });
    return Response.json(body(), { status });
  };
  return { fetch: impl as typeof fetch, calls };
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(ALGORITHM, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const other = (await crypto.subtle.generateKey(ALGORITHM, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  otherKey = other.privateKey;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  jwks = {
    keys: [
      {
        kty: "RSA",
        n: publicJwk.n,
        e: publicJwk.e,
        alg: "RS256",
        use: "sig",
        kid: KID,
      } as JsonWebKey,
    ],
  };
});

describe("verifyGithubJwt", () => {
  beforeEach(async () => {
    await env.AUTH.delete("jwks:github");
  });

  it("verifies a valid token and caches the JWKS", async () => {
    const f = fakeFetch();
    const deps = { fetch: f.fetch, now: () => NOW };
    const claims = await verifyGithubJwt(authEnv(), await signJwt(githubClaims()), deps);
    expect(claims?.repository).toBe("acme/shop-frontend");
    expect(f.calls).toEqual([GITHUB_JWKS_URL]);

    expect(await env.AUTH.get("jwks:github", "json")).toMatchObject({ keys: jwks.keys });
    const again = await signJwt(githubClaims({ workflow: "Other" }));
    expect(await verifyGithubJwt(authEnv(), again, deps)).not.toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it("accepts an audience list and a PUBLIC_URL with a trailing slash", async () => {
    const deps = { fetch: fakeFetch().fetch, now: () => NOW };
    const jwt = await signJwt(githubClaims({ aud: ["other", PUBLIC_URL] }));
    expect(
      await verifyGithubJwt(authEnv({ PUBLIC_URL: `${PUBLIC_URL}/` }), jwt, deps),
    ).not.toBeNull();
  });

  it.each([
    ["wrong audience", githubClaims({ aud: "https://elsewhere.test" })],
    ["wrong issuer", githubClaims({ iss: "https://evil.test" })],
    ["expired", githubClaims({ exp: NOW_SEC - 1 })],
    ["expiring now", githubClaims({ exp: NOW_SEC })],
    ["not yet valid", githubClaims({ nbf: NOW_SEC + 120 })],
    ["missing exp", githubClaims({ exp: undefined })],
    ["missing repository", githubClaims({ repository: undefined })],
  ])("rejects a token with %s", async (_, claims) => {
    const deps = { fetch: fakeFetch().fetch, now: () => NOW };
    expect(await verifyGithubJwt(authEnv(), await signJwt(claims), deps)).toBeNull();
  });

  it("tolerates small clock skew on nbf", async () => {
    const deps = { fetch: fakeFetch().fetch, now: () => NOW };
    const jwt = await signJwt(githubClaims({ nbf: NOW_SEC + 30 }));
    expect(await verifyGithubJwt(authEnv(), jwt, deps)).not.toBeNull();
  });

  it("rejects a bad signature", async () => {
    const deps = { fetch: fakeFetch().fetch, now: () => NOW };
    expect(
      await verifyGithubJwt(authEnv(), await signJwt(githubClaims(), { key: otherKey }), deps),
    ).toBeNull();

    const [h, , sig] = (await signJwt(githubClaims())).split(".");
    const forged = `${h}.${encodeJson(githubClaims({ repository: "evil/repo" }))}.${sig}`;
    expect(await verifyGithubJwt(authEnv(), forged, deps)).toBeNull();
  });

  it.each([
    ["alg none", { alg: "none", kid: KID }],
    ["alg HS256", { alg: "HS256", kid: KID }],
    ["no kid", { alg: "RS256" }],
    ["unknown kid", { alg: "RS256", kid: "other" }],
  ])("rejects %s", async (_, header) => {
    const deps = { fetch: fakeFetch().fetch, now: () => NOW };
    expect(
      await verifyGithubJwt(authEnv(), await signJwt(githubClaims(), { header }), deps),
    ).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    const deps = { fetch: fakeFetch().fetch, now: () => NOW };
    for (const jwt of ["", "a.b", "a.b.c", "!!.??.**", `${encodeJson({ alg: "RS256" })}.x.y`]) {
      expect(await verifyGithubJwt(authEnv(), jwt, deps)).toBeNull();
    }
  });

  it("refuses to verify without PUBLIC_URL", async () => {
    const f = fakeFetch();
    const jwt = await signJwt(githubClaims());
    expect(
      await verifyGithubJwt(authEnv({ PUBLIC_URL: undefined }), jwt, {
        fetch: f.fetch,
        now: () => NOW,
      }),
    ).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it("fails closed when the JWKS cannot be fetched", async () => {
    const jwt = await signJwt(githubClaims());
    const down = fakeFetch(() => ({ error: "down" }), 503);
    expect(await verifyGithubJwt(authEnv(), jwt, { fetch: down.fetch, now: () => NOW })).toBeNull();
    const throwing = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await verifyGithubJwt(authEnv(), jwt, { fetch: throwing, now: () => NOW })).toBeNull();
    expect(await env.AUTH.get("jwks:github")).toBeNull();
  });

  it("refetches the JWKS for an unknown kid after the refresh interval", async () => {
    // A stale cache that does not contain the signing key yet (GitHub rotated keys).
    await env.AUTH.put("jwks:github", JSON.stringify({ keys: [], fetchedAt: NOW - 10 * 60_000 }));
    const f = fakeFetch();
    const jwt = await signJwt(githubClaims());
    expect(
      await verifyGithubJwt(authEnv(), jwt, { fetch: f.fetch, now: () => NOW }),
    ).not.toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it("does not refetch the JWKS for an unknown kid right after a fetch", async () => {
    await env.AUTH.put("jwks:github", JSON.stringify({ keys: [], fetchedAt: NOW - 60_000 }));
    const f = fakeFetch();
    const jwt = await signJwt(githubClaims());
    expect(await verifyGithubJwt(authEnv(), jwt, { fetch: f.fetch, now: () => NOW })).toBeNull();
    expect(f.calls).toEqual([]);
  });
});

describe("authenticate with gh secrets", () => {
  let project: string;
  let record: CredentialRecord;
  let f: FakeFetch;
  let deps: AuthDeps;

  const entry = (overrides: Partial<GhAuthRecord> = {}): GhAuthRecord => ({
    type: "gh",
    repository: "acme/shop-frontend",
    ref: "refs/heads/main",
    workflow: null,
    created: "2026-10-28T09:05:00Z",
    expires: null,
    ...overrides,
  });

  beforeEach(async () => {
    await env.AUTH.delete("jwks:github");
    project = uniqueProject("ci");
    record = { project, kind: "publish", auth: [entry()], grants: [] };
    await putCredential(env, record);
    f = fakeFetch();
    deps = { fetch: f.fetch, now: () => NOW };
  });

  const bearer = (jwt: string) => request(`Bearer ${project}:gh.${jwt}`);

  it("authenticates a matching token and caches the verification", async () => {
    const jwt = await signJwt(githubClaims());
    const result = await authenticate(bearer(jwt), authEnv(), deps);
    expect(result?.via).toBe("gh");
    expect(result?.identity.project).toBe(project);
    expect(result?.identity.kind).toBe("publish");
    expect(result?.identity.entryId).toBe(await authEntryId(entry()));

    const cached = await env.AUTH.get(`ghok:${await sha256Hex(jwt)}`, "json");
    expect(cached).toEqual({ project, entryId: await authEntryId(entry()), exp: NOW_SEC + 300 });
  });

  it("uses the cached verification without checking the signature again", async () => {
    const jwt = await signJwt(githubClaims());
    expect(await authenticate(bearer(jwt), authEnv(), deps)).not.toBeNull();
    await env.AUTH.delete("jwks:github");

    const failing = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const result = await authenticate(bearer(jwt), authEnv(), { fetch: failing, now: () => NOW });
    expect(result?.via).toBe("gh");
    expect(f.calls).toHaveLength(1);
  });

  it("does not trust the cache once the entry expired or the token expired", async () => {
    const jwt = await signJwt(githubClaims());
    expect(await authenticate(bearer(jwt), authEnv(), deps)).not.toBeNull();

    await putCredential(env, { ...record, auth: [entry({ expires: "2026-10-28T09:59:00Z" })] });
    expect(await authenticate(bearer(jwt), authEnv(), deps)).toBeNull();

    await putCredential(env, record);
    const later = { fetch: f.fetch, now: () => NOW + 301_000 };
    expect(await authenticate(bearer(jwt), authEnv(), later)).toBeNull();
  });

  it("does not cache a token that expires within a minute", async () => {
    const jwt = await signJwt(githubClaims({ exp: NOW_SEC + 30 }));
    expect(await authenticate(bearer(jwt), authEnv(), deps)).not.toBeNull();
    expect(await env.AUTH.get(`ghok:${await sha256Hex(jwt)}`)).toBeNull();
  });

  it("does not reuse a cached verification for another project", async () => {
    const jwt = await signJwt(githubClaims());
    expect(await authenticate(bearer(jwt), authEnv(), deps)).not.toBeNull();
    const other = uniqueProject("ci-other");
    await putCredential(env, {
      project: other,
      kind: "read",
      auth: [entry({ repository: "acme/other" })],
      grants: [],
    });
    expect(await authenticate(request(`Bearer ${other}:gh.${jwt}`), authEnv(), deps)).toBeNull();
  });

  it("rejects a wrong repository", async () => {
    const jwt = await signJwt(githubClaims({ repository: "acme/other" }));
    expect(await authenticate(bearer(jwt), authEnv(), deps)).toBeNull();
  });

  it("rejects a wrong audience", async () => {
    const jwt = await signJwt(githubClaims({ aud: "https://elsewhere.test" }));
    expect(await authenticate(bearer(jwt), authEnv(), deps)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const jwt = await signJwt(githubClaims({ exp: NOW_SEC - 10 }));
    expect(await authenticate(bearer(jwt), authEnv(), deps)).toBeNull();
  });

  it("rejects a bad signature", async () => {
    const jwt = await signJwt(githubClaims(), { key: otherKey });
    expect(await authenticate(bearer(jwt), authEnv(), deps)).toBeNull();
  });

  it("matches ref exactly when set and any ref when null", async () => {
    const tag = await signJwt(githubClaims({ ref: "refs/tags/v1.0.0" }));
    expect(await authenticate(bearer(tag), authEnv(), deps)).toBeNull();

    await putCredential(env, { ...record, auth: [entry({ ref: null })] });
    expect(await authenticate(bearer(tag), authEnv(), deps)).not.toBeNull();
  });

  it("matches workflow exactly when set", async () => {
    await putCredential(env, { ...record, auth: [entry({ workflow: "Release" })] });
    expect(
      await authenticate(bearer(await signJwt(githubClaims())), authEnv(), deps),
    ).not.toBeNull();
    const other = await signJwt(githubClaims({ workflow: "Nightly" }));
    expect(await authenticate(bearer(other), authEnv(), deps)).toBeNull();
  });

  it("ignores expired gh entries and picks an active match", async () => {
    const expired = entry({ expires: "2026-10-01" });
    const active = entry({ ref: null, created: "2026-10-27T00:00:00Z" });
    await putCredential(env, { ...record, auth: [expired, active] });
    const result = await authenticate(bearer(await signJwt(githubClaims())), authEnv(), deps);
    expect(result?.identity.entryId).toBe(await authEntryId(active));
  });

  it("does not accept a JWT against key entries", async () => {
    await putCredential(env, {
      ...record,
      auth: [{ type: "key", hash: await hashSecret("x"), created: "2026-10-28", expires: null }],
    });
    expect(await authenticate(bearer(await signJwt(githubClaims())), authEnv(), deps)).toBeNull();
  });
});
