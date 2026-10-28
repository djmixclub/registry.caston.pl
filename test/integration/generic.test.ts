import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { Manifest } from "../../src/adapters/types";
import { manifestKey, readManifest, stagingKey } from "../../src/core/storage";
import { ORIGIN, call, credential, sha256Hex, type ErrorBody, type InitResult } from "./helpers";

interface Upload {
  name: string;
  content: string;
  labels?: Record<string, string>;
}

interface FeedFile {
  name: string;
  size: number;
  sha256: string;
  labels: Record<string, string>;
  url: string;
}

interface FeedVersion {
  published: string;
  yanked: boolean;
  meta: Record<string, unknown>;
  files: FeedFile[];
}

interface PackageDoc {
  name: string;
  latest: string | null;
  versions: Record<string, FeedVersion>;
}

interface VersionDoc extends FeedVersion {
  name: string;
  version: string;
}

const NAME = "acme/plugin-foo";
const PATH = "/generic/acme%2Fplugin-foo";
const WINDOWS = { platform: "x86_64-pc-windows-msvc", kind: "library" };
const LINUX = { platform: "x86_64-unknown-linux-gnu", kind: "library" };
const MAC = { platform: "aarch64-apple-darwin", kind: "library" };

let admin: string;
let ci: string;
let reader: string;
let narrow: string;

/** init, the presigned PUTs (simulated by writing to staging, as R2 would) and commit. */
async function publish(
  token: string,
  name: string,
  version: string,
  files: Upload[],
  options: { meta?: Record<string, unknown>; append?: boolean } = {},
): Promise<Response> {
  const declared = await Promise.all(
    files.map(async (f) => {
      const bytes = new TextEncoder().encode(f.content);
      return { file: f, bytes, sha256: await sha256Hex(bytes) };
    }),
  );
  const init = await call("POST", "/api/v1/publish/init", {
    token,
    body: {
      eco: "generic",
      name,
      version,
      files: declared.map(({ file, bytes, sha256 }) => ({
        name: file.name,
        size: bytes.length,
        sha256,
        ...(file.labels === undefined ? {} : { labels: file.labels }),
      })),
      manifest: options.meta ?? {},
      ...(options.append === undefined ? {} : { append: options.append }),
    },
  });
  if (init.status !== 200) return init;
  const { uploadId } = await init.json<InitResult>();
  for (const { file, bytes, sha256 } of declared) {
    await env.R2_BUCKET.put(stagingKey(uploadId, file.name), bytes, { sha256 });
  }
  return call("POST", "/api/v1/publish/commit", { token, body: { uploadId } });
}

async function json<T>(path: string, token = reader, status = 200): Promise<T> {
  const res = await call("GET", path, { token });
  expect(res.status).toBe(status);
  return res.json<T>();
}

async function statusOf(path: string, token = reader): Promise<number> {
  return (await call("GET", path, { token })).status;
}

/** Moves the `published` timestamp of a stored version into the past. */
async function age(name: string, version: string, published: string): Promise<void> {
  const m = await readManifest(env, "generic", name, version);
  if (m === null) throw new Error("missing manifest");
  const aged: Manifest = { ...m, published };
  await env.R2_BUCKET.put(manifestKey("generic", name, version), JSON.stringify(aged));
}

beforeAll(async () => {
  admin = await credential("generic-admin", "admin");
  ci = await credential("generic-ci", "publish", [
    { eco: "generic", package: "acme/*", versions: "*" },
    { eco: "generic", package: "acme-tool", versions: "*" },
  ]);
  reader = await credential("generic-app", "read", [
    { eco: "generic", package: "acme/*", versions: "*" },
  ]);
  narrow = await credential("generic-narrow", "read", [
    { eco: "generic", package: "acme/plugin-foo", versions: "^1.0" },
  ]);

  const first = await publish(
    ci,
    NAME,
    "1.4.0",
    [
      { name: "plugin_foo-x86_64-pc-windows-msvc.dll", content: "windows", labels: WINDOWS },
      { name: "plugin_foo-x86_64-unknown-linux-gnu.so", content: "linux", labels: LINUX },
    ],
    { meta: { minAppVersion: "3.2" }, append: true },
  );
  expect(first.status).toBe(201);
  for (const [version, meta] of [
    ["1.0.0", { minAppVersion: "3.0" }],
    ["1.5.0", { minAppVersion: "3.3" }],
    ["2.0.0-beta.1", { minAppVersion: "4.0" }],
  ] as const) {
    const res = await publish(
      ci,
      NAME,
      version,
      [{ name: `plugin_foo-${version}.so`, content: version, labels: LINUX }],
      { meta },
    );
    expect(res.status).toBe(201);
  }
  expect((await publish(ci, "acme/other", "0.1.0", [{ name: "o.bin", content: "o" }])).status).toBe(
    201,
  );
  expect((await publish(ci, "acme-tool", "1.0.0", [{ name: "t.bin", content: "t" }])).status).toBe(
    201,
  );
});

describe("generic publishing", () => {
  it("answers commit with the feed URLs and appends files within the window", async () => {
    const res = await publish(
      ci,
      NAME,
      "1.4.0",
      [{ name: "plugin_foo-aarch64-apple-darwin.dylib", content: "mac", labels: MAC }],
      { meta: { ignored: true }, append: true },
    );
    expect(res.status).toBe(201);
    const version = `${ORIGIN}${PATH}/1.4.0`;
    expect(await res.json()).toEqual({
      eco: "generic",
      name: NAME,
      version: "1.4.0",
      url: version,
      files: [
        {
          name: "plugin_foo-aarch64-apple-darwin.dylib",
          url: `${version}/plugin_foo-aarch64-apple-darwin.dylib`,
        },
      ],
    });
    const doc = await json<VersionDoc>(`${PATH}/1.4.0`);
    expect(doc.meta).toEqual({ minAppVersion: "3.2" });
    expect(doc.files.map((f) => f.name)).toEqual([
      "plugin_foo-x86_64-pc-windows-msvc.dll",
      "plugin_foo-x86_64-unknown-linux-gnu.so",
      "plugin_foo-aarch64-apple-darwin.dylib",
    ]);
  });

  it("answers 409 file_exists for a file already in the version", async () => {
    const res = await publish(
      ci,
      NAME,
      "1.4.0",
      [{ name: "plugin_foo-x86_64-pc-windows-msvc.dll", content: "again" }],
      { append: true },
    );
    expect(res.status).toBe(409);
    expect((await res.json<ErrorBody>()).error).toBe("file_exists");
  });

  it("answers 409 version_exists without append", async () => {
    const res = await publish(ci, NAME, "1.4.0", [{ name: "new.bin", content: "n" }]);
    expect(res.status).toBe(409);
    expect((await res.json<ErrorBody>()).error).toBe("version_exists");
  });

  it("answers 409 version_closed after the append window", async () => {
    await publish(ci, "acme/closed", "1.0.0", [{ name: "a.bin", content: "a" }]);
    await age("acme/closed", "1.0.0", "2026-01-01T00:00:00Z");
    const res = await publish(ci, "acme/closed", "1.0.0", [{ name: "b.bin", content: "b" }], {
      append: true,
    });
    expect(res.status).toBe(409);
    expect((await res.json<ErrorBody>()).error).toBe("version_closed");
  });

  it("rejects names with __, bad labels and dist-tags", async () => {
    const bad = await publish(ci, "acme/x__y", "1.0.0", [{ name: "a.bin", content: "a" }]);
    expect(bad.status).toBe(400);
    expect((await bad.json<ErrorBody>()).error).toBe("invalid_request");
    const label = await publish(ci, "acme/labels", "1.0.0", [
      { name: "a.bin", content: "a", labels: { Platform: "x" } },
    ]);
    expect(label.status).toBe(400);
    const tag = await call("POST", "/api/v1/publish/init", {
      token: ci,
      body: {
        eco: "generic",
        name: "acme/tagged",
        version: "1.0.0",
        files: [{ name: "a.bin", size: 1, sha256: "a".repeat(64) }],
        manifest: {},
        tag: "latest",
      },
    });
    expect(tag.status).toBe(400);
  });
});

describe("generic feed", () => {
  it("lists the visible packages with their latest version", async () => {
    const res = await call("GET", "/generic/", { token: reader });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = await res.json<{ packages: { name: string; latest: string | null }[] }>();
    expect(body.packages).toEqual(
      expect.arrayContaining([
        { name: "acme/other", latest: "0.1.0" },
        { name: NAME, latest: "1.5.0" },
      ]),
    );
    expect(body.packages.map((p) => p.name)).not.toContain("acme-tool");
    expect(await json("/generic", narrow)).toEqual({ packages: [{ name: NAME, latest: "1.5.0" }] });
    const all = await json<{ packages: { name: string }[] }>("/generic/", admin);
    expect(all.packages.map((p) => p.name)).toContain("acme-tool");
  });

  it("serves the package document, highest version first", async () => {
    const doc = await json<PackageDoc>(PATH);
    expect(doc.name).toBe(NAME);
    expect(doc.latest).toBe("1.5.0");
    expect(Object.keys(doc.versions)).toEqual(["2.0.0-beta.1", "1.5.0", "1.4.0", "1.0.0"]);
    const file = doc.versions["1.4.0"]?.files[0];
    expect(file).toEqual({
      name: "plugin_foo-x86_64-pc-windows-msvc.dll",
      size: 7,
      sha256: await sha256Hex(new TextEncoder().encode("windows")),
      labels: WINDOWS,
      url: `${ORIGIN}${PATH}/1.4.0/plugin_foo-x86_64-pc-windows-msvc.dll`,
    });
    expect(doc.versions["1.0.0"]?.meta).toEqual({ minAppVersion: "3.0" });
  });

  it("filters the files by labels", async () => {
    const windows = await json<PackageDoc>(`${PATH}?label=platform:x86_64-pc-windows-msvc`);
    expect(windows.versions["1.4.0"]?.files.map((f) => f.name)).toEqual([
      "plugin_foo-x86_64-pc-windows-msvc.dll",
    ]);
    expect(windows.versions["1.0.0"]?.files).toEqual([]);
    const both = await json<PackageDoc>(
      `${PATH}?label=kind:library&label=platform:aarch64-apple-darwin`,
    );
    expect(both.versions["1.4.0"]?.files.map((f) => f.name)).toEqual([
      "plugin_foo-aarch64-apple-darwin.dylib",
    ]);
    expect(await statusOf(`${PATH}?label=platform`)).toBe(400);
    expect(await statusOf(`${PATH}?include=all`)).toBe(400);
  });

  it("answers latest with and without the prerelease channel", async () => {
    expect(await json<VersionDoc>(`${PATH}/latest`)).toMatchObject({
      name: NAME,
      version: "1.5.0",
      meta: { minAppVersion: "3.3" },
    });
    const pre = await json<VersionDoc>(`${PATH}/latest?channel=prerelease&label=kind:library`);
    expect(pre.version).toBe("2.0.0-beta.1");
    expect(pre.files.map((f) => f.name)).toEqual(["plugin_foo-2.0.0-beta.1.so"]);
    // ^1.0 does not cover the prerelease.
    expect((await json<VersionDoc>(`${PATH}/latest?channel=prerelease`, narrow)).version).toBe(
      "1.5.0",
    );
    expect(await statusOf(`${PATH}/latest?channel=beta`)).toBe(400);
  });

  it("serves one version", async () => {
    const doc = await json<VersionDoc>(`${PATH}/1.0.0`);
    expect(doc).toEqual({
      name: NAME,
      version: "1.0.0",
      published: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/) as string,
      yanked: false,
      meta: { minAppVersion: "3.0" },
      files: [
        {
          name: "plugin_foo-1.0.0.so",
          size: 5,
          sha256: await sha256Hex(new TextEncoder().encode("1.0.0")),
          labels: LINUX,
          url: `${ORIGIN}${PATH}/1.0.0/plugin_foo-1.0.0.so`,
        },
      ],
    });
    expect(await statusOf(`${PATH}/9.9.9`)).toBe(404);
    expect(await statusOf(`${PATH}/2.0.0-beta.1`, narrow)).toBe(404);
  });

  it("redirects file downloads to a presigned URL", async () => {
    const res = await call("GET", `${PATH}/1.4.0/plugin_foo-x86_64-pc-windows-msvc.dll`, {
      token: reader,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://test-account.r2.cloudflarestorage.com");
    expect(location.pathname).toBe(
      "/serverless-registry/generic/pkg/acme__plugin-foo/1.4.0/plugin_foo-x86_64-pc-windows-msvc.dll",
    );
    expect(location.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(await statusOf(`${PATH}/1.4.0/missing.dll`)).toBe(404);
    expect(await statusOf(`${PATH}/2.0.0-beta.1/plugin_foo-2.0.0-beta.1.so`, narrow)).toBe(404);
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const first = await call("GET", PATH, { token: reader });
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await call("GET", PATH, { token: reader, headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe("private, no-store");
    expect(await again.text()).toBe("");
    const weak = await call("GET", PATH, {
      token: reader,
      headers: { "if-none-match": `"other", W/${etag}` },
    });
    expect(weak.status).toBe(304);
    const star = await call("GET", "/generic/", {
      token: reader,
      headers: { "if-none-match": "*" },
    });
    expect(star.status).toBe(304);
    const stale = await call("GET", PATH, { token: reader, headers: { "if-none-match": '"x"' } });
    expect(stale.status).toBe(200);
    // The body depends on the credential, and so does the ETag.
    const other = await call("GET", PATH, { token: narrow });
    expect(other.headers.get("etag")).not.toBe(etag);
  });

  it("hides yanked versions unless include=yanked", async () => {
    await publish(ci, "acme/yanked", "1.0.0", [{ name: "a.bin", content: "a" }]);
    await publish(ci, "acme/yanked", "1.1.0", [{ name: "b.bin", content: "b" }]);
    const yank = await call("POST", "/api/v1/packages/generic/acme%2Fyanked/1.1.0/yank", {
      token: admin,
    });
    expect(yank.status).toBe(200);

    const doc = await json<PackageDoc>("/generic/acme%2Fyanked");
    expect(doc.latest).toBe("1.0.0");
    expect(Object.keys(doc.versions)).toEqual(["1.0.0"]);
    const all = await json<PackageDoc>("/generic/acme%2Fyanked?include=yanked");
    expect(all.latest).toBe("1.0.0");
    expect(Object.keys(all.versions)).toEqual(["1.1.0", "1.0.0"]);
    expect(all.versions["1.1.0"]?.yanked).toBe(true);

    expect(await statusOf("/generic/acme%2Fyanked/1.1.0")).toBe(404);
    expect((await json<VersionDoc>("/generic/acme%2Fyanked/1.1.0?include=yanked")).yanked).toBe(
      true,
    );
    expect((await json<VersionDoc>("/generic/acme%2Fyanked/latest")).version).toBe("1.0.0");
    expect(await statusOf("/generic/acme%2Fyanked/1.1.0/b.bin")).toBe(302);

    const append = await publish(ci, "acme/yanked", "1.1.0", [{ name: "c.bin", content: "c" }], {
      append: true,
    });
    expect(append.status).toBe(409);
    expect((await append.json<ErrorBody>()).error).toBe("version_closed");
  });

  it("answers 404 for unknown packages, paths and methods", async () => {
    expect(await statusOf("/generic/acme%2Fnothing")).toBe(404);
    expect(await statusOf("/generic/acme-tool")).toBe(404);
    expect(await statusOf("/generic/acme/plugin-foo")).toBe(404);
    expect((await call("POST", PATH, { token: reader })).status).toBe(404);
  });

  it("answers 401 without credentials and 403 for publish credentials", async () => {
    const anonymous = await call("GET", PATH);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe('Bearer realm="serverless-registry"');
    expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
    expect(await statusOf(PATH, ci)).toBe(403);
  });

  it("accepts Basic credentials", async () => {
    const res = await call("GET", PATH, { headers: { authorization: `Basic ${btoa(reader)}` } });
    expect(res.status).toBe(200);
  });
});
