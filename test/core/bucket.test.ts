import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  acceptBucket,
  bucketProblem,
  clearBucketCache,
  INSTALLATION_ID_KEY,
} from "../../src/core/bucket";
import { SCHEMA_VERSION_KEY } from "../../src/core/migrate";
import {
  INSTALLATION_MARKER_KEY,
  PACKAGES_META_KEY,
  readInstallationMarker,
  writeInstallationMarker,
} from "../../src/core/storage";

// KV and R2 keep what a test stores; every test starts without any of the keys it looks at.
beforeEach(async () => {
  await env.AUTH.delete(INSTALLATION_ID_KEY);
  await env.AUTH.delete(SCHEMA_VERSION_KEY);
  await env.R2_BUCKET.delete([INSTALLATION_MARKER_KEY, PACKAGES_META_KEY]);
});

async function kvId(): Promise<string | null> {
  return env.AUTH.get(INSTALLATION_ID_KEY, "text");
}

describe("bucketProblem", () => {
  it("gives a new installation an id in KV and in the bucket", async () => {
    expect(await bucketProblem(env)).toBeNull();
    const id = await kvId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readInstallationMarker(env)).toBe(id);
  });

  it("keeps the id on later checks", async () => {
    await bucketProblem(env);
    const id = await kvId();
    clearBucketCache();
    expect(await bucketProblem(env)).toBeNull();
    expect(await kvId()).toBe(id);
  });

  it("finds a bucket without the marker of an installation that has one", async () => {
    await bucketProblem(env);
    await env.R2_BUCKET.delete(INSTALLATION_MARKER_KEY);
    clearBucketCache();
    expect(await bucketProblem(env)).toBe("empty");
  });

  it("finds a bucket with another installation's marker", async () => {
    await bucketProblem(env);
    await writeInstallationMarker(env, "someone-else", { replace: true });
    clearBucketCache();
    expect(await bucketProblem(env)).toBe("other");
  });

  it("takes the bucket's id when KV lost its own", async () => {
    await writeInstallationMarker(env, "from-the-bucket");
    expect(await bucketProblem(env)).toBeNull();
    expect(await kvId()).toBe("from-the-bucket");
  });

  it("adopts the bucket of an installation from before ids when the bucket was initialised", async () => {
    await env.AUTH.put(SCHEMA_VERSION_KEY, "3");
    await env.R2_BUCKET.put(PACKAGES_META_KEY, "{}");
    expect(await bucketProblem(env)).toBeNull();
    expect(await readInstallationMarker(env)).toBe(await kvId());
  });

  it("finds a swapped bucket of an installation from before ids", async () => {
    await env.AUTH.put(SCHEMA_VERSION_KEY, "3");
    expect(await bucketProblem(env)).toBe("empty");
    expect(await kvId()).toBeNull();
    expect(await readInstallationMarker(env)).toBeNull();
  });

  it("trusts a good answer for a while", async () => {
    await bucketProblem(env);
    await env.R2_BUCKET.delete(INSTALLATION_MARKER_KEY);
    expect(await bucketProblem(env)).toBeNull();
    clearBucketCache();
    expect(await bucketProblem(env)).toBe("empty");
  });

  it("keeps a marker that is already there when two isolates create it", async () => {
    expect(await writeInstallationMarker(env, "first")).toBe(true);
    expect(await writeInstallationMarker(env, "second")).toBe(false);
    expect(await readInstallationMarker(env)).toBe("first");
    expect(await writeInstallationMarker(env, "third", { replace: true })).toBe(true);
    expect(await readInstallationMarker(env)).toBe("third");
  });
});

describe("acceptBucket", () => {
  it("makes an empty bucket the installation's own, with an empty package list", async () => {
    await env.AUTH.put(INSTALLATION_ID_KEY, "the-old-bucket");
    await env.AUTH.put(SCHEMA_VERSION_KEY, "3");
    expect(await bucketProblem(env)).toBe("empty");

    await acceptBucket(env);

    expect(await bucketProblem(env)).toBeNull();
    expect(await readInstallationMarker(env)).toBe(await kvId());
    expect(await kvId()).not.toBe("the-old-bucket");
    expect(await env.R2_BUCKET.head(PACKAGES_META_KEY)).not.toBeNull();
  });

  it("keeps the package list of a bucket that has one", async () => {
    await env.AUTH.put(INSTALLATION_ID_KEY, "the-old-bucket");
    const meta = JSON.stringify({
      composer: { "acme/sdk": { versions: 1, updated: "2026-01-01T00:00:00Z" } },
    });
    await env.R2_BUCKET.put(PACKAGES_META_KEY, meta);
    await writeInstallationMarker(env, "another");

    await acceptBucket(env);

    expect(await bucketProblem(env)).toBeNull();
    expect(await (await env.R2_BUCKET.get(PACKAGES_META_KEY))?.text()).toBe(meta);
  });
});
