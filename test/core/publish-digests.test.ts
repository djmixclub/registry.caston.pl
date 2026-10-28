import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Adapter, Manifest } from "../../src/adapters/types";
import { reindex, yank } from "../../src/core/admin";
import type { Identity } from "../../src/core/auth";
import { getPackage } from "../../src/core/packages";
import { commit, init } from "../../src/core/publish";
import {
  fileKey,
  promoteStagedWithDigests,
  readManifest,
  readStagingMeta,
  stagingKey,
} from "../../src/core/storage";

// A generic stand-in that declares every extra digest and supports appending; the real
// adapters that declare digests (Maven) come later.
vi.mock("../../src/adapters/index", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/adapters/index")>();
  const { placeholderAdapter } = await import("../../src/adapters/placeholder");
  const storage = await import("../../src/core/storage");
  const base = placeholderAdapter("generic");
  const digesting: Adapter = {
    ...base,
    supportsAppend: true,
    digests: ["sha1", "md5", "sha512"],
    parseManifest: (input) => ({
      eco: "generic",
      name: input.name,
      version: input.version,
      files: input.files,
      published: "",
      publishedBy: "",
      yanked: false,
      native: input.manifest,
    }),
    fileKey: (m, f) => storage.fileKey("generic", m.name, m.version, f.name),
    buildIndex: (name, manifests: Manifest[]) => [
      {
        key: storage.indexKey("generic", `${name}.json`),
        body: JSON.stringify(manifests.map((m) => m.files)),
        contentType: "application/json",
      },
    ],
    versionUrl: (m, url) => `${url}/generic/${m.name}/${m.version}`,
    fileUrl: (m, f, url) => `${url}/generic/${m.name}/${m.version}/${f.name}`,
  };
  const adapters = { ...original.ADAPTERS, generic: digesting };
  return {
    ...original,
    ADAPTERS: adapters,
    getAdapter: (e: { ECOSYSTEMS: string }, eco: string) =>
      eco === "generic" ? digesting : original.getAdapter(e, eco),
    enabledAdapters: (e: { ECOSYSTEMS: string }) =>
      original.enabledAdapters(e).map((a) => (a.eco === "generic" ? digesting : a)),
  };
});

const BASE = "https://packages.example.com";
const T0 = new Date("2026-10-28T10:00:00Z");
const FOX = "The quick brown fox jumps over the lazy dog";
const FOX_DIGESTS = {
  sha1: "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12",
  md5: "9e107d9d372bb6826bd81d3542a419d6",
  sha512:
    "07e547d9586f6a73f73fbac0435ed76951218fb7d0c8d788a309d785436bbb642e93a252a954f23912547d1e8a3b5ed6e1bfd7097821233fa0538f3db854fee6",
};
const FOX_SHA256 = "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592";

const ci: Identity = {
  project: "ci-digests",
  kind: "publish",
  grants: [{ eco: "generic", package: "*", versions: "*" }],
  record: { project: "ci-digests", kind: "publish", auth: [], grants: [] },
  entryId: "000000000000",
};
const admin: Identity = {
  project: "admin",
  kind: "admin",
  grants: [],
  record: { project: "admin", kind: "admin", auth: [], grants: [] },
  entryId: "000000000000",
};

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function file(name: string, bytes: Uint8Array) {
  const sha = hex(await crypto.subtle.digest("SHA-256", bytes));
  return { bytes, decl: { name, size: bytes.length, sha256: sha } };
}

async function send(
  name: string,
  files: Awaited<ReturnType<typeof file>>[],
  options: { append?: boolean; now?: Date; extra?: Record<string, unknown> } = {},
) {
  const now = options.now ?? T0;
  const started = await init(
    env,
    ci,
    {
      eco: "generic",
      name,
      version: "1.0.0",
      files: files.map((f) => ({ ...f.decl, ...options.extra })),
      manifest: {},
      ...(options.append ? { append: true } : {}),
    },
    now,
  );
  for (const f of files) {
    await env.R2_BUCKET.put(stagingKey(started.uploadId, f.decl.name), f.bytes, {
      sha256: f.decl.sha256,
    });
  }
  const meta = await readStagingMeta(env, started.uploadId);
  return { meta, response: await commit(env, ci, { uploadId: started.uploadId }, now, BASE) };
}

describe("adapter-declared digests", () => {
  it("records the adapter's list at init and computes known digests at commit", async () => {
    const fox = await file("fox.txt", new TextEncoder().encode(FOX));
    expect(fox.decl.sha256).toBe(FOX_SHA256);
    // A client cannot inject digests: the field of the declaration is ignored.
    const { meta } = await send("fox", [fox], { extra: { digests: { sha1: "forged" } } });
    expect(meta?.digests).toEqual(["sha1", "md5", "sha512"]);

    const manifest = await readManifest(env, "generic", "fox", "1.0.0");
    expect(manifest?.files).toEqual([
      { name: "fox.txt", size: FOX.length, sha256: FOX_SHA256, digests: FOX_DIGESTS },
    ]);
    const stored = await env.R2_BUCKET.get(fileKey("generic", "fox", "1.0.0", "fox.txt"));
    expect(await stored?.text()).toBe(FOX);
  });

  it("streams a multi-chunk file without changing its bytes", async () => {
    const big = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => (i * 7 + 3) % 256);
    const f = await file("big.bin", big);
    await send("big", [f]);
    const manifest = await readManifest(env, "generic", "big", "1.0.0");
    expect(manifest?.files[0]?.digests).toEqual({
      sha1: hex(await crypto.subtle.digest("SHA-1", big)),
      md5: "a9a3d18cac8c95d4bdeae2d821be2e00",
      sha512: hex(await crypto.subtle.digest("SHA-512", big)),
    });
    const stored = await env.R2_BUCKET.get(fileKey("generic", "big", "1.0.0", "big.bin"));
    expect(stored?.size).toBe(big.length);
    const copy = (await stored?.arrayBuffer()) ?? new ArrayBuffer(0);
    expect(hex(await crypto.subtle.digest("SHA-256", copy))).toBe(f.decl.sha256);
  });

  it("computes digests when an append opens a new version", async () => {
    const fox = await file("fox.txt", new TextEncoder().encode(FOX));
    await send("opened", [fox], { append: true });
    const manifest = await readManifest(env, "generic", "opened", "1.0.0");
    expect(manifest?.files).toEqual([
      { name: "fox.txt", size: FOX.length, sha256: FOX_SHA256, digests: FOX_DIGESTS },
    ]);
  });

  it("computes digests for appended files only, keeping the earlier ones", async () => {
    const a = await file("a.txt", new TextEncoder().encode(FOX));
    await send("pair", [a]);
    const one = await file("b.txt", new TextEncoder().encode("a"));
    await send("pair", [one], { append: true, now: new Date(T0.getTime() + 60_000) });
    const manifest = await readManifest(env, "generic", "pair", "1.0.0");
    expect(manifest?.files.map((f) => f.digests?.sha1)).toEqual([
      FOX_DIGESTS.sha1,
      "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8",
    ]);
  });

  it("returns digests in listings and the yank response; reindex keeps them", async () => {
    const fox = await file("fox.txt", new TextEncoder().encode(FOX));
    await send("listed", [fox]);
    const view = await getPackage(env, admin, "generic", "listed");
    expect(view.versions[0]?.files[0]?.digests).toEqual(FOX_DIGESTS);

    const yanked = await yank(env, "generic", "listed", "1.0.0", T0, BASE);
    expect(yanked.files[0]?.digests).toEqual(FOX_DIGESTS);

    const key = `generic/pkg/listed/1.0.0/manifest.json`;
    const before = await (await env.R2_BUCKET.get(key))?.text();
    await reindex(env, "generic", "listed", T0, BASE);
    expect(await (await env.R2_BUCKET.get(key))?.text()).toBe(before);
  });
});

describe("promoteStagedWithDigests", () => {
  it("computes nothing without algorithms and answers null when nothing is staged", async () => {
    const bytes = new TextEncoder().encode(FOX);
    await env.R2_BUCKET.put(stagingKey("UPLOADDIGESTS", "x.txt"), bytes);
    const promoted = await promoteStagedWithDigests(env, "UPLOADDIGESTS", "x.txt", "target/x");
    expect(promoted?.digests).toEqual({});
    expect(await (await env.R2_BUCKET.get("target/x"))?.text()).toBe(FOX);
    expect(
      await promoteStagedWithDigests(env, "UPLOADDIGESTS", "x.txt", "target/x", {
        digests: ["md5"],
      }),
    ).toBeNull();
  });

  it("rejects a SHA-256 mismatch while digesting", async () => {
    const bytes = new TextEncoder().encode(FOX);
    await env.R2_BUCKET.put(stagingKey("UPLOADMISMATCH", "x.txt"), bytes);
    await expect(
      promoteStagedWithDigests(env, "UPLOADMISMATCH", "x.txt", "target/y", {
        sha256: "0".repeat(64),
        digests: ["sha1", "md5"],
      }),
    ).rejects.toThrow();
    expect(await env.R2_BUCKET.head("target/y")).toBeNull();
  });
});
