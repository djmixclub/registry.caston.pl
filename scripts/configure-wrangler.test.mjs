// Tests of scripts/configure-wrangler.mjs: node --test scripts/

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";

import { run } from "./configure-wrangler.mjs";
import { ConfigError, readConfig } from "./wrangler-config.mjs";

const SOURCE = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

let dir;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "configure-wrangler-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function fresh() {
  const root = path.join(dir, String(counter++));
  cpSync(SOURCE, path.join(root, "wrangler.jsonc"), { recursive: true });
  return root;
}

const config = (root) => readConfig(readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));

describe("configure-wrangler", () => {
  it("writes the settings that are given", () => {
    const root = fresh();
    const result = run([
      "--root",
      root,
      "--worker-name",
      "my-registry",
      "--r2-bucket",
      "my-bucket",
      "--kv-namespace-id",
      "0123456789abcdef0123456789abcdef",
      "--route",
      "packages.example.com",
    ]);
    assert.equal(result.changed, true);
    assert.equal(result.changes.length, 4);
    const written = config(root);
    assert.equal(written.name, "my-registry");
    assert.equal(written.r2_buckets[0].bucket_name, "my-bucket");
    assert.equal(written.kv_namespaces[0].id, "0123456789abcdef0123456789abcdef");
    assert.deepEqual(written.routes, [{ pattern: "packages.example.com", custom_domain: true }]);
  });

  it("writes the jurisdiction of the bucket", () => {
    const root = fresh();
    const result = run(["--root", root, "--r2-bucket", "my-bucket", "--r2-jurisdiction", "eu"]);
    assert.equal(result.changes.length, 2);
    assert.equal(config(root).r2_buckets[0].jurisdiction, "eu");
  });

  it("changes nothing with --dry-run, and says what it would change", () => {
    const root = fresh();
    const before = readFileSync(path.join(root, "wrangler.jsonc"), "utf8");
    const result = run(["--root", root, "--r2-bucket", "my-bucket", "--dry-run"]);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.changes, ["R2_BUCKET bucket_name = my-bucket"]);
    assert.equal(readFileSync(path.join(root, "wrangler.jsonc"), "utf8"), before);
  });

  it("reports no change for settings that are empty or already in place", () => {
    const root = fresh();
    assert.equal(run(["--root", root, "--worker-name", "", "--route", " "]).changed, false);
    assert.equal(run(["--root", root, "--r2-bucket", "serverless-registry"]).changed, false);
  });

  it("refuses an invalid value and an unknown option", () => {
    const root = fresh();
    assert.throws(() => run(["--root", root, "--r2-bucket", "Not A Bucket"]), ConfigError);
    assert.throws(() => run(["--root", root, "--unknown", "x"]), ConfigError);
    assert.throws(() => run(["--root", root, "--r2-bucket"]), ConfigError);
  });
});
