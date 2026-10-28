import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Eco, Manifest, ManifestFile } from "../../src/adapters/types";
import { ValidationError } from "../../src/core/errors";
import {
  PACKAGES_META_KEY,
  addPackageToMeta,
  appendFilesToManifest,
  deleteStaging,
  fileKey,
  headStaged,
  listStaleStaging,
  manifestKey,
  promoteStaged,
  readManifest,
  readPackagesMeta,
  readStagingMeta,
  readStagingResult,
  rebuildPackagesMeta,
  removePackageFromMeta,
  stagingKey,
  stagingMetaKey,
  updateJson,
  writeManifest,
  writeStagingMeta,
  writeStagingResult,
  type StagingMeta,
  type StorageEnv,
} from "../../src/core/storage";

const SHA_A = "0".repeat(64);

async function wipe(): Promise<void> {
  for (;;) {
    const page = await env.R2_BUCKET.list();
    if (page.objects.length === 0) return;
    await env.R2_BUCKET.delete(page.objects.map((o) => o.key));
  }
}

beforeEach(wipe);

function file(name: string, extra: Partial<ManifestFile> = {}): ManifestFile {
  return { name, size: 3, sha256: SHA_A, ...extra };
}

function manifest(eco: Eco, name: string, version: string, files = [file("a.zip")]): Manifest {
  return {
    eco,
    name,
    version,
    files,
    published: "2026-10-28T10:12:00Z",
    publishedBy: "ci-acme",
    yanked: false,
    native: {},
  };
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The real bucket, except that the first `put` (or every `put`, with `always`) is preceded by
 * a competing write to the same key: a write between the read and the conditional write.
 */
function racingEnv(always = false): { env: StorageEnv; puts: () => number } {
  let puts = 0;
  const bucket = new Proxy(env.R2_BUCKET, {
    get(target, prop) {
      if (prop === "put") {
        return async (key: string, value: string, options?: R2PutOptions) => {
          puts += 1;
          if (always || puts === 1) await target.put(key, JSON.stringify({ n: 100 + puts }));
          return target.put(key, value, options);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { R2_BUCKET: bucket }, puts: () => puts };
}

describe("updateJson", () => {
  const key = "_meta/counter.json";
  const increment = (c: { n: number } | null) => ({ n: (c?.n ?? 0) + 1 });

  it("creates a missing object and updates an existing one", async () => {
    expect(await updateJson(env, key, increment)).toEqual({ n: 1 });
    expect(await updateJson(env, key, increment)).toEqual({ n: 2 });
    const stored = await env.R2_BUCKET.get(key);
    expect(await stored?.json()).toEqual({ n: 2 });
    expect(stored?.httpMetadata?.contentType).toBe("application/json");
  });

  it("rejects a stale etag in R2", async () => {
    const first = await env.R2_BUCKET.put(key, "{}");
    await env.R2_BUCKET.put(key, '{"other":true}');
    const stale = await env.R2_BUCKET.put(key, "{}", { onlyIf: { etagMatches: first?.etag } });
    expect(stale).toBeNull();
    expect(await (await env.R2_BUCKET.get(key))?.json()).toEqual({ other: true });
    const create = await env.R2_BUCKET.put(key, "{}", { onlyIf: { etagDoesNotMatch: "*" } });
    expect(create).toBeNull();
  });

  it("retries after a write between the read and the write", async () => {
    await env.R2_BUCKET.put(key, JSON.stringify({ n: 1 }));
    const racing = racingEnv();
    const seen: (number | undefined)[] = [];
    const result = await updateJson<{ n: number }>(racing.env, key, (c) => {
      seen.push(c?.n);
      return { n: (c?.n ?? 0) + 1 };
    });
    // The first round read 1 and lost against the competing write of 101.
    expect(seen).toEqual([1, 101]);
    expect(result).toEqual({ n: 102 });
    expect(await (await env.R2_BUCKET.get(key))?.json()).toEqual({ n: 102 });
    expect(racing.puts()).toBe(2);
  });

  it("retries a create that loses against another create", async () => {
    const racing = racingEnv();
    expect(await updateJson(racing.env, key, increment)).toEqual({ n: 102 });
  });

  it("gives up after the configured number of attempts", async () => {
    const racing = racingEnv(true);
    const error = await updateJson(racing.env, key, increment, { attempts: 3 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("internal_error");
    expect(racing.puts()).toBe(3);
  });

  it("propagates errors thrown by the update without writing", async () => {
    await expect(
      updateJson(env, key, () => {
        throw new ValidationError("not_found");
      }),
    ).rejects.toThrow(ValidationError);
    expect(await env.R2_BUCKET.head(key)).toBeNull();
  });

  it("skips the write when nothing changes", async () => {
    const written = await env.R2_BUCKET.put(key, JSON.stringify({ n: 5 }));
    await updateJson<{ n: number }>(env, key, (c) => ({ n: c?.n ?? 0 }));
    expect((await env.R2_BUCKET.head(key))?.etag).toBe(written?.etag);
  });

  it("passes corrupt or invalid values as null", async () => {
    await env.R2_BUCKET.put(key, "{broken");
    expect(await updateJson(env, key, increment)).toEqual({ n: 1 });
    const isCounter = (v: unknown): v is { n: number } =>
      typeof v === "object" && v !== null && typeof (v as { n?: unknown }).n === "number";
    await env.R2_BUCKET.put(key, '{"n":"x"}');
    expect(await updateJson(env, key, increment, { isValid: isCounter })).toEqual({ n: 1 });
  });
});

describe("appendFilesToManifest", () => {
  it("adds files to an existing version", async () => {
    await writeManifest(env, manifest("generic", "acme-tool", "1.0.0", [file("tool-linux.tgz")]));
    const updated = await appendFilesToManifest(env, "generic", "acme-tool", "1.0.0", [
      file("tool-macos.tgz", { labels: { os: "macos" } }),
      file("tool-windows.zip"),
    ]);
    expect(updated.files.map((f) => f.name)).toEqual([
      "tool-linux.tgz",
      "tool-macos.tgz",
      "tool-windows.zip",
    ]);
    expect(await readManifest(env, "generic", "acme-tool", "1.0.0")).toEqual(updated);
  });

  it("rejects names that already exist or repeat", async () => {
    await writeManifest(env, manifest("generic", "acme-tool", "1.0.0", [file("a.tgz")]));
    for (const files of [[file("a.tgz")], [file("b.tgz"), file("b.tgz")]]) {
      const error = await appendFilesToManifest(env, "generic", "acme-tool", "1.0.0", files).catch(
        (e: unknown) => e,
      );
      expect((error as ValidationError).code).toBe("file_exists");
      expect((error as ValidationError).status).toBe(409);
    }
    const stored = await readManifest(env, "generic", "acme-tool", "1.0.0");
    expect(stored?.files.map((f) => f.name)).toEqual(["a.tgz"]);
  });

  it("answers not_found for a missing version", async () => {
    const error = await appendFilesToManifest(env, "generic", "nope", "1.0.0", [
      file("a.tgz"),
    ]).catch((e: unknown) => e);
    expect((error as ValidationError).code).toBe("not_found");
    expect(await env.R2_BUCKET.head(manifestKey("generic", "nope", "1.0.0"))).toBeNull();
  });

  it("keeps both of two concurrent appends", async () => {
    await writeManifest(env, manifest("generic", "acme-tool", "1.0.0", [file("a.tgz")]));
    await Promise.all([
      appendFilesToManifest(env, "generic", "acme-tool", "1.0.0", [file("b.tgz")]),
      appendFilesToManifest(env, "generic", "acme-tool", "1.0.0", [file("c.tgz")]),
    ]);
    const stored = await readManifest(env, "generic", "acme-tool", "1.0.0");
    expect(stored?.files.map((f) => f.name).sort()).toEqual(["a.tgz", "b.tgz", "c.tgz"]);
  });
});

describe("packages meta", () => {
  const entry = { versions: 2, updated: "2026-10-28T10:12:00Z" };

  it("reads an empty meta when the file is missing or corrupt", async () => {
    const empty = { composer: {}, npm: {}, cargo: {}, generic: {}, nuget: {} };
    expect(await readPackagesMeta(env)).toEqual(empty);
    await env.R2_BUCKET.put(PACKAGES_META_KEY, "[]");
    expect(await readPackagesMeta(env)).toEqual(empty);
  });

  it("adds, replaces and removes packages", async () => {
    await addPackageToMeta(env, "npm", "@acme/sdk", entry);
    await addPackageToMeta(env, "composer", "acme/sdk", { versions: 1, updated: entry.updated });
    await addPackageToMeta(env, "composer", "acme/sdk", entry);
    await addPackageToMeta(env, "composer", "acme/cli", entry);

    const meta = await readPackagesMeta(env);
    expect(meta.composer).toEqual({ "acme/cli": entry, "acme/sdk": entry });
    expect(Object.keys(meta.composer)).toEqual(["acme/cli", "acme/sdk"]);
    expect(meta.npm).toEqual({ "@acme/sdk": entry });

    await removePackageFromMeta(env, "composer", "acme/sdk");
    await removePackageFromMeta(env, "cargo", "missing");
    expect((await readPackagesMeta(env)).composer).toEqual({ "acme/cli": entry });
  });

  it("drops malformed entries and unknown ecosystems", async () => {
    await env.R2_BUCKET.put(
      PACKAGES_META_KEY,
      JSON.stringify({
        pypi: { x: entry },
        npm: { ok: entry, bad: { versions: "2" }, worse: null },
        cargo: [],
      }),
    );
    expect(await readPackagesMeta(env)).toEqual({
      composer: {},
      npm: { ok: entry },
      cargo: {},
      generic: {},
      nuget: {},
    });
  });

  it("keeps concurrent additions", async () => {
    await Promise.all(
      ["a", "b", "c", "d"].map((n) => addPackageToMeta(env, "cargo", `crate-${n}`, entry)),
    );
    expect(Object.keys((await readPackagesMeta(env)).cargo)).toEqual([
      "crate-a",
      "crate-b",
      "crate-c",
      "crate-d",
    ]);
  });

  it("rebuilds from the listing of manifests", async () => {
    await writeManifest(env, manifest("composer", "acme/sdk", "1.0.0"));
    await writeManifest(env, manifest("composer", "acme/sdk", "1.1.0"));
    await env.R2_BUCKET.put(fileKey("composer", "acme/sdk", "1.1.0", "a.zip"), "zip");
    await writeManifest(env, manifest("cargo", "foo__bar", "0.1.0"));
    await env.R2_BUCKET.put(fileKey("npm", "@acme/orphan", "1.0.0", "a.tgz"), "tgz");
    await addPackageToMeta(env, "npm", "@acme/stale", entry);

    const newest = await env.R2_BUCKET.head(manifestKey("composer", "acme/sdk", "1.1.0"));
    const meta = await rebuildPackagesMeta(env);

    expect(meta.composer).toEqual({
      "acme/sdk": {
        versions: 2,
        updated: newest?.uploaded.toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
    });
    expect(Object.keys(meta.cargo)).toEqual(["foo__bar"]);
    expect(meta.npm).toEqual({});
    expect(await readPackagesMeta(env)).toEqual(meta);
  });

  it("rebuilds one ecosystem and leaves the others alone", async () => {
    await addPackageToMeta(env, "npm", "@acme/kept", entry);
    await addPackageToMeta(env, "cargo", "gone", entry);
    await writeManifest(env, manifest("cargo", "acme-core", "1.0.0"));

    const meta = await rebuildPackagesMeta(env, "cargo");
    expect(meta.npm).toEqual({ "@acme/kept": entry });
    expect(Object.keys(meta.cargo)).toEqual(["acme-core"]);
  });
});

describe("staging", () => {
  const uploadId = "01JBX9T6Q4ZK3M8N2P5R7S9V0W";
  const meta: StagingMeta = {
    eco: "generic",
    name: "acme-tool",
    version: "1.0.0",
    files: [file("tool-linux.tgz"), file("tool-macos.tgz", { labels: { os: "macos" } })],
    manifest: { description: "tool" },
    append: false,
    publishedBy: "ci-acme",
    createdAt: "2026-10-28T10:12:00Z",
    expires: "2026-10-28T10:22:00Z",
  };

  it("writes and reads the declaration", async () => {
    expect(await readStagingMeta(env, uploadId)).toBeNull();
    await writeStagingMeta(env, uploadId, meta);
    expect(await readStagingMeta(env, uploadId)).toEqual(meta);

    await env.R2_BUCKET.put(stagingMetaKey(uploadId), JSON.stringify({ ...meta, files: [] }));
    expect(await readStagingMeta(env, uploadId)).toBeNull();
  });

  it("heads and promotes a staged file with its checksum", async () => {
    const data = new TextEncoder().encode("archive bytes");
    const sha = await sha256Hex(data);
    expect(await headStaged(env, uploadId, "tool.tgz")).toBeNull();
    await env.R2_BUCKET.put(stagingKey(uploadId, "tool.tgz"), data, {
      sha256: sha,
      httpMetadata: { contentType: "application/gzip" },
    });

    const head = await headStaged(env, uploadId, "tool.tgz");
    expect(head?.size).toBe(data.length);
    const target = fileKey("generic", "acme-tool", "1.0.0", "tool.tgz");
    const promoted = await promoteStaged(env, uploadId, "tool.tgz", target);

    expect(promoted?.size).toBe(data.length);
    const stored = await env.R2_BUCKET.get(target);
    expect(await stored?.text()).toBe("archive bytes");
    expect(stored?.httpMetadata?.contentType).toBe("application/gzip");
    expect(await headStaged(env, uploadId, "tool.tgz")).toBeNull();
    expect(await promoteStaged(env, uploadId, "tool.tgz", target)).toBeNull();
  });

  it("refuses to promote bytes that do not match the expected digest", async () => {
    await env.R2_BUCKET.put(stagingKey(uploadId, "tool.tgz"), "tampered");
    const target = fileKey("generic", "acme-tool", "1.0.0", "tool.tgz");
    await expect(
      promoteStaged(env, uploadId, "tool.tgz", target, { sha256: SHA_A }),
    ).rejects.toThrow();
    expect(await env.R2_BUCKET.head(target)).toBeNull();
    expect(await headStaged(env, uploadId, "tool.tgz")).not.toBeNull();
  });

  it("records the commit result", async () => {
    expect(await readStagingResult(env, uploadId)).toBeNull();
    const result = {
      publishedBy: "ci-acme",
      committedAt: "2026-10-28T10:13:00Z",
      response: { eco: "generic", name: "acme-tool", version: "1.0.0" },
    };
    await writeStagingResult(env, uploadId, result);
    expect(await readStagingResult(env, uploadId)).toEqual(result);
  });

  it("deletes every object of an upload", async () => {
    await writeStagingMeta(env, uploadId, meta);
    await env.R2_BUCKET.put(stagingKey(uploadId, "tool-linux.tgz"), "a");
    await env.R2_BUCKET.put(stagingKey(uploadId, "tool-macos.tgz"), "b");
    await env.R2_BUCKET.put(stagingKey(`${uploadId}X`, "other.tgz"), "c");

    expect(await deleteStaging(env, uploadId)).toBe(3);
    const left = (await env.R2_BUCKET.list({ prefix: "_staging/" })).objects.map((o) => o.key);
    expect(left).toEqual([stagingKey(`${uploadId}X`, "other.tgz")]);
  });

  it("lists stale uploads by createdAt or by upload time", async () => {
    await writeStagingMeta(env, "old-meta-upload", { ...meta, createdAt: "2026-10-27T09:00:00Z" });
    await env.R2_BUCKET.put(stagingKey("old-meta-upload", "a.tgz"), "a");
    await writeStagingMeta(env, "new-meta-upload", { ...meta, createdAt: "2026-10-28T09:00:00Z" });
    await env.R2_BUCKET.put(stagingKey("no-meta-upload", "a.tgz"), "a");
    await env.R2_BUCKET.put(stagingKey("no-meta-upload", "b.tgz"), "b");
    await env.R2_BUCKET.put(stagingMetaKey("bad-meta-upload"), "{broken");

    const cutoff = new Date("2026-10-28T00:00:00Z");
    // Objects without a meta were uploaded now (real time), long after the cutoff.
    expect(await listStaleStaging(env, cutoff)).toEqual(["old-meta-upload"]);
    // Far in the future every object is older than the cutoff.
    const future = new Date(Date.now() + 86_400_000);
    expect(await listStaleStaging(env, future)).toEqual([
      "bad-meta-upload",
      "new-meta-upload",
      "no-meta-upload",
      "old-meta-upload",
    ]);
  });
});
