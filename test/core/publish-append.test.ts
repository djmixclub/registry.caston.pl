import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Adapter, Manifest } from "../../src/adapters/types";
import type { Identity } from "../../src/core/auth";
import { ValidationError } from "../../src/core/errors";
import { commit, init } from "../../src/core/publish";
import {
  fileKey,
  indexKey,
  manifestKey,
  readIndex,
  readManifest,
  stagingKey,
} from "../../src/core/storage";
import { identityOf } from "../records";

// No shipped adapter supports appending yet, so the registry returns a minimal one for generic.
vi.mock("../../src/adapters/index", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/adapters/index")>();
  const { placeholderAdapter } = await import("../../src/adapters/placeholder");
  const storage = await import("../../src/core/storage");
  const base = placeholderAdapter("generic");
  const appendable: Adapter = {
    ...base,
    supportsAppend: true,
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
        body: JSON.stringify(manifests.map((m) => m.files.map((f) => f.name))),
        contentType: "application/json",
      },
    ],
    versionUrl: (m, url) => `${url}/generic/${m.name}/${m.version}`,
    fileUrl: (m, f, url) => `${url}/generic/${m.name}/${m.version}/${f.name}`,
  };
  return {
    ...original,
    getAdapter: (e: { ECOSYSTEMS: string }, eco: string) =>
      eco === "generic" ? appendable : original.getAdapter(e, eco),
  };
});

const BASE = "https://packages.example.com";
const T0 = new Date("2026-10-28T10:00:00Z");
const ci: Identity = identityOf(
  "ci-tool",
  "publish",
  [{ eco: "generic", package: "*", versions: "*" }],
  "000000000000",
);

async function file(name: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { bytes, decl: { name, size: bytes.length, sha256: sha } };
}

async function send(
  name: string,
  files: Awaited<ReturnType<typeof file>>[],
  now: Date,
  append = false,
) {
  const started = await init(
    env,
    ci,
    {
      eco: "generic",
      name,
      version: "1.0.0",
      files: files.map((f) => f.decl),
      manifest: {},
      ...(append ? { append: true } : {}),
    },
    now,
  );
  for (const f of files) {
    await env.R2_BUCKET.put(stagingKey(started.uploadId, f.decl.name), f.bytes, {
      sha256: f.decl.sha256,
    });
  }
  return commit(env, ci, { uploadId: started.uploadId }, now, BASE);
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ValidationError) return err.code;
    throw err;
  }
  return "ok";
}

describe("append", () => {
  it("adds files to an existing version and rebuilds the index", async () => {
    const linux = await file("tool-linux.tar.gz", "linux");
    const mac = await file("tool-macos.tar.gz", "macos");
    await send("tool-a", [linux], T0);
    const later = new Date(T0.getTime() + 60 * 60 * 1000);
    const res = await send("tool-a", [mac], later, true);

    expect(res.files).toEqual([
      { name: "tool-macos.tar.gz", url: `${BASE}/generic/tool-a/1.0.0/tool-macos.tar.gz` },
    ]);
    const manifest = await readManifest(env, "generic", "tool-a", "1.0.0");
    expect(manifest?.files.map((f) => f.name)).toEqual(["tool-linux.tar.gz", "tool-macos.tar.gz"]);
    expect(manifest?.published).toBe("2026-10-28T10:00:00Z");
    const stored = await env.R2_BUCKET.get(
      fileKey("generic", "tool-a", "1.0.0", "tool-macos.tar.gz"),
    );
    expect(await stored?.text()).toBe("macos");
    const index = await readIndex(env, indexKey("generic", "tool-a.json"));
    expect(JSON.parse(index?.body ?? "")).toEqual([["tool-linux.tar.gz", "tool-macos.tar.gz"]]);
  });

  it("publishes a version that does not exist yet like a normal publish", async () => {
    const f = await file("a.bin", "a");
    const res = await send("tool-b", [f], T0, true);
    expect(res.files.map((x) => x.name)).toEqual(["a.bin"]);
    const manifest = await readManifest(env, "generic", "tool-b", "1.0.0");
    expect(manifest?.published).toBe("2026-10-28T10:00:00Z");
    expect(manifest?.files.map((x) => x.name)).toEqual(["a.bin"]);
  });

  it("appends when a parallel append published the version between init and commit", async () => {
    const a = await file("a.bin", "a");
    const b = await file("b.bin", "b");
    const started = await init(
      env,
      ci,
      {
        eco: "generic",
        name: "tool-e",
        version: "1.0.0",
        files: [b.decl],
        manifest: {},
        append: true,
      },
      T0,
    );
    await send("tool-e", [a], T0, true);
    await env.R2_BUCKET.put(stagingKey(started.uploadId, "b.bin"), b.bytes, {
      sha256: b.decl.sha256,
    });
    await commit(env, ci, { uploadId: started.uploadId }, T0, BASE);
    const manifest = await readManifest(env, "generic", "tool-e", "1.0.0");
    expect(manifest?.files.map((x) => x.name)).toEqual(["a.bin", "b.bin"]);
  });

  it("answers 409 version_closed for a yanked version", async () => {
    const a = await file("a.bin", "a");
    const b = await file("b.bin", "b");
    await send("tool-f", [a], T0);
    const key = manifestKey("generic", "tool-f", "1.0.0");
    const stored = await readManifest(env, "generic", "tool-f", "1.0.0");
    await env.R2_BUCKET.put(key, JSON.stringify({ ...stored, yanked: true }));
    expect(await code(send("tool-f", [b], T0, true))).toBe("version_closed");
  });

  it("answers 409 file_exists for a name already in the version", async () => {
    const f = await file("a.bin", "a");
    await send("tool-c", [f], T0);
    expect(await code(send("tool-c", [f], T0, true))).toBe("file_exists");
  });

  it("answers 409 version_closed after APPEND_WINDOW_HOURS", async () => {
    const a = await file("a.bin", "a");
    const b = await file("b.bin", "b");
    await send("tool-d", [a], T0);
    const late = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
    expect(await code(send("tool-d", [b], late, true))).toBe("version_closed");
    const narrow = { ...env, APPEND_WINDOW_HOURS: "0" };
    const started = init(
      narrow,
      ci,
      {
        eco: "generic",
        name: "tool-d",
        version: "1.0.0",
        files: [b.decl],
        manifest: {},
        append: true,
      },
      new Date(T0.getTime() + 1000),
    );
    expect(await code(started)).toBe("version_closed");
  });
});
