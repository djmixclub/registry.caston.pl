import { describe, expect, it } from "vitest";
import {
  compareSwiftVersions,
  normalizeRepositoryUrl,
  swiftAdapter as adapter,
  swiftIndexKey,
} from "../../src/adapters/swift/index";
import {
  RawIndexBody,
  type ArchiveRoute,
  type IndexRoute,
  type ListingContext,
  type ListingRoute,
  type Manifest,
  type NativeRoute,
  type PublishInit,
} from "../../src/adapters/types";
import { ValidationError } from "../../src/core/errors";
import dumpPackage from "../fixtures/swift/dump-package.json";

const BASE = "https://packages.example.com";
const SHA = "a".repeat(64);
const ARCHIVE_SHA = "a2ac54cf25fbc1ad0028f03f0aa4b96833b83bb05a14e510892bb27dea4dc812";
const RELEASE = `${BASE}/swift/acme/Networking`;

function init(overrides: Partial<PublishInit> = {}): PublishInit {
  const version = overrides.version ?? "1.2.0";
  return {
    eco: "swift",
    name: "acme.Networking",
    version,
    files: [
      { name: `Networking-${version}.zip`, size: 4096, sha256: ARCHIVE_SHA, role: "archive" },
      { name: "Package.swift", size: 512, sha256: SHA, role: "manifest" },
      { name: "Package@swift-5.8.swift", size: 512, sha256: SHA, role: "manifest" },
    ],
    manifest: {
      toolsVersion: "5.9",
      repositoryURL: "https://github.com/acme/networking",
      readmeURL: "https://github.com/acme/networking/blob/main/README.md",
      dumpPackage,
    },
    ...overrides,
  };
}

/** A stored manifest as `commit` writes it. */
function stored(
  version: string,
  options: { yanked?: boolean; id?: string; variants?: string[]; repo?: string } = {},
): Manifest {
  const id = options.id ?? "acme.Networking";
  const variants = options.variants ?? ["5.8"];
  const m = adapter.parseManifest(
    init({
      name: id,
      version,
      files: [
        { name: `${id.split(".")[1] ?? ""}-${version}.zip`, size: 1, sha256: ARCHIVE_SHA },
        { name: "Package.swift", size: 1, sha256: SHA },
        ...variants.map((v) => ({ name: `Package@swift-${v}.swift`, size: 1, sha256: SHA })),
      ],
      manifest: {
        toolsVersion: "5.9.0",
        repositoryURL: options.repo ?? "https://github.com/acme/networking.git",
        dumpPackage,
      },
    }),
  );
  return {
    ...m,
    published: `2026-10-28T10:1${version.length % 10}:00Z`,
    publishedBy: "ci",
    yanked: options.yanked ?? false,
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

function get(path: string, init: RequestInit = {}): NativeRoute | null {
  const url = new URL(`${BASE}${path}`);
  return adapter.route(new Request(url, init), url);
}

function index(manifests: Manifest[]): unknown {
  const files = adapter.buildIndex("acme.networking", manifests, { publicUrl: BASE });
  expect(files.map((f) => f.key)).toEqual(["swift/index/acme.networking/releases.json"]);
  return JSON.parse(files[0]?.body ?? "null");
}

type Allowed = (name: string, version: string) => boolean;
const all: Allowed = () => true;

const MANIFESTS = [
  stored("1.0.0"),
  stored("1.1.0", { yanked: true }),
  stored("1.2.0", { variants: ["5.8", "5.10", "6"] }),
  stored("2.0.0-beta.1"),
];

describe("parseManifest", () => {
  it("accepts a real dump-package manifest and keeps the identity's casing", () => {
    const m = adapter.parseManifest(init());
    expect(m).toEqual({
      eco: "swift",
      name: "acme.networking",
      version: "1.2.0",
      files: [
        { name: "Networking-1.2.0.zip", size: 4096, sha256: ARCHIVE_SHA, role: "archive" },
        { name: "Package.swift", size: 512, sha256: SHA, role: "manifest" },
        { name: "Package@swift-5.8.swift", size: 512, sha256: SHA, role: "manifest" },
      ],
      published: "",
      publishedBy: "",
      yanked: false,
      native: {
        toolsVersion: "5.9",
        repositoryURL: "https://github.com/acme/networking",
        readmeURL: "https://github.com/acme/networking/blob/main/README.md",
        dumpPackage,
      },
      meta: { id: "acme.Networking" },
    });
    expect(Object.keys(m.native)).toEqual([
      "toolsVersion",
      "repositoryURL",
      "readmeURL",
      "dumpPackage",
    ]);
  });

  it("accepts the CLI's manifest without the optional URLs", () => {
    const m = adapter.parseManifest(
      init({ manifest: { toolsVersion: "5.9.0", repositoryURL: null, dumpPackage } }),
    );
    expect(m.native).toEqual({ toolsVersion: "5.9.0", dumpPackage });
  });

  it("validates the identity, version and manifest", () => {
    rejects(() => adapter.parseManifest(init({ name: "Networking" })));
    rejects(() => adapter.parseManifest(init({ name: "acme_corp.Networking" })));
    rejects(() => adapter.parseManifest(init({ name: `${"a".repeat(40)}.Networking` })));
    rejects(() => adapter.parseManifest(init({ name: "acme.Net.working" })));
    rejects(() => adapter.parseManifest(init({ version: "1.2" })));
    rejects(() => adapter.parseManifest(init({ version: "1.2.0+build.5" })));
    rejects(() => adapter.parseManifest(init({ tag: "latest" })));
    const manifest = init().manifest;
    for (const toolsVersion of ["5", "5.x", "5.9.0.1", 5.9]) {
      rejects(() => adapter.parseManifest(init({ manifest: { ...manifest, toolsVersion } })));
    }
    rejects(() => adapter.parseManifest(init({ manifest: { ...manifest, dumpPackage: "{}" } })));
    rejects(() =>
      adapter.parseManifest(init({ manifest: { ...manifest, dumpPackage: { dependencies: {} } } })),
    );
    rejects(() => adapter.parseManifest(init({ manifest: { ...manifest, repositoryURL: "" } })));
    rejects(() => adapter.parseManifest(init({ manifest: { ...manifest, readmeURL: 3 } })));
  });

  it("requires the archive and Package.swift and derives missing roles", () => {
    const [archive, manifest, variant] = init().files as [
      PublishInit["files"][number],
      PublishInit["files"][number],
      PublishInit["files"][number],
    ];
    const plain = adapter.parseManifest(
      init({
        files: [
          { ...archive, role: undefined },
          { ...manifest, role: undefined },
        ],
      }),
    );
    expect(plain.files.map((f) => f.role)).toEqual(["archive", "manifest"]);
    rejects(() => adapter.parseManifest(init({ files: [manifest, variant] })));
    rejects(() => adapter.parseManifest(init({ files: [archive, variant] })));
    rejects(() =>
      adapter.parseManifest(
        init({ files: [{ ...archive, name: "networking-1.2.0.zip" }, manifest] }),
      ),
    );
    rejects(() =>
      adapter.parseManifest(
        init({ files: [{ ...archive, name: "Networking-1.3.0.zip" }, manifest] }),
      ),
    );
    rejects(() =>
      adapter.parseManifest(init({ files: [{ ...archive, role: "manifest" }, manifest] })),
    );
    rejects(() =>
      adapter.parseManifest(init({ files: [archive, { ...manifest, role: "archive" }] })),
    );
    rejects(() =>
      adapter.parseManifest(
        init({ files: [archive, manifest, { ...variant, name: "Package@swift-5.x.swift" }] }),
      ),
    );
    rejects(() =>
      adapter.parseManifest(
        init({ files: [archive, manifest, { ...variant, name: "README.md" }] }),
      ),
    );
  });
});

describe("dependencies", () => {
  it("takes the registry dependencies of dump-package as npm ranges", () => {
    expect(adapter.dependencies(stored("1.0.0"))).toEqual([
      { name: "acme.httptypes", constraint: ">=1.1.0 <2.0.0" },
      { name: "acme.logging", constraint: "0.3.2" },
    ]);
    expect(adapter.satisfies("1.4.0", ">=1.1.0 <2.0.0")).toBe(true);
    expect(adapter.satisfies("2.0.0", ">=1.1.0 <2.0.0")).toBe(false);
    expect(adapter.satisfies("0.3.2", "0.3.2")).toBe(true);
    expect(adapter.satisfies("0.3.3", "0.3.2")).toBe(false);
  });

  it("ignores malformed entries", () => {
    const m = stored("1.0.0");
    const native = {
      ...m.native,
      dumpPackage: {
        dependencies: [
          null,
          { registry: [{ identity: "acme.A", requirement: { branch: ["main"] } }] },
          { registry: [{ requirement: { exact: ["1.0.0"] } }] },
          { registry: "acme.B" },
        ],
      },
    };
    expect(adapter.dependencies({ ...m, native })).toEqual([]);
    expect(adapter.dependencies({ ...m, native: {} })).toEqual([]);
  });
});

describe("versions", () => {
  it("uses strict semver and npm ranges", () => {
    expect(adapter.validateVersion("1.2.3-beta.1")).toBe(true);
    expect(adapter.validateVersion("v1.2.3")).toBe(false);
    expect(adapter.validateVersion("1.2.3+build")).toBe(false);
    expect(adapter.compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(adapter.validateRange(">=1.0.0 <2.0.0")).toBe(true);
    expect(adapter.validateRange("[1.0,2.0)")).toBe(false);
    expect(compareSwiftVersions("5.9", "5.9.0")).toBe(0);
    expect(compareSwiftVersions("5.10", "5.9")).toBeGreaterThan(0);
  });
});

describe("buildIndex and filterIndex", () => {
  it("keeps every release with its metadata, highest first", () => {
    expect(index(MANIFESTS)).toEqual({
      name: "acme.networking",
      id: "acme.Networking",
      releases: {
        "2.0.0-beta.1": expect.objectContaining({ url: `${RELEASE}/2.0.0-beta.1` }),
        "1.2.0": {
          url: `${RELEASE}/1.2.0`,
          publishedAt: "2026-10-28T10:15:00Z",
          checksum: ARCHIVE_SHA,
          metadata: { repositoryURLs: ["https://github.com/acme/networking.git"] },
          manifests: ["5.8", "5.10", "6"],
        },
        "1.1.0": expect.objectContaining({
          problem: { status: 410, title: "Gone", detail: "this release was yanked" },
        }),
        "1.0.0": expect.objectContaining({ manifests: ["5.8"] }),
      },
    });
  });

  it("uses the casing of the highest version", () => {
    const body = index([stored("1.0.0"), stored("1.1.0", { id: "Acme.networking" })]) as {
      id: string;
      releases: Record<string, { url: string }>;
    };
    expect(body.id).toBe("Acme.networking");
    expect(body.releases["1.0.0"]?.url).toBe(`${BASE}/swift/Acme/networking/1.0.0`);
  });

  it("lists the granted releases with the problem of yanked ones", () => {
    const body = index(MANIFESTS);
    const route = get("/swift/acme/networking") as IndexRoute;
    expect(adapter.filterIndex(body, (_n, v) => v !== "2.0.0-beta.1", route)).toEqual({
      releases: {
        "1.2.0": { url: `${RELEASE}/1.2.0` },
        "1.1.0": {
          url: `${RELEASE}/1.1.0`,
          problem: { status: 410, title: "Gone", detail: "this release was yanked" },
        },
        "1.0.0": { url: `${RELEASE}/1.0.0` },
      },
    });
    rejects(() => adapter.filterIndex(body, () => false, route), "not_found");
    rejects(() => adapter.filterIndex({ releases: [] }, all, route), "internal_error");
  });

  it("serves release metadata with Link headers among visible, non-yanked releases", () => {
    const body = index(MANIFESTS);
    const metadata = (version: string, allowed = all) =>
      adapter.filterIndex(body, allowed, get(`/swift/acme/Networking/${version}`) as IndexRoute);
    const res = metadata("1.2.0") as RawIndexBody;
    expect(res).toBeInstanceOf(RawIndexBody);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({
      id: "acme.Networking",
      version: "1.2.0",
      resources: [{ name: "source-archive", type: "application/zip", checksum: ARCHIVE_SHA }],
      metadata: { repositoryURLs: ["https://github.com/acme/networking.git"] },
      publishedAt: "2026-10-28T10:15:00Z",
    });
    expect(res.headers).toEqual({
      link:
        `<${RELEASE}/2.0.0-beta.1>; rel="latest-version", ` +
        `<${RELEASE}/2.0.0-beta.1>; rel="successor-version", ` +
        `<${RELEASE}/1.0.0>; rel="predecessor-version"`,
    });
    const oldest = metadata("1.0.0", (_n, v) => v !== "2.0.0-beta.1") as RawIndexBody;
    expect(oldest.headers).toEqual({
      link: `<${RELEASE}/1.2.0>; rel="latest-version", <${RELEASE}/1.2.0>; rel="successor-version"`,
    });
    const yanked = metadata("1.1.0") as RawIndexBody;
    expect(yanked.status).toBe(410);
    expect(yanked.contentType).toBe("application/problem+json");
    expect(JSON.parse(yanked.body)).toEqual({
      status: 410,
      title: "Gone",
      detail: "this release was yanked",
    });
    rejects(() => metadata("1.2.0", () => false), "not_found");
    rejects(() => metadata("9.9.9"), "not_found");
  });
});

describe("route", () => {
  it("maps the SE-0292 endpoints", () => {
    const key = swiftIndexKey("acme.networking");
    expect(get("/swift/acme/Networking")).toEqual({
      kind: "index",
      key,
      name: "acme.networking",
      view: "releases",
    });
    expect(get("/swift/ACME/networking/1.2.0")).toEqual({
      kind: "index",
      key,
      name: "acme.networking",
      view: "metadata",
      selector: { version: "1.2.0" },
    });
    expect(get("/swift/acme/Networking/1.2.0-beta.zip")).toEqual({
      kind: "archive",
      name: "acme.networking",
      version: "1.2.0-beta",
      file: null,
    });
    expect(get("/swift/acme/Networking/1.2.0/Package.swift")).toEqual({
      kind: "archive",
      name: "acme.networking",
      version: "1.2.0",
      file: "Package.swift",
      inline: true,
      contentType: "text/x-swift",
    });
    expect(get("/swift/acme/Networking/1.2.0/Package.swift?swift-version=5.9")).toMatchObject({
      file: "Package@swift-5.9.swift",
    });
    expect(get("/swift/identifiers?url=https://github.com/acme/networking")).toEqual({
      kind: "listing",
      listing: "identifiers",
      options: { url: "https://github.com/acme/networking" },
    });
    expect(get("/swift/login", { method: "POST" })).toEqual({
      kind: "static",
      body: "",
      contentType: "text/plain; charset=utf-8",
    });
  });

  it("rejects other paths and methods", () => {
    for (const path of [
      "/swift",
      "/swift/acme",
      "/swift/acme_x/Networking",
      "/swift/acme/Net.working",
      "/swift/acme/Networking/1.2",
      "/swift/acme/Networking/1.2.zip",
      "/swift/acme/Networking/1.2.0/Package@swift-5.9.swift",
      "/swift/acme/Networking/1.2.0/Package.swift/x",
      "/nuget/index.json",
    ]) {
      expect(get(path), path).toBeNull();
    }
    expect(get("/swift/acme/Networking", { method: "PUT" })).toBeNull();
    expect(get("/swift/login")).toBeNull();
    rejects(() => get("/swift/identifiers"));
    rejects(() => get("/swift/acme/Networking/1.2.0/Package.swift?swift-version=five"));
  });

  it("answers 415 for another API version and tolerates generic Accept headers", () => {
    const accept = (value: string) =>
      get("/swift/acme/Networking", { headers: { accept: value } }) as NativeRoute;
    expect(accept("application/vnd.swift.registry.v1+json").kind).toBe("index");
    expect(accept("application/json").kind).toBe("index");
    expect(accept("*/*").kind).toBe("index");
    expect(accept("application/vnd.swift.registry.v2+json")).toEqual({
      kind: "static",
      status: 415,
      contentType: "application/problem+json",
      body: JSON.stringify({
        status: 415,
        title: "Unsupported Media Type",
        detail: "Only version 1 of the registry API is supported.",
      }),
    });
  });
});

describe("selectFile", () => {
  const m = stored("1.2.0", { variants: ["5.8", "5.10", "6"] });
  const select = (path: string) => {
    const route = get(path) as ArchiveRoute;
    return adapter.selectFile?.(m, route, BASE) ?? null;
  };
  const link = (v: string) =>
    `<${RELEASE}/1.2.0/Package.swift?swift-version=${v}>; rel="alternate"; ` +
    `filename="Package@swift-${v}.swift"; swift-tools-version="${v}"`;

  it("adds the Digest to the archive", () => {
    expect(select("/swift/acme/Networking/1.2.0.zip")).toEqual({
      file: m.files[0],
      headers: { digest: "sha-256=oqxUzyX7wa0AKPA/CqS5aDO4O7BaFOUQiSuyfepNyBI=" },
    });
  });

  it("picks the manifest variant like SwiftPM and links the others", () => {
    const name = (path: string) => select(path)?.file.name;
    const base = "/swift/acme/Networking/1.2.0/Package.swift";
    expect(name(base)).toBe("Package.swift");
    expect(select(base)?.headers).toEqual({
      link: [link("5.8"), link("5.10"), link("6")].join(", "),
    });
    expect(name(`${base}?swift-version=5.10`)).toBe("Package@swift-5.10.swift");
    expect(select(`${base}?swift-version=5.10`)?.headers).toEqual({
      link: [link("5.8"), link("6")].join(", "),
    });
    expect(name(`${base}?swift-version=5.9`)).toBe("Package@swift-5.8.swift");
    expect(name(`${base}?swift-version=5.10.1`)).toBe("Package@swift-5.10.swift");
    expect(name(`${base}?swift-version=6.0`)).toBe("Package@swift-6.swift");
    expect(name(`${base}?swift-version=7`)).toBe("Package@swift-6.swift");
    expect(name(`${base}?swift-version=5.7`)).toBe("Package.swift");
  });

  it("answers null without a matching file", () => {
    const bare = { ...m, files: m.files.filter((f) => f.role === "archive") };
    const route = get("/swift/acme/Networking/1.2.0/Package.swift") as ArchiveRoute;
    expect(adapter.selectFile?.(bare, route, BASE)).toBeNull();
    const zip = get("/swift/acme/Networking/1.2.0.zip") as ArchiveRoute;
    expect(adapter.selectFile?.({ ...m, files: [] }, zip, BASE)).toBeNull();
  });
});

describe("identifiers", () => {
  function context(url: string, allowed: Allowed = all): ListingContext {
    const indexes: Record<string, unknown> = {
      [swiftIndexKey("acme.networking")]: index(MANIFESTS),
      [swiftIndexKey("acme.other")]: JSON.parse(
        adapter.buildIndex(
          "acme.other",
          [stored("1.0.0", { id: "acme.Other", repo: "https://github.com/acme/other" })],
          { publicUrl: BASE },
        )[0]?.body ?? "null",
      ),
    };
    const route: ListingRoute = { kind: "listing", listing: "identifiers", options: { url } };
    return {
      publicUrl: BASE,
      route,
      allowed,
      readIndex: (key) => Promise.resolve(indexes[key] ?? null),
    };
  }

  it("matches repository URLs case-insensitively, with or without .git", async () => {
    const packages = ["acme.networking", "acme.other", "acme.missing"];
    for (const url of [
      "https://github.com/acme/networking",
      "https://GitHub.com/Acme/Networking.git",
      "https://github.com/acme/networking/",
    ]) {
      expect(await adapter.buildListing?.(packages, context(url))).toEqual({
        identifiers: ["acme.Networking"],
      });
    }
    await expect(
      Promise.resolve(adapter.buildListing?.(packages, context("https://github.com/acme/x"))),
    ).rejects.toThrow(ValidationError);
    await expect(
      Promise.resolve(
        adapter.buildListing?.(
          packages,
          context("https://github.com/acme/networking", (n) => n !== "acme.networking"),
        ),
      ),
    ).rejects.toThrow(ValidationError);
    expect(normalizeRepositoryUrl(" https://x.test/A.git ")).toBe("https://x.test/a");
  });
});

describe("responses", () => {
  it("adds Content-Version and turns errors into problem details", async () => {
    const error = new Response(JSON.stringify({ error: "not_found", message: "Not found." }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "x" },
    });
    const res = await adapter.finalizeResponse?.(error);
    expect(res?.status).toBe(404);
    expect(res?.headers.get("content-version")).toBe("1");
    expect(res?.headers.get("content-type")).toBe("application/problem+json");
    expect(res?.headers.get("cache-control")).toBe("x");
    expect(await res?.json()).toEqual({ status: 404, title: "Not Found", detail: "Not found." });
    const ok = await adapter.finalizeResponse?.(
      new Response("{}", { headers: { "content-type": "application/json; charset=utf-8" } }),
    );
    expect(ok?.headers.get("content-type")).toBe("application/json");
    expect(ok?.headers.get("content-version")).toBe("1");
    expect(await ok?.text()).toBe("{}");
    const redirect = await adapter.finalizeResponse?.(
      new Response(null, { status: 302, headers: { location: "https://r2.test/x" } }),
    );
    expect(redirect?.status).toBe(302);
    expect(redirect?.headers.get("location")).toBe("https://r2.test/x");
  });
});

describe("URLs and snippets", () => {
  it("points at the archive, the manifests and their variants", () => {
    const m = stored("1.2.0", { variants: ["5.8"] });
    expect(adapter.versionUrl(m, BASE)).toBe(`${RELEASE}/1.2.0.zip`);
    expect(m.files.map((f) => adapter.fileUrl(m, f, BASE))).toEqual([
      `${RELEASE}/1.2.0.zip`,
      `${RELEASE}/1.2.0/Package.swift`,
      `${RELEASE}/1.2.0/Package.swift?swift-version=5.8`,
    ]);
    expect(m.files.map((f) => adapter.fileKey(m, f))).toEqual([
      "swift/pkg/acme.networking/1.2.0/Networking-1.2.0.zip",
      "swift/pkg/acme.networking/1.2.0/Package.swift",
      "swift/pkg/acme.networking/1.2.0/Package@swift-5.8.swift",
    ]);
  });

  it("configures SwiftPM with the registry and a dependency", () => {
    const snippets = adapter.clientConfig(`${BASE}/`, "shop:key.abc", ["acme.networking"]);
    expect(snippets.map((s) => s.title)).toEqual([
      "Configure the registry",
      "Configure the registry with the token from the environment",
      "Package.swift",
    ]);
    expect(snippets[1]?.body).toContain('--username shop --password "$REGISTRY_TOKEN"');
    expect(snippets[0]?.body).toContain(`swift package-registry set ${BASE}/swift --scope acme\n`);
    expect(snippets[0]?.body).toContain(
      `swift package-registry login ${BASE}/swift --username shop --password key.abc\n`,
    );
    expect(snippets[0]?.body).toContain("--token shop:key.abc");
    expect(snippets[2]?.body).toContain('.package(id: "acme.networking", from: "1.0.0")');
    expect(snippets[2]?.body).toContain('.product(name: "networking", package: "acme.networking")');
  });
});
