import { describe, expect, it } from "vitest";
import {
  archiveExtension,
  mavenAdapter as adapter,
  mavenIndexKey,
  roleOf,
  splitCoordinates,
} from "../../src/adapters/maven/index";
import {
  RawIndexBody,
  type IndexRoute,
  type Manifest,
  type NativeRoute,
  type PublishInit,
} from "../../src/adapters/types";
import { ValidationError } from "../../src/core/errors";
import { SDK_DEPENDENCIES, SDK_POM, pomFor } from "../fixtures/maven/pom";

const BASE = "https://packages.example.com";
const SHA = "a".repeat(64);
const REPO = `${BASE}/maven/com/acme/sdk`;
const KEY = "maven/index/com.acme/sdk/index.json";

function file(name: string, role?: string) {
  return { name, size: 1024, sha256: SHA, ...(role === undefined ? {} : { role }) };
}

function init(overrides: Partial<PublishInit> = {}): PublishInit {
  return {
    eco: "maven",
    name: "com.acme:sdk",
    version: "1.4.0",
    files: [
      file("sdk-1.4.0.pom", "pom"),
      file("sdk-1.4.0.jar", "archive"),
      file("sdk-1.4.0.module", "module"),
      file("sdk-1.4.0-sources.jar", "sources"),
      file("sdk-1.4.0-javadoc.jar", "javadoc"),
    ],
    manifest: {
      groupId: "com.acme",
      artifactId: "sdk",
      version: "1.4.0",
      packaging: "jar",
      pom: SDK_POM,
      dependencies: SDK_DEPENDENCIES,
    },
    ...overrides,
  };
}

/** A stored manifest as `commit` writes it, with the digests it computes. */
function stored(
  version: string,
  options: { yanked?: boolean; published?: string; deps?: unknown[] } = {},
): Manifest {
  const m = adapter.parseManifest(
    init({
      version,
      files: [file(`sdk-${version}.pom`), file(`sdk-${version}.jar`)],
      manifest: {
        groupId: "com.acme",
        artifactId: "sdk",
        version,
        packaging: "jar",
        pom: pomFor("com.acme", "sdk", version),
        dependencies: options.deps ?? [],
      },
    }),
  );
  return {
    ...m,
    files: m.files.map((f, i) => ({
      ...f,
      digests: { sha1: `${i}`.repeat(40), md5: `${i}`.repeat(32), sha512: `${i}`.repeat(128) },
    })),
    published: options.published ?? "2026-10-28T10:12:00Z",
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

function get(path: string, method = "GET"): NativeRoute | null {
  const url = new URL(`${BASE}${path}`);
  return adapter.route(new Request(url, { method }), url);
}

function index(manifests: Manifest[]): unknown {
  const files = adapter.buildIndex("com.acme:sdk", manifests, { publicUrl: BASE });
  expect(files.map((f) => f.key)).toEqual([KEY]);
  return JSON.parse(files[0]?.body ?? "null");
}

type Allowed = (name: string, version: string) => boolean;
const all: Allowed = () => true;

async function serve(body: unknown, path: string, allowed: Allowed = all): Promise<RawIndexBody> {
  const result: unknown = await adapter.filterIndex(body, allowed, get(path) as IndexRoute);
  expect(result).toBeInstanceOf(RawIndexBody);
  return result as RawIndexBody;
}

async function hex(algorithm: string, text: string): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("parseManifest", () => {
  it("accepts a real effective POM with every file role", () => {
    const m = adapter.parseManifest(init());
    expect(m).toEqual({
      eco: "maven",
      name: "com.acme:sdk",
      version: "1.4.0",
      files: [
        file("sdk-1.4.0.pom", "pom"),
        file("sdk-1.4.0.jar", "archive"),
        file("sdk-1.4.0.module", "module"),
        file("sdk-1.4.0-sources.jar", "sources"),
        file("sdk-1.4.0-javadoc.jar", "javadoc"),
      ],
      published: "",
      publishedBy: "",
      yanked: false,
      native: {
        groupId: "com.acme",
        artifactId: "sdk",
        version: "1.4.0",
        packaging: "jar",
        pom: SDK_POM,
        dependencies: SDK_DEPENDENCIES,
      },
    });
    expect(Object.keys(m.native)).toEqual([
      "groupId",
      "artifactId",
      "version",
      "packaging",
      "pom",
      "dependencies",
    ]);
    expect(adapter.digests).toEqual(["sha1", "md5", "sha512"]);
  });

  it("derives roles from file names and requires agreement", () => {
    const m = adapter.parseManifest(
      init({
        files: [
          file("sdk-1.4.0.pom"),
          file("sdk-1.4.0.jar"),
          file("sdk-1.4.0-all.jar"),
          file("sdk-1.4.0.jar.asc", "extra"),
        ],
      }),
    );
    expect(m.files.map((f) => f.role)).toEqual(["pom", "archive", "extra", "extra"]);
    rejects(() =>
      adapter.parseManifest(init({ files: [file("sdk-1.4.0.pom"), file("sdk-1.4.0.jar", "pom")] })),
    );
    rejects(() =>
      adapter.parseManifest(
        init({ files: [file("sdk-1.4.0.pom"), file("sdk-1.4.0-sources.jar", "archive")] }),
      ),
    );
  });

  it("follows the packaging for the archive and accepts a BOM without one", () => {
    expect(roleOf("sdk-1.4.0.aar", "sdk-1.4.0", "aar")).toBe("archive");
    expect(roleOf("sdk-1.4.0.jar", "sdk-1.4.0", "aar")).toBe("extra");
    expect(roleOf("sdk-1.4.0.jar", "sdk-1.4.0", "maven-plugin")).toBe("archive");
    expect(roleOf("sdk-1.4.0.jar", "sdk-1.4.0", "pom")).toBe("extra");
    expect(roleOf("sdk-1.4.0.pom", "sdk-1.4.0", "pom")).toBe("pom");
    expect(roleOf("sdk-1.4.1.jar", "sdk-1.4.0", "jar")).toBeNull();
    expect(roleOf("sdk-1.4.0", "sdk-1.4.0", "jar")).toBeNull();
    expect(roleOf("sdk-1.4.0x.jar", "sdk-1.4.0", "jar")).toBeNull();
    expect(archiveExtension("war")).toBe("war");
    const bom = adapter.parseManifest(
      init({
        name: "com.acme:bom",
        files: [file("bom-1.4.0.pom", "pom")],
        manifest: {
          groupId: "com.acme",
          artifactId: "bom",
          version: "1.4.0",
          packaging: "pom",
          pom: pomFor("com.acme", "bom", "1.4.0", "pom"),
          dependencies: [],
        },
      }),
    );
    expect(bom.files).toEqual([file("bom-1.4.0.pom", "pom")]);
  });

  it("requires the POM and rejects checksum files and foreign names", () => {
    rejects(() => adapter.parseManifest(init({ files: [file("sdk-1.4.0.jar")] })));
    for (const name of [
      "sdk-1.4.0.jar.sha1",
      "sdk-1.4.0.jar.MD5",
      "sdk-1.4.0.pom.sha256",
      "sdk-1.4.0.jar.sha512",
      "other-1.4.0.jar",
      "sdk-1.4.jar",
    ]) {
      rejects(() => adapter.parseManifest(init({ files: [file("sdk-1.4.0.pom"), file(name)] })));
    }
  });

  it("checks the coordinates, version and manifest", () => {
    const manifest = init().manifest;
    rejects(() => adapter.parseManifest(init({ name: "com.acme.sdk" })));
    rejects(() => adapter.parseManifest(init({ name: "com..acme:sdk" })));
    rejects(() => adapter.parseManifest(init({ name: "com.acme:sdk/x" })));
    rejects(() => adapter.parseManifest(init({ name: "com.acme:other" })));
    rejects(() => adapter.parseManifest(init({ version: "1.4.0-SNAPSHOT" })));
    rejects(() => adapter.parseManifest(init({ version: "1.4.1" })));
    rejects(() => adapter.parseManifest(init({ tag: "latest" })));
    rejects(() => adapter.parseManifest(init({ manifest: { ...manifest, groupId: "com.other" } })));
    rejects(() => adapter.parseManifest(init({ manifest: { ...manifest, packaging: "" } })));
    rejects(() => adapter.parseManifest(init({ manifest: { ...manifest, pom: "" } })));
    rejects(() => adapter.parseManifest(init({ manifest: { ...manifest, dependencies: {} } })));
    const dep = SDK_DEPENDENCIES[0];
    for (const bad of [
      { ...dep, scope: "compiled" },
      { ...dep, optional: "false" },
      { ...dep, version: "" },
      { ...dep, artifactId: "" },
      "com.acme:http",
    ]) {
      rejects(() =>
        adapter.parseManifest(init({ manifest: { ...manifest, dependencies: [bad] } })),
      );
    }
    const missing = adapter.parseManifest(
      init({
        manifest: { ...manifest, dependencies: [{ ...dep, version: undefined }] },
      }),
    );
    expect((missing.native.dependencies as { version: unknown }[])[0]?.version).toBeNull();
  });
});

describe("dependencies", () => {
  it("keeps compile and runtime dependencies that are not optional and have a version", () => {
    expect(adapter.dependencies(adapter.parseManifest(init()))).toEqual([
      { name: "com.acme:http", constraint: "[1.0,2.0)" },
      { name: "com.squareup.okhttp3:okhttp", constraint: "[4.12.0]" },
      { name: "com.acme:logging", constraint: "[0.3.2]" },
    ]);
    expect(adapter.satisfies("1.9.3", "[1.0,2.0)")).toBe(true);
    expect(adapter.satisfies("0.3.2", "[0.3.2]")).toBe(true);
    expect(adapter.satisfies("0.3.3", "[0.3.2]")).toBe(false);
    const m = stored("1.0.0");
    expect(
      adapter.dependencies({ ...m, native: { dependencies: [null, { groupId: 1 }] } }),
    ).toEqual([]);
  });
});

describe("versions", () => {
  it("orders by ComparableVersion with a total order for equal versions", () => {
    expect(adapter.compareVersions("1.10", "1.9")).toBeGreaterThan(0);
    expect(adapter.compareVersions("1.0-rc1", "1.0")).toBeLessThan(0);
    expect(adapter.compareVersions("1.0", "1.0.0")).toBeLessThan(0);
    expect(adapter.compareVersions("1.0", "1.0")).toBe(0);
    expect(adapter.validateVersion("2.3.1.Final")).toBe(true);
    expect(adapter.validateVersion("1.0-SNAPSHOT")).toBe(false);
    expect(adapter.validateRange("[1.0,2.0)")).toBe(true);
    expect(adapter.validateRange("^1.0")).toBe(false);
    expect(adapter.satisfies("3.0", "1.0")).toBe(true);
  });

  it("splits coordinates", () => {
    expect(splitCoordinates("com.acme:sdk-core_2")).toEqual({
      groupId: "com.acme",
      artifactId: "sdk-core_2",
    });
    for (const name of ["com.acme", ":sdk", "com.acme:", "com acme:sdk", "a:b:c"]) {
      expect(splitCoordinates(name), name).toBeNull();
    }
  });
});

describe("buildIndex and filterIndex", () => {
  const manifests = [
    stored("1.3.0", { published: "2026-10-20T08:00:00Z" }),
    stored("1.5.0-rc1", { published: "2026-10-28T10:12:00Z" }),
    stored("1.4.0", { published: "2026-10-25T09:30:15Z" }),
    stored("1.2.0", { yanked: true, published: "2026-10-27T00:00:00Z" }),
  ];

  it("stores every version with its checksums, ascending", () => {
    const body = index(manifests) as { versions: { version: string }[] };
    expect(body).toMatchObject({ name: "com.acme:sdk", groupId: "com.acme", artifactId: "sdk" });
    expect(body.versions.map((v) => v.version)).toEqual(["1.2.0", "1.3.0", "1.4.0", "1.5.0-rc1"]);
    expect(body.versions[0]).toEqual({
      version: "1.2.0",
      published: "2026-10-27T00:00:00Z",
      yanked: true,
      files: {
        "sdk-1.2.0.pom": {
          sha256: SHA,
          sha1: "0".repeat(40),
          md5: "0".repeat(32),
          sha512: "0".repeat(128),
        },
        "sdk-1.2.0.jar": {
          sha256: SHA,
          sha1: "1".repeat(40),
          md5: "1".repeat(32),
          sha512: "1".repeat(128),
        },
      },
    });
    expect(adapter.buildIndex("not-maven", manifests, { publicUrl: BASE })).toEqual([]);
  });

  it("generates maven-metadata.xml from the visible, non-yanked versions", async () => {
    const res = await serve(index(manifests), "/maven/com/acme/sdk/maven-metadata.xml");
    expect(res.contentType).toBe("application/xml");
    expect(res.body).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<metadata>\n` +
        `  <groupId>com.acme</groupId>\n` +
        `  <artifactId>sdk</artifactId>\n` +
        `  <versioning>\n` +
        `    <latest>1.5.0-rc1</latest>\n` +
        `    <release>1.4.0</release>\n` +
        `    <versions>\n` +
        `      <version>1.3.0</version>\n` +
        `      <version>1.4.0</version>\n` +
        `      <version>1.5.0-rc1</version>\n` +
        `    </versions>\n` +
        `    <lastUpdated>20261028101200</lastUpdated>\n` +
        `  </versioning>\n` +
        `</metadata>\n`,
    );
    const narrow = await serve(
      index(manifests),
      "/maven/com/acme/sdk/maven-metadata.xml",
      (_n, v) => v !== "1.4.0" && v !== "1.3.0",
    );
    expect(narrow.body).not.toContain("<release>");
    expect(narrow.body).toContain("<lastUpdated>20261028101200</lastUpdated>");
    const older = await serve(index(manifests), "/maven/com/acme/sdk/maven-metadata.xml", (_n, v) =>
      ["1.3.0", "1.4.0"].includes(v),
    );
    expect(older.body).toContain("<latest>1.4.0</latest>");
    expect(older.body).toContain("<lastUpdated>20261025093015</lastUpdated>");
    rejects(
      () =>
        adapter.filterIndex(
          index(manifests),
          (_n, v) => v === "1.2.0",
          get("/maven/com/acme/sdk/maven-metadata.xml") as IndexRoute,
        ),
      "not_found",
    );
    rejects(() => adapter.filterIndex({ versions: {} }, all), "internal_error");
  });

  it("computes the metadata checksums from the served XML", async () => {
    const body = index(manifests);
    const allowed: Allowed = (_n, v) => v !== "1.5.0-rc1";
    const xml = (await serve(body, "/maven/com/acme/sdk/maven-metadata.xml", allowed)).body;
    const names = { sha1: "SHA-1", md5: "MD5", sha256: "SHA-256", sha512: "SHA-512" };
    for (const [ext, algorithm] of Object.entries(names)) {
      const res = await serve(body, `/maven/com/acme/sdk/maven-metadata.xml.${ext}`, allowed);
      expect(res.contentType).toBe("text/plain");
      expect(res.body).toBe(await hex(algorithm, xml));
    }
  });

  it("serves file checksums, yanked versions included", async () => {
    const body = index(manifests);
    const sum = async (path: string, allowed = all) => (await serve(body, path, allowed)).body;
    expect(await sum("/maven/com/acme/sdk/1.2.0/sdk-1.2.0.jar.sha1")).toBe("1".repeat(40));
    expect(await sum("/maven/com/acme/sdk/1.4.0/sdk-1.4.0.pom.md5")).toBe("0".repeat(32));
    expect(await sum("/maven/com/acme/sdk/1.4.0/sdk-1.4.0.jar.sha512")).toBe("1".repeat(128));
    expect(await sum("/maven/com/acme/sdk/1.4.0/sdk-1.4.0.jar.sha256")).toBe(SHA);
    const missing = (path: string, allowed = all) =>
      rejects(() => adapter.filterIndex(body, allowed, get(path) as IndexRoute), "not_found");
    missing("/maven/com/acme/sdk/1.4.0/sdk-1.4.0-sources.jar.sha1");
    missing("/maven/com/acme/sdk/1.4.0/sdk-1.4.0.jar.sha1", (_n, v) => v !== "1.4.0");
    missing("/maven/com/acme/sdk/9.0/sdk-9.0.jar.sha1");
    const withoutDigests = JSON.parse(
      adapter.buildIndex(
        "com.acme:sdk",
        [{ ...stored("1.0.0"), files: [{ name: "sdk-1.0.0.pom", size: 1, sha256: SHA }] }],
        { publicUrl: BASE },
      )[0]?.body ?? "null",
    ) as unknown;
    rejects(
      () =>
        adapter.filterIndex(
          withoutDigests,
          all,
          get("/maven/com/acme/sdk/1.0.0/sdk-1.0.0.pom.sha1") as IndexRoute,
        ),
      "not_found",
    );
  });
});

describe("route", () => {
  it("parses repository paths from their end", () => {
    expect(get("/maven/com/acme/sdk/maven-metadata.xml")).toEqual({
      kind: "index",
      key: KEY,
      name: "com.acme:sdk",
      view: "metadata",
    });
    expect(get("/maven/com/acme/sdk/maven-metadata.xml.sha1")).toMatchObject({
      view: "metadata.sha1",
    });
    expect(get("/maven/com/acme/sdk/1.4.0/maven-metadata.xml")).toEqual({
      kind: "index",
      key: "maven/index/com.acme.sdk/1.4.0/index.json",
      name: "com.acme.sdk:1.4.0",
      view: "metadata",
    });
    expect(get("/maven/com/acme/sdk/1.4.0/sdk-1.4.0.jar")).toEqual({
      kind: "archive",
      name: "com.acme:sdk",
      version: "1.4.0",
      file: "sdk-1.4.0.jar",
    });
    expect(get("/maven/com/acme/sdk/1.4.0/sdk-1.4.0.jar.asc")).toMatchObject({ kind: "archive" });
    expect(get("/maven/com/acme/sdk/1.4.0/sdk-1.4.0.jar.md5")).toEqual({
      kind: "index",
      key: KEY,
      name: "com.acme:sdk",
      view: "file.md5",
      selector: { version: "1.4.0", file: "sdk-1.4.0.jar" },
    });
    expect(get("/maven/acme/sdk/2.3.1.Final/sdk-2.3.1.Final.pom")).toMatchObject({
      name: "acme:sdk",
      version: "2.3.1.Final",
    });
  });

  it("rejects other paths and methods", () => {
    for (const path of [
      "/maven",
      "/maven/",
      "/maven/sdk/maven-metadata.xml",
      "/maven/sdk/1.4.0/sdk-1.4.0.jar",
      "/maven/com/acme/sdk/1.4.0-SNAPSHOT/sdk-1.4.0-SNAPSHOT.jar",
      "/maven/com/acme/sdk/1.4.0/sdk%201.jar",
      "/maven/com/ac.me/sdk/1.4.0/sdk-1.4.0.jar",
      "/maven/com//sdk/1.4.0/sdk-1.4.0.jar",
      "/nuget/index.json",
    ]) {
      expect(get(path), path).toBeNull();
    }
    expect(get("/maven/com/acme/sdk/maven-metadata.xml", "PUT")).toBeNull();
  });
});

describe("URLs and snippets", () => {
  it("points at every file in the repository layout", () => {
    const m = adapter.parseManifest(init());
    expect(adapter.versionUrl(m, BASE)).toBe(`${REPO}/1.4.0/sdk-1.4.0.jar`);
    expect(m.files.map((f) => adapter.fileUrl(m, f, BASE))).toEqual([
      `${REPO}/1.4.0/sdk-1.4.0.pom`,
      `${REPO}/1.4.0/sdk-1.4.0.jar`,
      `${REPO}/1.4.0/sdk-1.4.0.module`,
      `${REPO}/1.4.0/sdk-1.4.0-sources.jar`,
      `${REPO}/1.4.0/sdk-1.4.0-javadoc.jar`,
    ]);
    const pomOnly = { ...m, files: m.files.slice(0, 1) };
    expect(adapter.versionUrl(pomOnly, BASE)).toBe(`${REPO}/1.4.0/sdk-1.4.0.pom`);
    expect(adapter.fileKey(m, m.files[1] ?? m.files[0] ?? file("x"))).toBe(
      "maven/pkg/com.acme:sdk/1.4.0/sdk-1.4.0.jar",
    );
    expect(mavenIndexKey("com.acme", "sdk")).toBe(KEY);
  });

  it("configures Maven and Gradle", () => {
    const snippets = adapter.clientConfig(`${BASE}/`, "shop:key.abc", ["com.acme:sdk"]);
    expect(snippets.map((s) => s.filename)).toEqual([
      "~/.m2/settings.xml",
      "pom.xml",
      "build.gradle.kts",
    ]);
    expect(snippets[0]?.body).toContain("<username>shop</username>");
    expect(snippets[0]?.body).toContain("<password>key.abc</password>");
    expect(snippets[1]?.body).toContain(`<url>${BASE}/maven</url>`);
    expect(snippets[1]?.body).toContain("<artifactId>sdk</artifactId>");
    expect(snippets[2]?.body).toContain(`url = uri("${BASE}/maven")`);
    expect(snippets[2]?.body).toContain('implementation("com.acme:sdk:1.0.0")');
    expect(adapter.clientConfig(BASE, "shop:x", [])[2]?.body).toContain("com.acme:sdk:1.0.0");
  });
});
