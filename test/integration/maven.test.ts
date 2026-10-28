import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { stagingKey } from "../../src/core/storage";
import { SDK_DEPENDENCIES, SDK_POM, pomFor, type PomDependency } from "../fixtures/maven/pom";
import { ORIGIN, call, credential, sha256Hex, type ErrorBody, type InitResult } from "./helpers";

interface ListedFile {
  name: string;
  sha256: string;
  role?: string;
  digests?: Record<string, string>;
}

const REPO = `${ORIGIN}/maven/com/acme`;

let admin: string;
let ci: string;
let reader: string;

function content(name: string): Uint8Array {
  return new TextEncoder().encode(`bytes of ${name}`);
}

async function hex(algorithm: string, bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** init with the files, the simulated presigned PUTs, and commit. */
async function publish(
  token: string,
  artifactId: string,
  version: string,
  options: { files?: string[]; deps?: PomDependency[]; pom?: string } = {},
): Promise<Response> {
  const names = options.files ?? [`${artifactId}-${version}.pom`, `${artifactId}-${version}.jar`];
  const declared = await Promise.all(
    names.map(async (name) => {
      const bytes = name.endsWith(".pom") ? new TextEncoder().encode(name) : content(name);
      return { name, bytes, sha256: await sha256Hex(bytes) };
    }),
  );
  const init = await call("POST", "/api/v1/publish/init", {
    token,
    body: {
      eco: "maven",
      name: `com.acme:${artifactId}`,
      version,
      files: declared.map((f) => ({ name: f.name, size: f.bytes.length, sha256: f.sha256 })),
      manifest: {
        groupId: "com.acme",
        artifactId,
        version,
        packaging: "jar",
        pom: options.pom ?? pomFor("com.acme", artifactId, version),
        dependencies: options.deps ?? [],
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

function basic(token: string): Record<string, string> {
  return { authorization: `Basic ${btoa(token)}` };
}

function get(path: string, token = reader): Promise<Response> {
  return call("GET", path, { headers: basic(token) });
}

async function text(path: string, token = reader): Promise<string | number> {
  const res = await get(path, token);
  return res.status === 200 ? res.text() : res.status;
}

/** The `<version>` entries of a `maven-metadata.xml`. */
async function versions(path: string, token = reader): Promise<string[] | number> {
  const xml = await text(path, token);
  if (typeof xml === "number") return xml;
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1] ?? "");
}

beforeAll(async () => {
  admin = await credential("maven-admin", "admin");
  ci = await credential("maven-ci", "publish", [
    { eco: "maven", package: "com.acme:*", versions: "*" },
  ]);
  reader = await credential("maven-app", "read", [
    { eco: "maven", package: "com.acme:sdk", versions: "[1.0,2.0)" },
  ]);
  const published: [string, string, Parameters<typeof publish>[3]][] = [
    ["http", "1.0.0", {}],
    ["http", "1.5.0", {}],
    ["http", "2.0.0", {}],
    ["logging", "0.3.2", {}],
    ["logging", "0.3.3", {}],
    ["metrics", "2.1.0", {}],
    ["sdk", "1.3.0", {}],
    ["sdk", "1.5.0-rc1", {}],
    ["sdk", "2.0.0", {}],
  ];
  for (const [artifactId, version, options] of published) {
    expect((await publish(ci, artifactId, version, options)).status).toBe(201);
  }
});

describe("maven publishing", () => {
  it("computes sha1, md5 and sha512 of every file at commit", async () => {
    const files = ["sdk-1.4.0.pom", "sdk-1.4.0.jar", "sdk-1.4.0-sources.jar", "sdk-1.4.0.module"];
    const res = await publish(ci, "sdk", "1.4.0", { files, deps: SDK_DEPENDENCIES, pom: SDK_POM });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      eco: "maven",
      name: "com.acme:sdk",
      version: "1.4.0",
      url: `${REPO}/sdk/1.4.0/sdk-1.4.0.jar`,
      files: files.map((name) => ({ name, url: `${REPO}/sdk/1.4.0/${name}` })),
    });
    const listed = await call("GET", "/api/v1/packages/maven/com.acme%3Asdk", { token: admin });
    const body = await listed.json<{ versions: { version: string; files: ListedFile[] }[] }>();
    const version = body.versions.find((v) => v.version === "1.4.0");
    expect(version?.files.map((f) => [f.name, f.role])).toEqual([
      ["sdk-1.4.0.pom", "pom"],
      ["sdk-1.4.0.jar", "archive"],
      ["sdk-1.4.0-sources.jar", "sources"],
      ["sdk-1.4.0.module", "module"],
    ]);
    const jar = content("sdk-1.4.0.jar");
    expect(version?.files[1]?.digests).toEqual({
      sha1: await hex("SHA-1", jar),
      md5: await hex("MD5", jar),
      sha512: await hex("SHA-512", jar),
    });
    expect(body.versions.map((v) => v.version)).toEqual(["2.0.0", "1.5.0-rc1", "1.4.0", "1.3.0"]);
  });

  it("rejects checksum uploads and snapshots", async () => {
    const sha1 = await publish(ci, "sdk", "1.6.0", {
      files: ["sdk-1.6.0.pom", "sdk-1.6.0.jar", "sdk-1.6.0.jar.sha1"],
    });
    expect(sha1.status).toBe(400);
    const snapshot = await publish(ci, "sdk", "1.6.0-SNAPSHOT");
    expect(snapshot.status).toBe(400);
    expect((await snapshot.json<ErrorBody>()).error).toBe("invalid_request");
    expect((await publish(ci, "sdk", "1.4.0")).status).toBe(409);
  });
});

describe("maven repository", () => {
  it("generates maven-metadata.xml from the granted versions", async () => {
    const res = await get("/maven/com/acme/sdk/maven-metadata.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const xml = await res.text();
    expect(xml).toMatch(
      new RegExp(
        `^<\\?xml version="1.0" encoding="UTF-8"\\?>\\n<metadata>\\n` +
          `  <groupId>com.acme</groupId>\\n  <artifactId>sdk</artifactId>\\n  <versioning>\\n` +
          `    <latest>1.5.0-rc1</latest>\\n    <release>1.4.0</release>\\n    <versions>\\n` +
          `      <version>1.3.0</version>\\n      <version>1.4.0</version>\\n` +
          `      <version>1.5.0-rc1</version>\\n    </versions>\\n` +
          `    <lastUpdated>\\d{14}</lastUpdated>\\n  </versioning>\\n</metadata>\\n$`,
      ),
    );
    expect(await versions("/maven/com/acme/sdk/maven-metadata.xml", admin)).toEqual([
      "1.3.0",
      "1.4.0",
      "1.5.0-rc1",
      "2.0.0",
    ]);
    expect(await text("/maven/com/acme/internal/maven-metadata.xml", admin)).toBe(404);
    expect(await text("/maven/com/acme/sdk/1.4.0/maven-metadata.xml", admin)).toBe(404);
  });

  it("serves the checksums of the served metadata", async () => {
    const xml = new TextEncoder().encode(
      String(await text("/maven/com/acme/sdk/maven-metadata.xml")),
    );
    const algorithms = { sha1: "SHA-1", md5: "MD5", sha256: "SHA-256", sha512: "SHA-512" };
    for (const [ext, algorithm] of Object.entries(algorithms)) {
      const res = await get(`/maven/com/acme/sdk/maven-metadata.xml.${ext}`);
      expect(res.headers.get("content-type")).toBe("text/plain");
      expect(await res.text()).toBe(await hex(algorithm, xml));
    }
    const all = await text("/maven/com/acme/sdk/maven-metadata.xml.sha1", admin);
    expect(all).not.toBe(await hex("SHA-1", xml));
  });

  it("redirects file downloads within the grant", async () => {
    const res = await get("/maven/com/acme/sdk/1.4.0/sdk-1.4.0.jar");
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://test-account.r2.cloudflarestorage.com");
    expect(location.pathname).toBe(
      "/serverless-registry/maven/pkg/com.acme%3Asdk/1.4.0/sdk-1.4.0.jar",
    );
    expect(location.searchParams.get("X-Amz-Expires")).toBe("900");
    expect((await get("/maven/com/acme/sdk/1.4.0/sdk-1.4.0.module")).status).toBe(302);
    expect((await get("/maven/com/acme/sdk/1.4.0/sdk-1.4.0-javadoc.jar")).status).toBe(404);
    expect((await get("/maven/com/acme/sdk/2.0.0/sdk-2.0.0.jar")).status).toBe(404);
    expect((await get("/maven/com/acme/sdk/2.0.0/sdk-2.0.0.jar", admin)).status).toBe(302);
  });

  it("serves file checksums from the digests computed at commit", async () => {
    const jar = content("sdk-1.4.0.jar");
    const base = "/maven/com/acme/sdk/1.4.0/sdk-1.4.0.jar";
    expect(await text(`${base}.sha1`)).toBe(await hex("SHA-1", jar));
    expect(await text(`${base}.md5`)).toBe(await hex("MD5", jar));
    expect(await text(`${base}.sha256`)).toBe(await hex("SHA-256", jar));
    expect(await text(`${base}.sha512`)).toBe(await hex("SHA-512", jar));
    expect(await text("/maven/com/acme/sdk/1.4.0/sdk-1.4.0.pom.sha256")).toBe(
      await hex("SHA-256", new TextEncoder().encode("sdk-1.4.0.pom")),
    );
    expect(await text("/maven/com/acme/sdk/1.4.0/sdk-1.4.0-javadoc.jar.sha1")).toBe(404);
    expect(await text("/maven/com/acme/sdk/2.0.0/sdk-2.0.0.jar.sha1")).toBe(404);
  });

  it("challenges with Basic and Bearer and rejects publish credentials", async () => {
    const anonymous = await call("GET", "/maven/com/acme/sdk/maven-metadata.xml");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe(
      'Basic realm="serverless-registry", Bearer realm="serverless-registry"',
    );
    expect(
      (await call("GET", "/maven/com/acme/sdk/maven-metadata.xml", { token: reader })).status,
    ).toBe(200);
    expect((await get("/maven/com/acme/sdk/maven-metadata.xml", ci)).status).toBe(403);
    expect(
      (await call("PUT", "/maven/com/acme/sdk/1.4.0/sdk-1.4.0.jar", { token: reader })).status,
    ).toBe(404);
  });

  it("opens compile and runtime dependencies transitively", async () => {
    // sdk 1.4.0 depends on http [1.0,2.0) (compile), logging 0.3.2 (runtime, exact) and
    // metrics 2.1.0 (optional).
    expect(await versions("/maven/com/acme/http/maven-metadata.xml")).toEqual(["1.0.0", "1.5.0"]);
    expect(await versions("/maven/com/acme/logging/maven-metadata.xml")).toEqual(["0.3.2"]);
    expect(await text("/maven/com/acme/metrics/maven-metadata.xml")).toBe(404);
    expect((await get("/maven/com/acme/http/1.5.0/http-1.5.0.jar")).status).toBe(302);
    expect((await get("/maven/com/acme/http/2.0.0/http-2.0.0.jar")).status).toBe(404);
    const listed = await call("GET", "/api/v1/packages/maven/com.acme%3Asdk", { token: reader });
    expect((await listed.json<{ dependencies: unknown }>()).dependencies).toEqual([
      { name: "com.acme:http", constraints: ["[1.0,2.0)"], versions: ["1.5.0", "1.0.0"] },
      { name: "com.acme:logging", constraints: ["[0.3.2]"], versions: ["0.3.2"] },
    ]);
  });

  it("drops yanked versions from the metadata but keeps their files", async () => {
    const yank = await call("POST", "/api/v1/packages/maven/com.acme%3Asdk/1.4.0/yank", {
      token: admin,
    });
    expect(yank.status).toBe(200);
    const xml = String(await text("/maven/com/acme/sdk/maven-metadata.xml"));
    expect(xml).toContain("<release>1.3.0</release>");
    expect(await versions("/maven/com/acme/sdk/maven-metadata.xml")).toEqual([
      "1.3.0",
      "1.5.0-rc1",
    ]);
    expect((await get("/maven/com/acme/sdk/1.4.0/sdk-1.4.0.jar")).status).toBe(302);
    expect(await text("/maven/com/acme/sdk/1.4.0/sdk-1.4.0.jar.sha1")).toBe(
      await hex("SHA-1", content("sdk-1.4.0.jar")),
    );
    // Yanked versions keep opening their dependencies, so lockfiles keep resolving.
    expect(await versions("/maven/com/acme/logging/maven-metadata.xml")).toEqual(["0.3.2"]);
  });
});
