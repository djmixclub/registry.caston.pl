// Unit tests of scripts/wrangler-config.mjs: node --test scripts/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { URL } from "node:url";

import {
  ConfigError,
  configureBindings,
  mergeBindings,
  overlayInstallation,
  readConfig,
  setTopLevel,
  topLevelEntries,
} from "./wrangler-config.mjs";

const UPSTREAM = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

const SAMPLE = `// header comment
{
  "name": "demo", // the worker
  /* bindings */
  "kv_namespaces": [{ "binding": "AUTH" }],
  "r2_buckets": [
    { "binding": "R2_BUCKET", "bucket_name": "demo-bucket" },
  ],
  "keep_vars": true,
}
`;

describe("readConfig", () => {
  it("reads the repository's own file", () => {
    const config = readConfig(UPSTREAM);
    assert.equal(config.name, "serverless-registry");
    assert.equal(config.r2_buckets[0].binding, "R2_BUCKET");
    assert.equal(config.keep_vars, true);
  });

  it("ignores comments and trailing commas, and keeps slashes inside strings", () => {
    const config = readConfig('{ "a": "http://x // not a comment", /* c */ "b": [1, 2,], }');
    assert.deepEqual(config, { a: "http://x // not a comment", b: [1, 2] });
  });

  it("refuses text that is not one object", () => {
    assert.throws(() => readConfig("[]"), ConfigError);
    assert.throws(() => readConfig("{ not json }"), ConfigError);
    assert.throws(() => readConfig('{ "a": "open'), ConfigError);
  });
});

describe("topLevelEntries", () => {
  it("finds the keys and the span of each value", () => {
    const { entries } = topLevelEntries(SAMPLE);
    assert.deepEqual(
      entries.map((e) => e.key),
      ["name", "kv_namespaces", "r2_buckets", "keep_vars"],
    );
    const name = entries[0];
    assert.equal(SAMPLE.slice(name.valueStart, name.valueEnd), '"demo"');
  });
});

describe("setTopLevel", () => {
  it("replaces a value and keeps the comments around it", () => {
    const text = setTopLevel(SAMPLE, "name", "other");
    assert.match(text, /"name": "other", \/\/ the worker/);
    assert.match(text, /header comment/);
    assert.match(text, /\/\* bindings \*\//);
    assert.equal(readConfig(text).name, "other");
  });

  it("replaces an array, indented like the key", () => {
    const text = setTopLevel(SAMPLE, "r2_buckets", [{ binding: "R2_BUCKET", bucket_name: "x" }]);
    assert.equal(readConfig(text).r2_buckets[0].bucket_name, "x");
    assert.match(text, /\n {2}"r2_buckets": \[\n {4}\{/);
  });

  it("adds a missing key after the last one, with or without a trailing comma", () => {
    const withComma = setTopLevel(SAMPLE, "routes", [{ pattern: "a.example.com" }]);
    assert.equal(readConfig(withComma).routes[0].pattern, "a.example.com");
    assert.equal(readConfig(withComma).keep_vars, true);

    const without = setTopLevel('{ "a": 1 }', "b", 2);
    assert.deepEqual(readConfig(without), { a: 1, b: 2 });
  });

  it("adds a key to an empty object", () => {
    assert.deepEqual(readConfig(setTopLevel("{}", "a", 1)), { a: 1 });
  });
});

describe("mergeBindings", () => {
  it("lays the installation's fields over upstream's binding and keeps its own bindings", () => {
    const merged = mergeBindings(
      [{ binding: "R2_BUCKET", bucket_name: "serverless-registry" }, { binding: "NEW" }],
      [
        { binding: "R2_BUCKET", bucket_name: "mine", jurisdiction: "eu" },
        { binding: "EXTRA", bucket_name: "extra" },
      ],
    );
    assert.deepEqual(merged, [
      { binding: "R2_BUCKET", bucket_name: "mine", jurisdiction: "eu" },
      { binding: "NEW" },
      { binding: "EXTRA", bucket_name: "extra" },
    ]);
  });
});

describe("overlayInstallation", () => {
  const upstream = `// upstream header
{
  "name": "serverless-registry",
  "main": "src/index.ts",
  "compatibility_date": "2026-12-01",
  // the bindings
  "kv_namespaces": [{ "binding": "AUTH" }, { "binding": "CACHE" }],
  "r2_buckets": [{ "binding": "R2_BUCKET", "bucket_name": "serverless-registry" }],
  "triggers": { "crons": ["0 * * * *"] },
  "keep_vars": true,
}
`;
  const installation = `{
  "name": "my-registry",
  "main": "old/main.ts",
  "compatibility_date": "2026-01-01",
  "kv_namespaces": [{ "binding": "AUTH", "id": "0123456789abcdef0123456789abcdef" }],
  "r2_buckets": [{ "binding": "R2_BUCKET", "bucket_name": "my-bucket" }],
  "routes": [{ "pattern": "packages.example.com", "custom_domain": true }],
  "vars": { "ECOSYSTEMS": "composer" },
  "triggers": { "crons": ["5 * * * *"] },
  "keep_vars": false,
}
`;

  it("keeps upstream's file and the installation's own configuration", () => {
    const { text, carried } = overlayInstallation(upstream, installation);
    const config = readConfig(text);
    assert.equal(config.name, "my-registry");
    assert.equal(config.r2_buckets[0].bucket_name, "my-bucket");
    assert.deepEqual(config.kv_namespaces, [
      { binding: "AUTH", id: "0123456789abcdef0123456789abcdef" },
      { binding: "CACHE" },
    ]);
    assert.equal(config.routes[0].pattern, "packages.example.com");
    assert.deepEqual(config.vars, { ECOSYSTEMS: "composer" });
    assert.deepEqual(carried.sort(), ["kv_namespaces", "name", "r2_buckets", "routes", "vars"]);
  });

  it("takes the keys upstream owns from upstream", () => {
    const config = readConfig(overlayInstallation(upstream, installation).text);
    assert.equal(config.main, "src/index.ts");
    assert.equal(config.compatibility_date, "2026-12-01");
    assert.deepEqual(config.triggers, { crons: ["0 * * * *"] });
    assert.equal(config.keep_vars, true);
  });

  it("keeps upstream's comments", () => {
    const { text } = overlayInstallation(upstream, installation);
    assert.match(text, /upstream header/);
    assert.match(text, /\/\/ the bindings/);
  });

  it("changes nothing when the installation matches upstream", () => {
    const { text, carried } = overlayInstallation(UPSTREAM, UPSTREAM);
    assert.equal(text, UPSTREAM);
    assert.deepEqual(carried, []);
  });
});

describe("configureBindings", () => {
  it("writes the settings that are given and leaves the others", () => {
    const { text, changes } = configureBindings(UPSTREAM, {
      workerName: "my-registry",
      r2Bucket: "my-bucket",
      kvNamespaceId: "0123456789ABCDEF0123456789abcdef",
      route: "Packages.Example.com",
    });
    const config = readConfig(text);
    assert.equal(config.name, "my-registry");
    assert.equal(config.r2_buckets[0].bucket_name, "my-bucket");
    assert.deepEqual(config.kv_namespaces, [
      { binding: "AUTH", id: "0123456789abcdef0123456789abcdef" },
    ]);
    assert.deepEqual(config.routes, [{ pattern: "packages.example.com", custom_domain: true }]);
    assert.equal(config.keep_vars, true);
    assert.equal(changes.length, 4);
    assert.match(text, /Workers Logs in the dashboard/);
  });

  it("does nothing without settings", () => {
    const { text, changes } = configureBindings(UPSTREAM, { workerName: "  ", r2Bucket: "" });
    assert.equal(text, UPSTREAM);
    assert.deepEqual(changes, []);
  });

  it("writes the jurisdiction of the R2 bucket, and removes it with none", () => {
    const eu = configureBindings(UPSTREAM, { r2Bucket: "my-bucket", r2Jurisdiction: "EU" });
    assert.deepEqual(readConfig(eu.text).r2_buckets, [
      { binding: "R2_BUCKET", bucket_name: "my-bucket", jurisdiction: "eu" },
    ]);
    assert.deepEqual(eu.changes, [
      "R2_BUCKET bucket_name = my-bucket",
      "R2_BUCKET jurisdiction = eu",
    ]);

    const again = configureBindings(eu.text, { r2Jurisdiction: "eu" });
    assert.equal(again.text, eu.text);
    assert.deepEqual(again.changes, []);

    const none = configureBindings(eu.text, { r2Jurisdiction: "none" });
    assert.deepEqual(readConfig(none.text).r2_buckets, [
      { binding: "R2_BUCKET", bucket_name: "my-bucket" },
    ]);
    assert.deepEqual(none.changes, ["R2_BUCKET jurisdiction = none"]);
    assert.equal(configureBindings(UPSTREAM, { r2Jurisdiction: "none" }).text, UPSTREAM);
  });

  it("keeps the jurisdiction of the installation when updating from upstream", () => {
    const own = configureBindings(UPSTREAM, { r2Bucket: "my-bucket", r2Jurisdiction: "eu" }).text;
    const { text } = overlayInstallation(UPSTREAM, own);
    assert.equal(readConfig(text).r2_buckets[0].jurisdiction, "eu");
  });

  it("adds a binding the file does not have", () => {
    const { text } = configureBindings('{ "name": "a" }', { r2Bucket: "my-bucket" });
    assert.deepEqual(readConfig(text).r2_buckets, [
      { binding: "R2_BUCKET", bucket_name: "my-bucket" },
    ]);
  });

  it("refuses values Cloudflare would not accept", () => {
    assert.throws(() => configureBindings(UPSTREAM, { workerName: "Bad Name" }), ConfigError);
    assert.throws(() => configureBindings(UPSTREAM, { r2Bucket: "UPPER" }), ConfigError);
    assert.throws(() => configureBindings(UPSTREAM, { r2Jurisdiction: "mars" }), ConfigError);
    assert.throws(() => configureBindings(UPSTREAM, { r2Bucket: "a" }), ConfigError);
    assert.throws(() => configureBindings(UPSTREAM, { kvNamespaceId: "123" }), ConfigError);
    assert.throws(() => configureBindings(UPSTREAM, { route: "a.example.com/path" }), ConfigError);
    assert.throws(() => configureBindings(UPSTREAM, { route: "localhost" }), ConfigError);
  });
});
