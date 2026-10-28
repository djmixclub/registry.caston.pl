import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { stagingKey } from "../../src/core/storage";
import dumpPackage from "../fixtures/swift/dump-package.json";
import { ORIGIN, call, credential, sha256Hex, type ErrorBody, type InitResult } from "./helpers";

interface Problem {
  status: number;
  title: string;
  detail: string;
}

interface Releases {
  releases: Record<string, { url: string; problem?: Problem }>;
}

const V1_JSON = { accept: "application/vnd.swift.registry.v1+json" };
const RELEASE = `${ORIGIN}/swift/acme/Networking`;

let admin: string;
let ci: string;
let reader: string;
let narrow: string;

function manifestSource(id: string, version: string, swift = "5.9"): string {
  return (
    `// swift-tools-version:${swift}\n` +
    `// ${id} ${version}\n` +
    `import PackageDescription\n\n` +
    `let package = Package(name: "${id.split(".")[1] ?? id}")\n`
  );
}

/** init with the archive and the manifests, the simulated presigned PUTs, and commit. */
async function publish(
  token: string,
  id: string,
  version: string,
  options: { variants?: string[]; dump?: unknown; repositoryURL?: string } = {},
): Promise<Response> {
  const name = id.split(".")[1] ?? id;
  const files = [
    { name: `${name}-${version}.zip`, role: "archive", content: `zip of ${id}@${version}` },
    { name: "Package.swift", role: "manifest", content: manifestSource(id, version) },
    ...(options.variants ?? []).map((v) => ({
      name: `Package@swift-${v}.swift`,
      role: "manifest",
      content: manifestSource(id, version, v),
    })),
  ];
  const declared = await Promise.all(
    files.map(async (f) => {
      const bytes = new TextEncoder().encode(f.content);
      return { ...f, bytes, sha256: await sha256Hex(bytes) };
    }),
  );
  const init = await call("POST", "/api/v1/publish/init", {
    token,
    body: {
      eco: "swift",
      name: id,
      version,
      files: declared.map((f) => ({
        name: f.name,
        size: f.bytes.length,
        sha256: f.sha256,
        role: f.role,
      })),
      manifest: {
        toolsVersion: "5.9",
        repositoryURL: options.repositoryURL ?? `https://github.com/acme/${name.toLowerCase()}.git`,
        dumpPackage: options.dump ?? { name, dependencies: [], toolsVersion: { _version: "5.9" } },
      },
    },
  });
  if (init.status !== 200) return init;
  const { uploadId } = await init.json<InitResult>();
  for (const f of declared) {
    await env.R2_BUCKET.put(stagingKey(uploadId, f.name), f.bytes, { sha256: f.sha256 });
  }
  return call("POST", "/api/v1/publish/commit", { token, body: { uploadId } });
}

function basic(token: string, headers: Record<string, string> = V1_JSON): Record<string, string> {
  return { authorization: `Basic ${btoa(token)}`, ...headers };
}

async function swift(path: string, token = reader, headers?: Record<string, string>) {
  return call("GET", path, { headers: basic(token, headers) });
}

async function releases(path: string, token = reader): Promise<Record<string, unknown> | number> {
  const res = await swift(path, token);
  if (res.status !== 200) return res.status;
  return (await res.json<Releases>()).releases;
}

beforeAll(async () => {
  admin = await credential("swift-admin", "admin");
  ci = await credential("swift-ci", "publish", [
    { eco: "swift", package: "acme.*", versions: "*" },
  ]);
  reader = await credential("swift-app", "read", [
    { eco: "swift", package: "ACME.networking", versions: "*" },
  ]);
  narrow = await credential("swift-narrow", "read", [
    { eco: "swift", package: "acme.Networking", versions: "<1.1.0", transitive: false },
  ]);
  const published: [string, string, Parameters<typeof publish>[3]][] = [
    ["acme.HTTPTypes", "1.0.0", {}],
    ["acme.HTTPTypes", "1.4.0", {}],
    ["acme.HTTPTypes", "2.0.0", {}],
    ["acme.Internal", "1.0.0", { repositoryURL: "https://github.com/acme/networking" }],
    ["acme.Networking", "1.1.0", { dump: dumpPackage }],
    ["acme.Networking", "1.2.0-beta.1", { dump: dumpPackage, variants: ["5.8", "5.10"] }],
  ];
  for (const [id, version, options] of published) {
    expect((await publish(ci, id, version, options)).status).toBe(201);
  }
});

describe("swift publishing", () => {
  it("answers commit with the archive and manifest URLs", async () => {
    const res = await publish(ci, "acme.Networking", "1.0.0", { variants: ["5.8"] });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      eco: "swift",
      name: "acme.networking",
      version: "1.0.0",
      url: `${RELEASE}/1.0.0.zip`,
      files: [
        { name: "Networking-1.0.0.zip", url: `${RELEASE}/1.0.0.zip` },
        { name: "Package.swift", url: `${RELEASE}/1.0.0/Package.swift` },
        {
          name: "Package@swift-5.8.swift",
          url: `${RELEASE}/1.0.0/Package.swift?swift-version=5.8`,
        },
      ],
    });
  });

  it("treats identities case-insensitively", async () => {
    const res = await publish(ci, "Acme.networking", "1.0.0");
    expect(res.status).toBe(409);
    expect((await res.json<ErrorBody>()).error).toBe("version_exists");
  });

  it("accepts @ in file names for swift only", async () => {
    const res = await call("POST", "/api/v1/publish/init", {
      token: await credential("swift-generic-ci", "publish", [
        { eco: "generic", package: "*", versions: "*" },
      ]),
      body: {
        eco: "generic",
        name: "acme/tool",
        version: "1.0.0",
        files: [{ name: "tool@2.bin", size: 1, sha256: "a".repeat(64) }],
        manifest: {},
      },
    });
    expect(res.status).toBe(400);
  });
});

describe("swift registry", () => {
  it("lists the granted releases with Content-Version", async () => {
    const res = await swift("/swift/acme/networking");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-version")).toBe("1");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({
      releases: {
        "1.2.0-beta.1": { url: `${RELEASE}/1.2.0-beta.1` },
        "1.1.0": { url: `${RELEASE}/1.1.0` },
        "1.0.0": { url: `${RELEASE}/1.0.0` },
      },
    });
    expect(await releases("/swift/ACME/Networking", narrow)).toEqual({
      "1.0.0": { url: `${RELEASE}/1.0.0` },
    });
    expect(await releases("/swift/acme/Internal")).toBe(404);
    expect(await releases("/swift/acme/Nothing", admin)).toBe(404);
  });

  it("serves release metadata with Link headers", async () => {
    const res = await swift("/swift/acme/Networking/1.1.0");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-version")).toBe("1");
    expect(res.headers.get("content-type")).toBe("application/json");
    const zip = new TextEncoder().encode("zip of acme.Networking@1.1.0");
    expect(await res.json()).toEqual({
      id: "acme.Networking",
      version: "1.1.0",
      resources: [
        { name: "source-archive", type: "application/zip", checksum: await sha256Hex(zip) },
      ],
      metadata: { repositoryURLs: ["https://github.com/acme/networking.git"] },
      publishedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    });
    expect(res.headers.get("link")).toBe(
      `<${RELEASE}/1.2.0-beta.1>; rel="latest-version", ` +
        `<${RELEASE}/1.2.0-beta.1>; rel="successor-version", ` +
        `<${RELEASE}/1.0.0>; rel="predecessor-version"`,
    );
    const outside = await swift("/swift/acme/Networking/1.1.0", narrow);
    expect(outside.status).toBe(404);
    expect(outside.headers.get("content-type")).toBe("application/problem+json");
    expect(outside.headers.get("content-version")).toBe("1");
    expect(await outside.json()).toEqual({ status: 404, title: "Not Found", detail: "Not found." });
    const only = await swift("/swift/acme/Networking/1.0.0", narrow);
    expect(only.headers.get("link")).toBe(`<${RELEASE}/1.0.0>; rel="latest-version"`);
  });

  it("serves Package.swift and its variants from storage", async () => {
    const base = "/swift/acme/networking/1.2.0-beta.1/Package.swift";
    const accept = { accept: "application/vnd.swift.registry.v1+swift" };
    const res = await swift(base, reader, accept);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-swift");
    expect(res.headers.get("content-version")).toBe("1");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe(manifestSource("acme.Networking", "1.2.0-beta.1"));
    const alternate = (v: string) =>
      `<${RELEASE}/1.2.0-beta.1/Package.swift?swift-version=${v}>; rel="alternate"; ` +
      `filename="Package@swift-${v}.swift"; swift-tools-version="${v}"`;
    expect(res.headers.get("link")).toBe(`${alternate("5.8")}, ${alternate("5.10")}`);
    const variant = await swift(`${base}?swift-version=5.9`, reader, accept);
    expect(await variant.text()).toBe(manifestSource("acme.Networking", "1.2.0-beta.1", "5.8"));
    expect(variant.headers.get("link")).toBe(alternate("5.10"));
    const exact = await swift(`${base}?swift-version=5.10`, reader, accept);
    expect(await exact.text()).toBe(manifestSource("acme.Networking", "1.2.0-beta.1", "5.10"));
    const old = await swift(`${base}?swift-version=5.7`, reader, accept);
    expect(await old.text()).toBe(manifestSource("acme.Networking", "1.2.0-beta.1"));
    expect((await swift(base, narrow, accept)).status).toBe(404);
    expect((await swift("/swift/acme/Networking/9.0.0/Package.swift", admin)).status).toBe(404);
  });

  it("redirects the source archive with its Digest", async () => {
    const res = await swift("/swift/acme/Networking/1.0.0.zip", reader, {
      accept: "application/vnd.swift.registry.v1+zip",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("content-version")).toBe("1");
    const zip = new TextEncoder().encode("zip of acme.Networking@1.0.0");
    const digest = btoa(
      String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", zip))),
    );
    expect(res.headers.get("digest")).toBe(`sha-256=${digest}`);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://test-account.r2.cloudflarestorage.com");
    expect(location.pathname).toBe(
      "/serverless-registry/swift/pkg/acme.networking/1.0.0/Networking-1.0.0.zip",
    );
    expect((await swift("/swift/acme/Networking/1.1.0.zip", narrow)).status).toBe(404);
  });

  it("maps repository URLs to visible identities", async () => {
    const lookup = async (url: string, token = reader) => {
      const res = await swift(`/swift/identifiers?url=${encodeURIComponent(url)}`, token);
      return res.status === 200 ? res.json() : res.status;
    };
    expect(await lookup("https://github.com/acme/networking")).toEqual({
      identifiers: ["acme.Networking"],
    });
    expect(await lookup("https://GITHUB.com/acme/Networking.git", narrow)).toEqual({
      identifiers: ["acme.Networking"],
    });
    expect(await lookup("https://github.com/acme/networking", admin)).toEqual({
      identifiers: ["acme.Internal", "acme.Networking"],
    });
    expect(await lookup("https://github.com/acme/unknown")).toBe(404);
    expect((await swift("/swift/identifiers", reader)).status).toBe(400);
  });

  it("checks credentials on login", async () => {
    const ok = await call("POST", "/swift/login", { headers: basic(reader) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-version")).toBe("1");
    expect(await ok.text()).toBe("");
    expect((await call("POST", "/swift/login", { headers: basic(ci) })).status).toBe(200);
    const wrong = await call("POST", "/swift/login", { headers: basic("swift-app:wrong") });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toBe(
      'Basic realm="serverless-registry", Bearer realm="serverless-registry"',
    );
    expect(wrong.headers.get("content-type")).toBe("application/problem+json");
    expect((await wrong.json<Problem>()).title).toBe("Unauthorized");
    expect((await call("GET", "/swift/login", { headers: basic(reader) })).status).toBe(404);
  });

  it("negotiates the API version and rejects publish credentials", async () => {
    const v2 = await swift("/swift/acme/Networking", reader, {
      accept: "application/vnd.swift.registry.v2+json",
    });
    expect(v2.status).toBe(415);
    expect(v2.headers.get("content-type")).toBe("application/problem+json");
    expect(v2.headers.get("content-version")).toBe("1");
    expect((await v2.json<Problem>()).title).toBe("Unsupported Media Type");
    expect((await swift("/swift/acme/Networking", reader, { accept: "*/*" })).status).toBe(200);
    expect((await call("GET", "/swift/acme/Networking", { token: reader })).status).toBe(200);
    const publisher = await swift("/swift/acme/Networking", ci);
    expect(publisher.status).toBe(403);
    expect((await publisher.json<Problem>()).status).toBe(403);
    const anonymous = await call("GET", "/swift/acme/Networking");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("content-version")).toBe("1");
  });

  it("opens registry dependencies transitively", async () => {
    // acme.Networking 1.1.0 and 1.2.0-beta.1 depend on acme.HTTPTypes >=1.1.0 <2.0.0.
    expect(await releases("/swift/acme/HTTPTypes")).toEqual({
      "1.4.0": { url: `${ORIGIN}/swift/acme/HTTPTypes/1.4.0` },
    });
    expect((await swift("/swift/acme/HTTPTypes/1.4.0.zip")).status).toBe(302);
    expect((await swift("/swift/acme/HTTPTypes/2.0.0.zip")).status).toBe(404);
    expect(await releases("/swift/acme/HTTPTypes", narrow)).toBe(404);
    const listed = await call("GET", "/api/v1/packages/swift/acme.networking", { token: reader });
    expect((await listed.json<{ dependencies: unknown }>()).dependencies).toEqual([
      { name: "acme.httptypes", constraints: [">=1.1.0 <2.0.0"], versions: ["1.4.0"] },
    ]);
  });

  it("marks yanked releases and answers 410 for their metadata", async () => {
    const yank = await call("POST", "/api/v1/packages/swift/acme.networking/1.1.0/yank", {
      token: admin,
    });
    expect(yank.status).toBe(200);
    expect(await releases("/swift/acme/Networking")).toEqual({
      "1.2.0-beta.1": { url: `${RELEASE}/1.2.0-beta.1` },
      "1.1.0": {
        url: `${RELEASE}/1.1.0`,
        problem: { status: 410, title: "Gone", detail: "this release was yanked" },
      },
      "1.0.0": { url: `${RELEASE}/1.0.0` },
    });
    const gone = await swift("/swift/acme/Networking/1.1.0");
    expect(gone.status).toBe(410);
    expect(gone.headers.get("content-type")).toBe("application/problem+json");
    expect(gone.headers.get("content-version")).toBe("1");
    expect(await gone.json()).toEqual({
      status: 410,
      title: "Gone",
      detail: "this release was yanked",
    });
    const neighbour = await swift("/swift/acme/Networking/1.0.0");
    expect(neighbour.headers.get("link")).toBe(
      `<${RELEASE}/1.2.0-beta.1>; rel="latest-version", ` +
        `<${RELEASE}/1.2.0-beta.1>; rel="successor-version"`,
    );
    expect((await swift("/swift/acme/Networking/1.1.0.zip")).status).toBe(302);
    expect((await swift("/swift/acme/Networking/1.1.0/Package.swift")).status).toBe(200);
  });
});
