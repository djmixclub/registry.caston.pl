import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Identity, Kind } from "../../src/core/auth";
import { closureKey } from "../../src/core/closure";
import { ValidationError } from "../../src/core/errors";
import type { Grant } from "../../src/core/grants";
import { UPLOAD_ID_RE, commit, init, newUploadId, parseInitBody } from "../../src/core/publish";
import {
  fileKey,
  readIndex,
  readManifest,
  readPackagesMeta,
  readStagingMeta,
  stagingKey,
} from "../../src/core/storage";

const NOW = new Date("2026-10-28T10:12:00Z");
const BASE = "https://packages.example.com";

let counter = 0;
function uniqueName(): string {
  counter += 1;
  return `acme/lib${counter}`;
}

function identity(
  grants: Grant[] = [{ eco: "composer", package: "acme/*", versions: "*" }],
  kind: Kind = "publish",
  project = "ci-acme",
): Identity {
  return {
    project,
    kind,
    grants,
    record: { project, kind, auth: [], grants },
    entryId: "000000000000",
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Archive {
  bytes: Uint8Array;
  sha: string;
  file: { name: string; size: number; sha256: string };
}

async function archive(content: string, name = "lib.zip"): Promise<Archive> {
  const bytes = new TextEncoder().encode(content);
  const sha = await sha256(bytes);
  return { bytes, sha, file: { name, size: bytes.length, sha256: sha } };
}

function body(name: string, version: string, a: Archive, extra: Record<string, unknown> = {}) {
  return {
    eco: "composer",
    name,
    version,
    files: [a.file],
    manifest: { name, type: "library", require: { php: "^8.1" } },
    ...extra,
  };
}

/** What the CLI's presigned PUT does: store the declared bytes (R2 records their SHA-256). */
async function upload(uploadId: string, a: Archive): Promise<void> {
  await env.R2_BUCKET.put(stagingKey(uploadId, a.file.name), a.bytes, { sha256: a.sha });
}

async function failure(promise: Promise<unknown>): Promise<ValidationError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ValidationError) return err;
    throw err;
  }
  throw new Error("expected a ValidationError");
}

async function publish(name: string, version: string, content = "zip bytes") {
  const a = await archive(content);
  const started = await init(env, identity(), body(name, version, a), NOW);
  await upload(started.uploadId, a);
  return commit(env, identity(), { uploadId: started.uploadId }, NOW, BASE);
}

describe("newUploadId", () => {
  it("is a 26-character ULID whose prefix follows the clock", () => {
    const a = newUploadId(new Date("2026-10-28T10:12:00Z"));
    const b = newUploadId(new Date("2026-10-28T10:12:01Z"));
    expect(a).toMatch(UPLOAD_ID_RE);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    expect(newUploadId(NOW)).not.toBe(newUploadId(NOW));
  });
});

describe("parseInitBody", () => {
  const file = { name: "a.zip", size: 10, sha256: "a".repeat(64) };
  const valid = { eco: "composer", name: "acme/x", version: "1.0.0", files: [file], manifest: {} };

  it("keeps the known fields of each file", () => {
    const parsed = parseInitBody(
      { ...valid, files: [{ ...file, role: "archive", labels: { os: "linux" }, extra: 1 }] },
      100,
    );
    expect(parsed.files).toEqual([{ ...file, role: "archive", labels: { os: "linux" } }]);
    expect(parsed).not.toHaveProperty("append");
  });

  it.each([
    [{ eco: "pypi" }, "invalid_request"],
    [{ name: "" }, "invalid_request"],
    [{ version: 1 }, "invalid_request"],
    [{ version: "1/0" }, "invalid_request"],
    [{ files: [] }, "invalid_request"],
    [{ files: [file, file] }, "invalid_request"],
    [{ files: [{ ...file, name: "a/b.zip" }] }, "invalid_request"],
    [{ files: [{ ...file, name: "meta.json" }] }, "invalid_request"],
    [{ files: [{ ...file, name: ".." }] }, "invalid_request"],
    [{ files: [{ ...file, size: 0 }] }, "invalid_request"],
    [{ files: [{ ...file, size: 1.5 }] }, "invalid_request"],
    [{ files: [{ ...file, size: 101 }] }, "payload_too_large"],
    [{ files: [{ ...file, sha256: "A".repeat(64) }] }, "invalid_request"],
    [{ files: [{ ...file, role: "" }] }, "invalid_request"],
    [{ files: [{ ...file, labels: { a: 1 } }] }, "invalid_request"],
    [{ manifest: null }, "invalid_request"],
    [{ tag: 1 }, "invalid_request"],
    [{ append: "yes" }, "invalid_request"],
  ])("rejects %j", (patch, code) => {
    expect(() => parseInitBody({ ...valid, ...patch }, 100)).toThrow(
      expect.objectContaining({ code }),
    );
  });
});

describe("init", () => {
  it("presigns one PUT per file and stores the declaration", async () => {
    const name = uniqueName();
    const a = await archive("hello");
    const res = await init(env, identity(), body(name, "1.0.0", a), NOW);

    expect(res.uploadId).toMatch(UPLOAD_ID_RE);
    expect(res.expires).toBe("2026-10-28T10:22:00Z");
    expect(res.uploads).toHaveLength(1);
    const [upload] = res.uploads;
    expect(upload?.name).toBe("lib.zip");
    expect(upload?.headers).toEqual({
      "content-length": "5",
      "x-amz-checksum-sha256": "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
    });
    const url = new URL(upload?.putUrl ?? "");
    expect(url.origin).toBe("https://test-account.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/serverless-registry/_staging/${res.uploadId}/lib.zip`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

    const meta = await readStagingMeta(env, res.uploadId);
    expect(meta).toMatchObject({
      eco: "composer",
      name,
      version: "1.0.0",
      files: [{ ...a.file, role: "archive" }],
      publishedBy: "ci-acme",
      createdAt: "2026-10-28T10:12:00Z",
      expires: "2026-10-28T10:22:00Z",
    });
  });

  it("requires a publish credential", async () => {
    const a = await archive("x");
    const err = await failure(init(env, identity([], "read"), body(uniqueName(), "1.0.0", a), NOW));
    expect(err.code).toBe("forbidden");
  });

  it("checks the grant for the package and the version", async () => {
    const a = await archive("x");
    const narrow = identity([{ eco: "composer", package: "acme/*", versions: "^2.0" }]);
    expect((await failure(init(env, narrow, body(uniqueName(), "1.0.0", a), NOW))).code).toBe(
      "forbidden",
    );
    const other = identity([{ eco: "composer", package: "other/*", versions: "*" }]);
    expect((await failure(init(env, other, body(uniqueName(), "2.0.0", a), NOW))).code).toBe(
      "forbidden",
    );
    await expect(init(env, narrow, body(uniqueName(), "2.1.0", a), NOW)).resolves.toBeDefined();
  });

  it("answers 400 for a disabled ecosystem and 404 for one without an adapter yet", async () => {
    const a = await archive("x");
    const disabled = { ...env, ECOSYSTEMS: "npm" };
    expect(
      (await failure(init(disabled, identity(), body(uniqueName(), "1.0.0", a), NOW))).code,
    ).toBe("invalid_request");
    const nuget = { ...body("Acme.Sdk", "1.0.0", a), eco: "nuget" };
    const nugetIdentity = identity([{ eco: "nuget", package: "*", versions: "*" }]);
    expect((await failure(init(env, nugetIdentity, nuget, NOW))).status).toBe(404);
  });

  it("rejects append for composer", async () => {
    const a = await archive("x");
    const err = await failure(
      init(env, identity(), body(uniqueName(), "1.0.0", a, { append: true }), NOW),
    );
    expect(err.code).toBe("invalid_request");
    expect(err.message).toContain("appended");
  });

  it("rejects files above MAX_UPLOAD_BYTES with 413", async () => {
    const a = await archive("too large");
    const small = { ...env, MAX_UPLOAD_BYTES: "4" };
    expect(
      (await failure(init(small, identity(), body(uniqueName(), "1.0.0", a), NOW))).status,
    ).toBe(413);
  });

  it("rejects an adapter validation failure", async () => {
    const a = await archive("x");
    const name = uniqueName();
    const mismatch = { ...body(name, "1.0.0", a), manifest: { name: "acme/other" } };
    expect((await failure(init(env, identity(), mismatch, NOW))).code).toBe("invalid_request");
    expect((await failure(init(env, identity(), body(name, "1.0", a), NOW))).code).toBe(
      "invalid_request",
    );
  });

  it("answers 409 version_exists for a published version", async () => {
    const name = uniqueName();
    await publish(name, "1.0.0");
    const a = await archive("again");
    expect((await failure(init(env, identity(), body(name, "1.0.0", a), NOW))).code).toBe(
      "version_exists",
    );
  });
});

describe("commit", () => {
  it("publishes the version, its index and the packages meta", async () => {
    const name = uniqueName();
    const a = await archive("the archive");
    const started = await init(env, identity(), body(name, "1.2.0", a), NOW);
    await upload(started.uploadId, a);

    const res = await commit(env, identity(), { uploadId: started.uploadId }, NOW, BASE);
    const url = `${BASE}/composer/dist/${name}/1.2.0.zip`;
    expect(res).toEqual({
      eco: "composer",
      name,
      version: "1.2.0",
      url,
      files: [{ name: "lib.zip", url }],
    });

    const manifest = await readManifest(env, "composer", name, "1.2.0");
    expect(manifest).toMatchObject({
      published: "2026-10-28T10:12:00Z",
      publishedBy: "ci-acme",
      yanked: false,
      files: [{ ...a.file, role: "archive" }],
      native: { name, type: "library" },
    });
    const stored = await env.R2_BUCKET.get(fileKey("composer", name, "1.2.0", "lib.zip"));
    expect(await stored?.text()).toBe("the archive");
    expect(await env.R2_BUCKET.head(stagingKey(started.uploadId, "lib.zip"))).toBeNull();

    const index = await readIndex(env, `composer/index/p2/${name}.json`);
    const p2 = JSON.parse(index?.body ?? "") as { packages: Record<string, unknown[]> };
    expect(p2.packages[name]).toEqual([
      expect.objectContaining({ version: "1.2.0", dist: expect.objectContaining({ url }) }),
    ]);
    expect(await readIndex(env, `composer/index/p2/${name}~dev.json`)).not.toBeNull();
    expect((await readPackagesMeta(env)).composer[name]).toEqual({
      versions: 1,
      updated: "2026-10-28T10:12:00Z",
    });
  });

  it("drops the cached closures of the ecosystem", async () => {
    await env.AUTH.put(closureKey("closure-reader", "composer"), "{}");
    await env.AUTH.put(closureKey("closure-reader", "npm"), "{}");
    await publish(uniqueName(), "1.0.0");
    expect(await env.AUTH.get(closureKey("closure-reader", "composer"))).toBeNull();
    expect(await env.AUTH.get(closureKey("closure-reader", "npm"))).toBe("{}");
    await env.AUTH.delete(closureKey("closure-reader", "npm"));
  });

  it("is idempotent for the committing credential only", async () => {
    const name = uniqueName();
    const a = await archive("retry");
    const started = await init(env, identity(), body(name, "1.0.0", a), NOW);
    await upload(started.uploadId, a);
    const first = await commit(env, identity(), { uploadId: started.uploadId }, NOW, BASE);
    const again = await commit(env, identity(), { uploadId: started.uploadId }, NOW, BASE);
    expect(again).toEqual(first);

    const other = identity(undefined, "publish", "ci-other");
    expect(
      (await failure(commit(env, other, { uploadId: started.uploadId }, NOW, BASE))).code,
    ).toBe("not_found");
  });

  it("answers 404 for an upload of another credential or an unknown id", async () => {
    const a = await archive("x");
    const started = await init(env, identity(), body(uniqueName(), "1.0.0", a), NOW);
    await upload(started.uploadId, a);
    const other = identity(undefined, "publish", "ci-other");
    expect(
      (await failure(commit(env, other, { uploadId: started.uploadId }, NOW, BASE))).code,
    ).toBe("not_found");
    const unknown = newUploadId(NOW);
    expect((await failure(commit(env, identity(), { uploadId: unknown }, NOW, BASE))).code).toBe(
      "not_found",
    );
    expect((await failure(commit(env, identity(), { uploadId: "../meta" }, NOW, BASE))).code).toBe(
      "not_found",
    );
    expect((await failure(commit(env, identity(), {}, NOW, BASE))).code).toBe("invalid_request");
  });

  it("answers 400 upload_incomplete when a file was never uploaded", async () => {
    const name = uniqueName();
    const a = await archive("never sent");
    const started = await init(env, identity(), body(name, "1.0.0", a), NOW);
    const err = await failure(commit(env, identity(), { uploadId: started.uploadId }, NOW, BASE));
    expect(err.code).toBe("upload_incomplete");
    expect(err.status).toBe(400);
    expect(await readManifest(env, "composer", name, "1.0.0")).toBeNull();
  });

  it("answers 409 upload_mismatch for a different size or checksum", async () => {
    const name = uniqueName();
    const declared = await archive("AAAA");
    const started = await init(env, identity(), body(name, "1.0.0", declared), NOW);
    const longer = await archive("AAAAA");
    await upload(started.uploadId, { ...longer, file: declared.file });
    expect(
      (await failure(commit(env, identity(), { uploadId: started.uploadId }, NOW, BASE))).code,
    ).toBe("upload_mismatch");

    const other = await archive("BBBB");
    await upload(started.uploadId, { ...other, file: declared.file });
    expect(
      (await failure(commit(env, identity(), { uploadId: started.uploadId }, NOW, BASE))).code,
    ).toBe("upload_mismatch");
    expect(await readManifest(env, "composer", name, "1.0.0")).toBeNull();
  });

  it("rolls back when R2 rejects bytes without a recorded checksum", async () => {
    const name = uniqueName();
    const declared = await archive("AAAA");
    const started = await init(env, identity(), body(name, "1.0.0", declared), NOW);
    await env.R2_BUCKET.put(stagingKey(started.uploadId, "lib.zip"), "BBBB");
    expect(
      (await failure(commit(env, identity(), { uploadId: started.uploadId }, NOW, BASE))).code,
    ).toBe("upload_mismatch");
    expect(await readManifest(env, "composer", name, "1.0.0")).toBeNull();
    expect(await env.R2_BUCKET.head(fileKey("composer", name, "1.0.0", "lib.zip"))).toBeNull();
  });

  it("answers 409 version_exists when another upload committed first", async () => {
    const name = uniqueName();
    const a = await archive("first");
    const b = await archive("second");
    const first = await init(env, identity(), body(name, "1.0.0", a), NOW);
    const second = await init(env, identity(), body(name, "1.0.0", b), NOW);
    await upload(first.uploadId, a);
    await upload(second.uploadId, b);
    await commit(env, identity(), { uploadId: first.uploadId }, NOW, BASE);
    expect(
      (await failure(commit(env, identity(), { uploadId: second.uploadId }, NOW, BASE))).code,
    ).toBe("version_exists");
    const stored = await env.R2_BUCKET.get(fileKey("composer", name, "1.0.0", "lib.zip"));
    expect(await stored?.text()).toBe("first");
  });

  it("rechecks the grant", async () => {
    const a = await archive("x");
    const started = await init(env, identity(), body(uniqueName(), "1.0.0", a), NOW);
    await upload(started.uploadId, a);
    const revoked = identity([]);
    expect(
      (await failure(commit(env, revoked, { uploadId: started.uploadId }, NOW, BASE))).code,
    ).toBe("forbidden");
  });

  it("counts every version in the packages meta", async () => {
    const name = uniqueName();
    await publish(name, "1.0.0");
    await publish(name, "1.1.0");
    expect((await readPackagesMeta(env)).composer[name]?.versions).toBe(2);
  });
});
