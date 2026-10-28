import { describe, expect, it } from "vitest";
import {
  NPM_NAME_RE,
  defaultTag,
  distTags,
  isValidTag,
  npmAdapter as adapter,
  tarballName,
} from "../../src/adapters/npm/index";
import type { IndexRoute, Manifest, PublishInit } from "../../src/adapters/types";
import { ValidationError } from "../../src/core/errors";
import fixture from "../fixtures/npm/package.json";

const BASE = "https://packages.example.com";
const SHA = "9f2c4e0a1b3d5f7092a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8";
const NAME = "@acme/http-client";

function init(overrides: Partial<PublishInit> = {}): PublishInit {
  return {
    eco: "npm",
    name: NAME,
    version: "2.1.0",
    files: [{ name: "http-client-2.1.0.tgz", size: 48213, sha256: SHA }],
    manifest: structuredClone(fixture) as Record<string, unknown>,
    ...overrides,
  };
}

function manifest(version: string, tag?: string, yanked = false, published = ""): Manifest {
  return {
    eco: "npm",
    name: "@acme/x",
    version,
    files: [{ name: `x-${version}.tgz`, size: 10, sha256: SHA, role: "archive" }],
    published:
      published || `2026-10-${String(10 + Number(version[0] ?? 0)).padStart(2, "0")}T10:00:00Z`,
    publishedBy: "ci-acme",
    yanked,
    native: { name: "@acme/x", version, description: `x ${version}` },
    meta: { tag: tag ?? defaultTag(version) },
  };
}

function rejects(fn: () => unknown, code = "invalid_request"): void {
  let error: unknown;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).code).toBe(code);
}

type Json = Record<string, unknown>;

function packument(manifests: Manifest[]): Json {
  const files = adapter.buildIndex("@acme/x", manifests, { publicUrl: BASE });
  expect(files).toHaveLength(1);
  return JSON.parse(files[0]?.body ?? "") as Json;
}

function without<T extends object>(value: T, key: string): T {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key)) as T;
}

const everything = (): boolean => true;

function serve(
  body: unknown,
  allowed: (name: string, version: string) => boolean = everything,
  route?: IndexRoute,
) {
  return adapter.filterIndex(body, allowed, route) as Json | null;
}

describe("npm versions and ranges", () => {
  it.each(["1.0.0", "0.0.1", "10.20.30", "1.0.0-beta.1", "2.0.0-rc.1"])("accepts %s", (v) =>
    expect(adapter.validateVersion(v)).toBe(true),
  );

  it.each(["1.0", "v1.0.0", "01.0.0", "1.0.0+build", "1.0.0-", "latest", ""])("rejects %s", (v) =>
    expect(adapter.validateVersion(v)).toBe(false),
  );

  it("orders versions by semver precedence", () => {
    const sorted = ["2.0.0", "1.0.0-beta.2", "1.0.0", "1.0.0-beta.10", "1.0.0-alpha"].sort(
      adapter.compareVersions,
    );
    expect(sorted).toEqual(["1.0.0-alpha", "1.0.0-beta.2", "1.0.0-beta.10", "1.0.0", "2.0.0"]);
  });

  it("evaluates node-semver ranges", () => {
    expect(adapter.satisfies("2.3.1", "^2.0")).toBe(true);
    expect(adapter.satisfies("1.9.0", "^2.0")).toBe(false);
    expect(adapter.satisfies("1.5.0", ">=1.2.0 <3 || ^4")).toBe(true);
    expect(adapter.satisfies("2.0.0-beta.1", "^2.0.0-beta.0")).toBe(true);
    expect(adapter.satisfies("2.0.0-beta.1", "^1.0")).toBe(false);
    expect(adapter.validateRange("1.x || >=3.0.0")).toBe(true);
    expect(adapter.validateRange("latest")).toBe(false);
    expect(adapter.validateRange("workspace:^")).toBe(false);
  });
});

describe("dist-tag names", () => {
  it("accepts tag names that are not ranges", () => {
    for (const tag of ["latest", "next", "beta", "canary-2", "v1-lts", "release.candidate"]) {
      expect(isValidTag(tag)).toBe(true);
    }
  });

  it("rejects malformed tags and tags that are semver ranges", () => {
    for (const tag of ["", "Latest", "1beta", "x", "v1", "-beta", "a".repeat(65), "with space"]) {
      expect(isValidTag(tag)).toBe(false);
    }
  });

  it("defaults to next for prereleases and latest otherwise", () => {
    expect(defaultTag("1.0.0")).toBe("latest");
    expect(defaultTag("1.0.0-rc.1")).toBe("next");
  });
});

describe("parseManifest", () => {
  it("accepts a real package.json and records the default tag", () => {
    const m = adapter.parseManifest(init());
    expect(m).toMatchObject({
      eco: "npm",
      name: NAME,
      version: "2.1.0",
      yanked: false,
      files: [{ name: "http-client-2.1.0.tgz", size: 48213, sha256: SHA, role: "archive" }],
      meta: { tag: "latest" },
    });
    expect(m.native).toEqual(fixture);
  });

  it("records the requested tag, and next for a prerelease without one", () => {
    expect(adapter.parseManifest(init({ tag: "beta" })).meta).toEqual({ tag: "beta" });
    const pre = init({ version: "3.0.0-rc.1", manifest: { ...fixture, version: "3.0.0-rc.1" } });
    expect(adapter.parseManifest(pre).meta).toEqual({ tag: "next" });
    expect(adapter.parseManifest({ ...pre, tag: "latest" }).meta).toEqual({ tag: "latest" });
  });

  it("drops fields starting with an underscore", () => {
    const m = adapter.parseManifest(
      init({
        manifest: { ...fixture, _id: "x", _resolved: "file:x.tgz", _integrity: "sha1-x" },
      }),
    );
    expect(m.native).toEqual(fixture);
  });

  it("checks the package name", () => {
    expect(NPM_NAME_RE.test("@acme/a.b_c-d~e")).toBe(true);
    for (const name of [
      "http-client",
      "@Acme/http-client",
      "@acme/Http",
      "@acme/.hidden",
      "@acme/_private",
      "@acme/a/b",
      "@acme/",
      "@/x",
      `@acme/${"x".repeat(209)}`,
    ]) {
      rejects(() => adapter.parseManifest(init({ name, manifest: { ...fixture, name } })));
    }
    const long = `@acme/${"x".repeat(208)}`;
    expect(long).toHaveLength(214);
    expect(
      adapter.parseManifest(init({ name: long, manifest: { ...fixture, name: long } })).name,
    ).toBe(long);
  });

  it("requires name and version in package.json to match the request", () => {
    rejects(() => adapter.parseManifest(init({ manifest: { ...fixture, name: "@acme/other" } })));
    rejects(() => adapter.parseManifest(init({ manifest: { ...fixture, version: "2.0.0" } })));
    rejects(() => adapter.parseManifest(init({ manifest: without(fixture, "version") })));
    rejects(() =>
      adapter.parseManifest(init({ manifest: [] as unknown as Record<string, unknown> })),
    );
  });

  it("checks the version and the tag", () => {
    rejects(() => adapter.parseManifest(init({ version: "2.1.0+b1" })));
    rejects(() => adapter.parseManifest(init({ tag: "v2" })));
    rejects(() => adapter.parseManifest(init({ tag: "Beta" })));
  });

  it("requires exactly one .tgz archive", () => {
    const file = { name: "a.tgz", size: 1, sha256: SHA };
    expect(adapter.parseManifest(init({ files: [{ ...file, role: "archive" }] })).files).toEqual([
      { ...file, role: "archive" },
    ]);
    rejects(() => adapter.parseManifest(init({ files: [file, { ...file, name: "b.tgz" }] })));
    rejects(() => adapter.parseManifest(init({ files: [{ ...file, name: "a.zip" }] })));
    rejects(() => adapter.parseManifest(init({ files: [{ ...file, role: "attestation" }] })));
  });
});

describe("fileKey and URLs", () => {
  it("stores files under the encoded name and serves them at the registry tarball URL", () => {
    const m = adapter.parseManifest(init());
    const file = m.files[0];
    if (file === undefined) throw new Error("no file");
    expect(adapter.fileKey(m, file)).toBe("npm/pkg/@acme__http-client/2.1.0/http-client-2.1.0.tgz");
    const url = `${BASE}/npm/@acme/http-client/-/http-client-2.1.0.tgz`;
    expect(adapter.versionUrl(m, BASE)).toBe(url);
    expect(adapter.fileUrl(m, file, BASE)).toBe(url);
    expect(tarballName("@acme/sdk", "1.0.0-rc.1")).toBe("sdk-1.0.0-rc.1.tgz");
  });
});

describe("distTags", () => {
  const e = (version: string, tag = defaultTag(version)) => ({ version, tag });

  it("points every requested tag at its highest version", () => {
    expect(
      distTags([e("1.0.0"), e("2.0.0"), e("1.5.0"), e("3.0.0-beta.1", "beta"), e("3.0.0-rc.1")]),
    ).toEqual({ beta: "3.0.0-beta.1", latest: "2.0.0", next: "3.0.0-rc.1" });
  });

  it("falls back to the highest stable version for latest and prerelease for next", () => {
    expect(distTags([e("1.0.0", "lts"), e("2.0.0-beta.1", "beta")])).toEqual({
      beta: "2.0.0-beta.1",
      latest: "1.0.0",
      lts: "1.0.0",
      next: "2.0.0-beta.1",
    });
    expect(distTags([e("1.0.0", "lts"), e("2.0.0", "lts")])).toEqual({
      latest: "2.0.0",
      lts: "2.0.0",
    });
  });

  it("keeps an explicit latest on a lower version or a prerelease", () => {
    expect(distTags([e("1.0.0"), e("2.0.0", "canary")])).toEqual({
      canary: "2.0.0",
      latest: "1.0.0",
    });
    expect(distTags([e("1.0.0"), e("2.0.0-rc.1", "latest")])).toEqual({
      latest: "2.0.0-rc.1",
      next: "2.0.0-rc.1",
    });
  });

  it("is empty without versions", () => {
    expect(distTags([])).toEqual({});
  });
});

describe("buildIndex", () => {
  it("writes the packument with dist, integrity, time and dist-tags", () => {
    const files = adapter.buildIndex(
      "@acme/x",
      [manifest("1.0.0"), manifest("2.0.0"), manifest("3.0.0-rc.1")],
      { publicUrl: BASE },
    );
    expect(files.map((f) => [f.key, f.contentType])).toEqual([
      ["npm/index/@acme__x.json", "application/json"],
    ]);
    const body = JSON.parse(files[0]?.body ?? "") as Json;
    expect(Object.keys(body)).toEqual([
      "_id",
      "name",
      "dist-tags",
      "versions",
      "time",
      "_requestedTags",
    ]);
    expect(body._id).toBe("@acme/x");
    expect(body.name).toBe("@acme/x");
    expect(body["dist-tags"]).toEqual({ latest: "2.0.0", next: "3.0.0-rc.1" });
    expect(Object.keys(body.versions as Json)).toEqual(["1.0.0", "2.0.0", "3.0.0-rc.1"]);
    expect((body.versions as Json)["2.0.0"]).toEqual({
      name: "@acme/x",
      version: "2.0.0",
      description: "x 2.0.0",
      _id: "@acme/x@2.0.0",
      dist: {
        tarball: `${BASE}/npm/@acme/x/-/x-2.0.0.tgz`,
        integrity: "sha256-nyxOChs9X3CSpMbosNL0psjgstT2qMDitNb4oMLkttg=",
      },
    });
    expect(body.time).toEqual({
      created: "2026-10-11T10:00:00Z",
      modified: "2026-10-13T10:00:00Z",
      "1.0.0": "2026-10-11T10:00:00Z",
      "2.0.0": "2026-10-12T10:00:00Z",
      "3.0.0-rc.1": "2026-10-13T10:00:00Z",
    });
    expect(body._requestedTags).toEqual({
      "1.0.0": "latest",
      "2.0.0": "latest",
      "3.0.0-rc.1": "next",
    });
  });

  it("omits yanked versions and moves their tags", () => {
    const body = packument([
      manifest("1.0.0"),
      manifest("1.1.0", "lts"),
      manifest("2.0.0", undefined, true),
      manifest("3.0.0-rc.1", undefined, true),
      manifest("3.0.0-beta.1", "beta", true),
    ]);
    expect(Object.keys(body.versions as Json)).toEqual(["1.0.0", "1.1.0"]);
    expect(body["dist-tags"]).toEqual({ latest: "1.0.0", lts: "1.1.0" });
    expect(Object.keys(body.time as Json)).toEqual(["created", "modified", "1.0.0", "1.1.0"]);
  });

  it("derives the default tag for manifests without meta", () => {
    const plain = without(manifest("1.0.0"), "meta");
    expect(packument([plain])["dist-tags"]).toEqual({ latest: "1.0.0" });
  });

  it("writes an empty packument when every version is yanked", () => {
    const body = packument([manifest("1.0.0", undefined, true)]);
    expect(body).toMatchObject({ versions: {}, "dist-tags": {}, time: {} });
  });
});

describe("filterIndex", () => {
  const full = packument([
    manifest("1.0.0"),
    manifest("1.2.0"),
    manifest("2.0.0"),
    manifest("2.1.0", "beta"),
    manifest("3.0.0-rc.1"),
  ]);
  const below2 = (_name: string, version: string) => version.startsWith("1.");

  it("keeps the allowed versions and recomputes dist-tags and time", () => {
    const body = serve(full, below2);
    expect(body).toEqual({
      _id: "@acme/x",
      name: "@acme/x",
      "dist-tags": { latest: "1.2.0" },
      versions: {
        "1.0.0": (full.versions as Json)["1.0.0"],
        "1.2.0": (full.versions as Json)["1.2.0"],
      },
      time: {
        created: "2026-10-11T10:00:00Z",
        modified: "2026-10-11T10:00:00Z",
        "1.0.0": "2026-10-11T10:00:00Z",
        "1.2.0": "2026-10-11T10:00:00Z",
      },
    });
  });

  it("serves the whole packument without the private requested tags", () => {
    const body = serve(full);
    expect(body?._requestedTags).toBeUndefined();
    expect(body?.["dist-tags"]).toEqual({ beta: "2.1.0", latest: "2.0.0", next: "3.0.0-rc.1" });
  });

  it("passes the package name and version to the predicate", () => {
    const seen: string[] = [];
    serve(full, (name, version) => {
      seen.push(`${name}@${version}`);
      return true;
    });
    expect(seen).toEqual([
      "@acme/x@1.0.0",
      "@acme/x@1.2.0",
      "@acme/x@2.0.0",
      "@acme/x@2.1.0",
      "@acme/x@3.0.0-rc.1",
    ]);
  });

  it("returns an empty packument when nothing is allowed", () => {
    expect(serve(full, () => false)).toEqual({
      _id: "@acme/x",
      name: "@acme/x",
      "dist-tags": {},
      versions: {},
      time: {},
    });
  });

  it("selects one version or the version a dist-tag points at", () => {
    const route = (version: string): IndexRoute => ({
      kind: "index",
      key: "npm/index/@acme__x.json",
      name: "@acme/x",
      version,
    });
    expect(serve(full, undefined, route("1.2.0"))).toEqual((full.versions as Json)["1.2.0"]);
    expect(serve(full, undefined, route("beta"))).toEqual((full.versions as Json)["2.1.0"]);
    expect(serve(full, below2, route("latest"))).toEqual((full.versions as Json)["1.2.0"]);
    expect(serve(full, below2, route("2.0.0"))).toBeNull();
    expect(serve(full, below2, route("beta"))).toBeNull();
    expect(serve(full, undefined, route("9.9.9"))).toBeNull();
  });

  it("falls back to default tags and leaves other bodies alone", () => {
    const plain = without(full, "_requestedTags");
    expect(serve(plain)?.["dist-tags"]).toEqual({ latest: "2.1.0", next: "3.0.0-rc.1" });
    expect(serve({ versions: [] })).toEqual({ versions: [] });
    expect(serve("text")).toBe("text");
  });
});

describe("route", () => {
  const route = (path: string, method = "GET") => {
    const url = new URL(`${BASE}${path}`);
    return adapter.route(new Request(url, { method }), url);
  };
  const index = { kind: "index", key: "npm/index/@acme__http-client.json", name: NAME };

  it("routes ping and whoami", () => {
    expect(route("/npm/-/ping")).toEqual({ kind: "static", body: {} });
    expect(route("/npm/-/whoami")).toEqual({ kind: "whoami" });
  });

  it.each([
    "/npm/@acme%2fhttp-client",
    "/npm/@acme%2Fhttp-client",
    "/npm/%40acme%2Fhttp-client",
    "/npm/@acme/http-client",
    "/npm/%40acme/http-client",
  ])("routes the packument at %s", (path) => {
    expect(route(path)).toEqual(index);
    expect(route(path, "HEAD")).toEqual(index);
  });

  it("routes single versions and dist-tags", () => {
    expect(route("/npm/@acme/http-client/2.1.0")).toEqual({ ...index, version: "2.1.0" });
    expect(route("/npm/@acme%2fhttp-client/3.0.0-rc.1")).toEqual({
      ...index,
      version: "3.0.0-rc.1",
    });
    expect(route("/npm/@acme/http-client/latest")).toEqual({ ...index, version: "latest" });
  });

  it("routes tarballs by their registry and npm pack names", () => {
    const archive = { kind: "archive", name: NAME, version: "2.1.0", file: null };
    expect(route("/npm/@acme/http-client/-/http-client-2.1.0.tgz")).toEqual(archive);
    expect(route("/npm/@acme%2fhttp-client/-/http-client-2.1.0.tgz")).toEqual(archive);
    expect(route("/npm/@acme/http-client/-/acme-http-client-2.1.0.tgz")).toEqual(archive);
    expect(route("/npm/@acme/http-client/-/http-client-3.0.0-rc.1.tgz")).toEqual({
      ...archive,
      version: "3.0.0-rc.1",
    });
  });

  it.each([
    "/npm",
    "/npm/",
    "/npm/-/v1/search",
    "/npm/-/npm/v1/security/advisories/bulk",
    "/npm/http-client",
    "/npm/@acme",
    "/npm/@Acme/http-client",
    "/npm/@acme/http-client/",
    "/npm/@acme/http-client/v2",
    "/npm/@acme/http-client/2.1.0/x",
    "/npm/@acme/http-client/-/other-2.1.0.tgz",
    "/npm/@acme/http-client/-/http-client-2.1.tgz",
    "/npm/@acme/http-client/-/http-client-2.1.0.zip",
    "/npm/@acme%2fhttp-client/-/x/y",
    "/npm/@acme%zz/x",
    "/composer/packages.json",
  ])("does not route %s", (path) => expect(route(path)).toBeNull());

  it("routes reads only", () => {
    expect(route("/npm/@acme/http-client", "PUT")).toBeNull();
    expect(route("/npm/-/ping", "POST")).toBeNull();
  });
});

describe("dependencies", () => {
  it("takes every dependency section of the real package.json", () => {
    expect(adapter.dependencies(adapter.parseManifest(init()))).toEqual([
      { name: "@acme/retry", constraint: "^1.4.0" },
      { name: "@acme/cache", constraint: "~2.0.1" },
      { name: "undici", constraint: "^6.19.8" },
      { name: "@types/node", constraint: "^20.14.10" },
      { name: "tsup", constraint: "^8.2.4" },
      { name: "typescript", constraint: "^5.5.4" },
      { name: "vitest", constraint: "^2.0.5" },
      { name: "@acme/logger", constraint: ">=1.2.0 <3" },
      { name: "typescript", constraint: ">=5.0" },
      { name: "@acme/metrics", constraint: "1.x" },
    ]);
  });

  it("skips specifiers that are not ranges and non-string values", () => {
    const m = manifest("1.0.0");
    m.native = {
      dependencies: {
        "@acme/a": "file:../a",
        "@acme/b": "git+https://github.com/acme/b.git",
        "@acme/c": "workspace:*",
        "@acme/d": "npm:@acme/e@^1.0",
        "@acme/f": "latest",
        "@acme/g": "https://example.com/g.tgz",
        "@acme/h": 1,
        "@acme/i": "*",
      },
      devDependencies: ["@acme/j"],
    };
    expect(adapter.dependencies(m)).toEqual([{ name: "@acme/i", constraint: "*" }]);
  });
});

describe("clientConfig", () => {
  const token = "shop-frontend:k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e";

  it("renders .npmrc with a registry per scope, the token and the Basic variant", () => {
    const snippets = adapter.clientConfig(`${BASE}/`, token, [
      "@acme/sdk",
      "@tools/cli",
      "@acme/http-client",
    ]);
    expect(snippets.map((s) => [s.filename, s.language])).toEqual([
      [".npmrc", "ini"],
      [".npmrc", "ini"],
      ["terminal", "shell"],
    ]);
    expect(snippets[0]?.body).toBe(
      [
        `@acme:registry=${BASE}/npm/`,
        `@tools:registry=${BASE}/npm/`,
        `//packages.example.com/npm/:_authToken=${token}`,
        "",
      ].join("\n"),
    );
    expect(snippets[1]?.body).toBe(
      [
        `@acme:registry=${BASE}/npm/`,
        `@tools:registry=${BASE}/npm/`,
        `//packages.example.com/npm/:_auth=${btoa(token)}`,
        "",
      ].join("\n"),
    );
    expect(snippets[2]?.body).toBe("npm install @acme/http-client @acme/sdk @tools/cli\n");
  });

  it("uses a placeholder scope without packages and keeps ports and paths", () => {
    const snippets = adapter.clientConfig("http://localhost:8787/registry", token, []);
    expect(snippets).toHaveLength(2);
    expect(snippets[0]?.body).toBe(
      [
        "@your-scope:registry=http://localhost:8787/registry/npm/",
        `//localhost:8787/registry/npm/:_authToken=${token}`,
        "",
      ].join("\n"),
    );
  });
});
