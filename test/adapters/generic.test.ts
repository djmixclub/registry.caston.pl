import { describe, expect, it } from "vitest";
import {
  genericAdapter as adapter,
  genericIndexKey,
  isGenericName,
  validateGenericVersion,
  type StoredFeed,
} from "../../src/adapters/generic/index";
import type {
  IndexSelector,
  ListingContext,
  Manifest,
  ManifestFile,
  NativeRoute,
  PublishInit,
} from "../../src/adapters/types";
import { ValidationError } from "../../src/core/errors";
import fixture from "../fixtures/generic/meta.json";

const BASE = "https://packages.example.com";
const SHA = "a".repeat(64);
const NAME = "acme/plugin-foo";

function init(overrides: Partial<PublishInit> = {}): PublishInit {
  return {
    eco: "generic",
    name: NAME,
    version: "1.4.0",
    files: [
      {
        name: "plugin_foo-x86_64-pc-windows-msvc.dll",
        size: 1048576,
        sha256: SHA,
        role: "archive",
        labels: { platform: "x86_64-pc-windows-msvc", kind: "library" },
      },
      { name: "plugin_foo-aarch64-apple-darwin.dylib", size: 20, sha256: SHA },
    ],
    manifest: structuredClone(fixture) as Record<string, unknown>,
    ...overrides,
  };
}

function file(name: string, labels: Record<string, string> = {}): ManifestFile {
  return { name, size: 10, sha256: SHA, labels };
}

function manifest(version: string, files: ManifestFile[], yanked = false): Manifest {
  return {
    eco: "generic",
    name: NAME,
    version,
    files,
    published: "2026-10-28T11:02:00Z",
    publishedBy: "ci-acme",
    yanked,
    native: { notes: `v${version}` },
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

function get(path: string, method = "GET"): NativeRoute | null {
  const url = new URL(`${BASE}${path}`);
  return adapter.route(new Request(url, { method }), url);
}

const linux = { platform: "x86_64-unknown-linux-gnu", kind: "library" };
const windows = { platform: "x86_64-pc-windows-msvc", kind: "library" };

/** A stored feed with stable, prerelease and yanked versions. */
function storedFeed(): StoredFeed {
  const [index] = adapter.buildIndex(
    NAME,
    [
      manifest("1.0.0", [file("a-linux.so", linux)]),
      manifest("1.4.0", [file("a-linux.so", linux), file("a.dll", windows), file("a.txt")]),
      manifest("1.5.0", [file("a-linux.so", linux)], true),
      manifest("2.0.0-beta.1", [file("a-linux.so", linux)]),
    ],
    { publicUrl: BASE },
  );
  return JSON.parse(index?.body ?? "") as StoredFeed;
}

const everything = (): boolean => true;

function filter(
  selector?: IndexSelector,
  allowed: (name: string, version: string) => boolean = everything,
): unknown {
  const route = { kind: "index", key: genericIndexKey(NAME), name: NAME, selector } as const;
  return adapter.filterIndex(storedFeed(), allowed, route);
}

describe("generic names and versions", () => {
  it.each(["acme-tool", "acme/plugin-foo", "a", "a.b_c-d", "0tool/x1"])("accepts %s", (n) =>
    expect(isGenericName(n)).toBe(true),
  );

  it.each([
    "Acme",
    "-tool",
    "acme/",
    "/acme",
    "a/b/c",
    "acme__x",
    "acme/x__y",
    "acme/_x",
    "acme tool",
    "",
  ])("rejects %s", (n) => expect(isGenericName(n)).toBe(false));

  it("accepts strict semver only", () => {
    expect(validateGenericVersion("1.4.0")).toBe(true);
    expect(validateGenericVersion("2.0.0-beta.1")).toBe(true);
    for (const v of ["1.4", "v1.4.0", "1.4.0+build", "01.4.0", "latest"]) {
      expect(adapter.validateVersion(v)).toBe(false);
    }
  });

  it("orders by semver and evaluates npm ranges", () => {
    expect(["1.10.0", "2.0.0-beta.1", "1.2.0", "2.0.0"].sort(adapter.compareVersions)).toEqual([
      "1.2.0",
      "1.10.0",
      "2.0.0-beta.1",
      "2.0.0",
    ]);
    expect(adapter.satisfies("1.4.0", "^1.0")).toBe(true);
    expect(adapter.satisfies("2.0.0-beta.1", "^1.0")).toBe(false);
    expect(adapter.validateRange("^1.2 || 2.x")).toBe(true);
    expect(adapter.validateRange("[1.0,2.0)")).toBe(false);
  });

  it("has no dependencies", () => {
    expect(adapter.dependencies(manifest("1.0.0", [file("a")]))).toEqual([]);
  });
});

describe("parseManifest", () => {
  it("stores the files with their labels and the meta as native", () => {
    const m = adapter.parseManifest(init());
    expect(m).toEqual({
      eco: "generic",
      name: NAME,
      version: "1.4.0",
      files: [
        {
          name: "plugin_foo-x86_64-pc-windows-msvc.dll",
          size: 1048576,
          sha256: SHA,
          labels: { platform: "x86_64-pc-windows-msvc", kind: "library" },
        },
        { name: "plugin_foo-aarch64-apple-darwin.dylib", size: 20, sha256: SHA, labels: {} },
      ],
      published: "",
      publishedBy: "",
      yanked: false,
      native: fixture,
    });
    expect(adapter.supportsAppend).toBe(true);
  });

  it("accepts an empty meta and an ungrouped name", () => {
    expect(adapter.parseManifest(init({ name: "acme-tool", manifest: {} })).native).toEqual({});
  });

  it("checks the name and the version", () => {
    rejects(() => adapter.parseManifest(init({ name: "acme__tool" })));
    rejects(() => adapter.parseManifest(init({ name: "Acme/tool" })));
    rejects(() => adapter.parseManifest(init({ version: "1.4" })));
    rejects(() => adapter.parseManifest(init({ version: "1.4.0+build.1" })));
  });

  it("rejects a dist-tag", () => {
    rejects(() => adapter.parseManifest(init({ tag: "latest" })));
  });

  it("limits the meta to 64 KiB of compact JSON", () => {
    const padding = (n: number) => ({ notes: "x".repeat(n) });
    // {"notes":"…"} adds 12 bytes around the value.
    expect(adapter.parseManifest(init({ manifest: padding(65536 - 12) }))).toBeTruthy();
    rejects(() => adapter.parseManifest(init({ manifest: padding(65536 - 11) })));
  });

  it("validates the labels", () => {
    const withLabels = (labels: Record<string, string>) =>
      init({ files: [{ name: "a.bin", size: 1, sha256: SHA, labels }] });
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, "v"]));
    const max = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, "v"]));
    expect(adapter.parseManifest(withLabels(max)).files[0]?.labels).toEqual(max);
    expect(adapter.parseManifest(withLabels({ ["k".repeat(64)]: "é".repeat(256) }))).toBeTruthy();
    rejects(() => adapter.parseManifest(withLabels(many)));
    rejects(() => adapter.parseManifest(withLabels({ Platform: "x" })));
    rejects(() => adapter.parseManifest(withLabels({ ["k".repeat(65)]: "x" })));
    rejects(() => adapter.parseManifest(withLabels({ _x: "x" })));
    rejects(() => adapter.parseManifest(withLabels({ k: "x".repeat(257) })));
  });

  it("accepts 1 to 64 files", () => {
    const files = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `f${i}.bin`, size: 1, sha256: SHA }));
    expect(adapter.parseManifest(init({ files: files(64) })).files).toHaveLength(64);
    rejects(() => adapter.parseManifest(init({ files: files(65) })));
    rejects(() => adapter.parseManifest(init({ files: [] })));
  });
});

describe("keys and URLs", () => {
  it("stores files under the encoded name and links to the feed", () => {
    const m = adapter.parseManifest(init());
    const f = m.files[0];
    if (f === undefined) throw new Error("no file");
    expect(adapter.fileKey(m, f)).toBe(
      "generic/pkg/acme__plugin-foo/1.4.0/plugin_foo-x86_64-pc-windows-msvc.dll",
    );
    expect(adapter.versionUrl(m, BASE)).toBe(`${BASE}/generic/acme%2Fplugin-foo/1.4.0`);
    expect(adapter.fileUrl(m, f, BASE)).toBe(
      `${BASE}/generic/acme%2Fplugin-foo/1.4.0/plugin_foo-x86_64-pc-windows-msvc.dll`,
    );
    expect(genericIndexKey(NAME)).toBe("generic/index/acme__plugin-foo.json");
    expect(genericIndexKey("acme-tool")).toBe("generic/index/acme-tool.json");
  });
});

describe("buildIndex", () => {
  it("stores every version, highest first, with file URLs", () => {
    const files = adapter.buildIndex(
      NAME,
      [manifest("1.0.0", [file("a.so")]), manifest("1.5.0", [file("b.so", linux)], true)],
      { publicUrl: BASE },
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.key).toBe("generic/index/acme__plugin-foo.json");
    expect(files[0]?.contentType).toBe("application/json");
    const body = JSON.parse(files[0]?.body ?? "") as StoredFeed;
    expect(Object.keys(body.versions)).toEqual(["1.5.0", "1.0.0"]);
    expect(body).toEqual({
      name: NAME,
      versions: {
        "1.5.0": {
          published: "2026-10-28T11:02:00Z",
          yanked: true,
          meta: { notes: "v1.5.0" },
          files: [
            {
              name: "b.so",
              size: 10,
              sha256: SHA,
              labels: linux,
              url: `${BASE}/generic/acme%2Fplugin-foo/1.5.0/b.so`,
            },
          ],
        },
        "1.0.0": {
          published: "2026-10-28T11:02:00Z",
          yanked: false,
          meta: { notes: "v1.0.0" },
          files: [
            {
              name: "a.so",
              size: 10,
              sha256: SHA,
              labels: {},
              url: `${BASE}/generic/acme%2Fplugin-foo/1.0.0/a.so`,
            },
          ],
        },
      },
    });
  });
});

describe("filterIndex", () => {
  it("serves the package document without yanked versions", () => {
    const doc = filter() as { latest: string; versions: Record<string, unknown> };
    expect(doc.latest).toBe("1.4.0");
    expect(Object.keys(doc.versions)).toEqual(["2.0.0-beta.1", "1.4.0", "1.0.0"]);
  });

  it("adds yanked versions with include=yanked without changing latest", () => {
    const doc = filter({ includeYanked: true }) as {
      latest: string;
      versions: Record<string, { yanked: boolean }>;
    };
    expect(doc.latest).toBe("1.4.0");
    expect(Object.keys(doc.versions)).toEqual(["2.0.0-beta.1", "1.5.0", "1.4.0", "1.0.0"]);
    expect(doc.versions["1.5.0"]?.yanked).toBe(true);
  });

  it("filters the files by every requested label", () => {
    const doc = filter({ labels: [["platform", "x86_64-pc-windows-msvc"]] }) as {
      versions: Record<string, { files: { name: string }[] }>;
    };
    expect(doc.versions["1.4.0"]?.files.map((f) => f.name)).toEqual(["a.dll"]);
    expect(doc.versions["1.0.0"]?.files).toEqual([]);
    const both = filter({
      labels: [
        ["kind", "library"],
        ["platform", "x86_64-unknown-linux-gnu"],
      ],
    }) as { versions: Record<string, { files: { name: string }[] }> };
    expect(both.versions["1.4.0"]?.files.map((f) => f.name)).toEqual(["a-linux.so"]);
  });

  it("keeps only the versions the caller may see and computes latest from them", () => {
    const doc = filter({}, (_name, version) => version !== "1.4.0") as {
      latest: string;
      versions: Record<string, unknown>;
    };
    expect(doc.latest).toBe("1.0.0");
    expect(Object.keys(doc.versions)).toEqual(["2.0.0-beta.1", "1.0.0"]);
  });

  it("answers latest with an optional prerelease channel", () => {
    expect(filter({ latest: true })).toMatchObject({ name: NAME, version: "1.4.0" });
    expect(filter({ latest: true, prerelease: true })).toMatchObject({ version: "2.0.0-beta.1" });
    const onlyYanked = (_n: string, v: string) => v === "1.5.0";
    rejects(() => filter({ latest: true }, onlyYanked), "not_found");
  });

  it("resolves latest within a version range", () => {
    expect(filter({ latest: true, range: "^1" })).toMatchObject({ version: "1.4.0" });
    expect(filter({ latest: true, range: "<1.4.0" })).toMatchObject({ version: "1.0.0" });
    // The yanked 1.5.0 is never selected through latest.
    rejects(() => filter({ latest: true, range: "1.5.0" }), "not_found");
    rejects(() => filter({ latest: true, range: "^3" }), "not_found");
    // Only grant-covered versions qualify.
    const old = (_n: string, v: string) => v !== "1.4.0";
    expect(filter({ latest: true, range: "^1" }, old)).toMatchObject({ version: "1.0.0" });
  });

  it("admits prereleases in a range only when pinned or on the prerelease channel", () => {
    rejects(() => filter({ latest: true, range: "^2" }), "not_found");
    expect(filter({ latest: true, range: "^2", prerelease: true })).toMatchObject({
      version: "2.0.0-beta.1",
    });
    expect(filter({ latest: true, range: ">=2.0.0-beta.0" })).toMatchObject({
      version: "2.0.0-beta.1",
    });
    // A prerelease of a release outside the range stays out, channel or not.
    expect(filter({ latest: true, range: "^1", prerelease: true })).toMatchObject({
      version: "1.4.0",
    });
    rejects(() => filter({ latest: true, range: "~1.6", prerelease: true }), "not_found");
  });

  it("filters the package document by a version range", () => {
    const doc = filter({ range: "^1" }) as { latest: string; versions: Record<string, unknown> };
    expect(doc.latest).toBe("1.4.0");
    expect(Object.keys(doc.versions)).toEqual(["1.4.0", "1.0.0"]);
    const yanked = filter({ range: "^1", includeYanked: true }) as typeof doc;
    expect(yanked.latest).toBe("1.4.0");
    expect(Object.keys(yanked.versions)).toEqual(["1.5.0", "1.4.0", "1.0.0"]);
    const pinned = filter({ range: ">=2.0.0-beta.0" }) as typeof doc;
    expect(pinned.latest).toBe("2.0.0-beta.1");
    expect(Object.keys(pinned.versions)).toEqual(["2.0.0-beta.1"]);
    expect(filter({ range: "^3" })).toEqual({ name: NAME, latest: null, versions: {} });
  });

  it("serves one version in the single-version shape", () => {
    expect(filter({ version: "1.4.0", labels: [["kind", "library"]] })).toEqual({
      name: NAME,
      version: "1.4.0",
      published: "2026-10-28T11:02:00Z",
      yanked: false,
      meta: { notes: "v1.4.0" },
      files: [
        {
          name: "a-linux.so",
          size: 10,
          sha256: SHA,
          labels: linux,
          url: `${BASE}/generic/acme%2Fplugin-foo/1.4.0/a-linux.so`,
        },
        {
          name: "a.dll",
          size: 10,
          sha256: SHA,
          labels: windows,
          url: `${BASE}/generic/acme%2Fplugin-foo/1.4.0/a.dll`,
        },
      ],
    });
  });

  it("hides yanked, unknown and ungranted versions", () => {
    rejects(() => filter({ version: "1.5.0" }), "not_found");
    expect(filter({ version: "1.5.0", includeYanked: true })).toMatchObject({ yanked: true });
    rejects(() => filter({ version: "9.9.9" }), "not_found");
    rejects(() => filter({ version: "1.4.0" }, (_n, v) => v !== "1.4.0"), "not_found");
  });

  it("answers 404 when no version is covered", () => {
    rejects(() => filter({}, () => false), "not_found");
  });

  it("refuses a malformed stored index", () => {
    rejects(() => adapter.filterIndex({ x: 1 }, () => true), "internal_error");
  });
});

describe("route", () => {
  const key = "generic/index/acme__plugin-foo.json";

  it("routes the listing", () => {
    expect(get("/generic/")).toEqual({ kind: "listing" });
    expect(get("/generic")).toEqual({ kind: "listing" });
  });

  it("routes the package document with its filters", () => {
    expect(get("/generic/acme%2Fplugin-foo?include=yanked&label=os:linux&label=k:a:b")).toEqual({
      kind: "index",
      key,
      name: NAME,
      selector: {
        includeYanked: true,
        labels: [
          ["os", "linux"],
          ["k", "a:b"],
        ],
      },
    });
    expect(get("/generic/acme-tool?unknown=1")).toMatchObject({
      key: "generic/index/acme-tool.json",
      name: "acme-tool",
    });
  });

  it("routes latest and single versions", () => {
    expect(get("/generic/acme%2Fplugin-foo/latest?channel=prerelease")).toEqual({
      kind: "index",
      key,
      name: NAME,
      selector: { latest: true, prerelease: true, labels: undefined },
    });
    expect(get("/generic/acme%2fplugin-foo/1.4.0")).toMatchObject({
      kind: "index",
      selector: { version: "1.4.0" },
    });
  });

  it("routes a version range", () => {
    expect(get("/generic/acme%2Fplugin-foo/latest?version=%5E1.2&channel=prerelease")).toEqual({
      kind: "index",
      key,
      name: NAME,
      selector: { latest: true, prerelease: true, range: "^1.2" },
    });
    expect(get("/generic/acme%2Fplugin-foo?version=1.x%20%7C%7C%20>=2.0.0-0")).toEqual({
      kind: "index",
      key,
      name: NAME,
      selector: { range: "1.x || >=2.0.0-0" },
    });
  });

  it("routes file downloads", () => {
    expect(get("/generic/acme%2Fplugin-foo/1.4.0/a%2Bb.dll")).toEqual({
      kind: "archive",
      name: NAME,
      version: "1.4.0",
      file: "a+b.dll",
    });
  });

  it("does not route other paths or methods", () => {
    for (const path of [
      "/generic/acme/plugin-foo/1.4.0/a.dll",
      "/generic/acme__x",
      "/generic/acme-tool/",
      "/generic/acme-tool/1.4",
      "/generic/acme-tool/1.4/a.dll",
      "/generic/acme-tool/%E0%A4%A",
      "/genericx",
    ]) {
      expect(get(path)).toBeNull();
    }
    expect(get("/generic/acme-tool", "POST")).toBeNull();
    expect(get("/generic/acme-tool", "HEAD")).toBeNull();
  });

  it("rejects invalid query parameters", () => {
    rejects(() => get("/generic/acme-tool?include=all"));
    rejects(() => get("/generic/acme-tool/latest?channel=beta"));
    rejects(() => get("/generic/acme-tool?label=nocolon"));
    rejects(() => get("/generic/acme-tool/1.0.0?label=Bad:x"));
    rejects(() => get("/generic/acme-tool/latest?version=not-a-range"));
    rejects(() => get("/generic/acme-tool/latest?version="));
    rejects(() => get("/generic/acme-tool?version=%5E1&version=%5E2"));
  });
});

describe("buildListing", () => {
  it("lists the packages with a visible version and their latest", async () => {
    const indexes: Record<string, unknown> = {
      [genericIndexKey(NAME)]: storedFeed(),
      [genericIndexKey("acme/only-yanked")]: {
        name: "acme/only-yanked",
        versions: { "1.0.0": { published: "x", yanked: true, meta: {}, files: [] } },
      },
      [genericIndexKey("acme/hidden")]: {
        name: "acme/hidden",
        versions: { "1.0.0": { published: "x", yanked: false, meta: {}, files: [] } },
      },
    };
    const ctx: ListingContext = {
      publicUrl: BASE,
      route: { kind: "listing" },
      allowed: (name) => name !== "acme/hidden",
      readIndex: (key) => Promise.resolve(indexes[key] ?? null),
    };
    const names = [NAME, "acme/only-yanked", "acme/hidden", "acme/missing"];
    expect(await adapter.buildListing?.(names, ctx)).toEqual({
      packages: [
        { name: "acme/only-yanked", latest: null },
        { name: NAME, latest: "1.4.0" },
      ],
    });
  });
});

describe("clientConfig", () => {
  it("shows curl and sreg examples", () => {
    const snippets = adapter.clientConfig(`${BASE}/`, "shop:secret", ["acme/b", "acme/a"]);
    expect(snippets.map((s) => s.title)).toEqual([
      "Package feed (curl)",
      "Download a file (curl)",
      "Download with sreg",
    ]);
    const [feed, download, sreg] = snippets.map((s) => s.body);
    expect(feed).toContain('-H "Authorization: Bearer shop:secret"');
    expect(feed).toContain(`"${BASE}/generic/acme%2Fa"`);
    expect(download).toContain("curl -fsSL");
    expect(download).toContain("7.58");
    expect(sreg).toContain("sreg generic get acme/a latest --label platform=");
    expect(sreg).toContain("--out ./downloads");
    expect(sreg).toContain(`export REGISTRY_URL=${BASE}\n`);
  });

  it("uses an example name without packages", () => {
    const [feed] = adapter.clientConfig(BASE, "p:x", []);
    expect(feed?.body).toContain("/generic/acme%2Fplugin-foo");
  });
});
