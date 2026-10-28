// Tests of scripts/sync-upstream.mjs on real git repositories in temporary directories:
// node --test scripts/

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";

import { merge, parseTags, plan, selectTarget, SyncError } from "./sync-upstream.mjs";
import { readConfig } from "./wrangler-config.mjs";

// ---------------------------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------------------------

const LISTING = [
  "1111\trefs/tags/v0.1.0",
  "2222\trefs/tags/v0.1.0^{}",
  "3333\trefs/tags/v0.2.0-beta.1",
  "4444\trefs/tags/v0.2.0",
  "5555\trefs/tags/v0.10.0",
  "6666\trefs/tags/v0.11.0-beta.2",
  "7777\trefs/tags/not-a-release",
  "8888\trefs/tags/1.0.0",
].join("\n");

describe("parseTags", () => {
  it("keeps the release tags, once each, in version order", () => {
    assert.deepEqual(
      parseTags(LISTING).map((r) => r.tag),
      ["v0.1.0", "v0.2.0-beta.1", "v0.2.0", "v0.10.0", "v0.11.0-beta.2"],
    );
  });
});

describe("selectTarget", () => {
  const releases = parseTags(LISTING);

  it("takes the newest release without a prerelease suffix for stable", () => {
    assert.deepEqual(selectTarget(releases, "stable"), {
      ref: "refs/tags/v0.10.0",
      label: "v0.10.0",
    });
  });

  it("takes the newest release of any kind for prerelease", () => {
    assert.equal(selectTarget(releases, "prerelease").label, "v0.11.0-beta.2");
    // A stable release newer than every prerelease wins.
    assert.equal(selectTarget(releases.slice(0, 3), "prerelease").label, "v0.2.0");
  });

  it("takes the tag asked for, with or without the v", () => {
    assert.equal(selectTarget(releases, "custom", "v0.2.0-beta.1").label, "v0.2.0-beta.1");
    assert.equal(selectTarget(releases, "custom", " 0.2.0 ").label, "v0.2.0");
  });

  it("refuses a custom tag that is missing, malformed or absent", () => {
    assert.throws(() => selectTarget(releases, "custom", "v9.9.9"), /no tag v9\.9\.9/);
    assert.throws(() => selectTarget(releases, "custom", "main"), /not a release tag/);
    assert.throws(() => selectTarget(releases, "custom", ""), /needs a tag/);
  });

  it("takes main for develop", () => {
    assert.deepEqual(selectTarget(releases, "develop"), {
      ref: "refs/heads/main",
      label: "develop",
    });
  });

  it("refuses an unknown channel and an upstream without releases", () => {
    assert.throws(() => selectTarget(releases, "nightly"), /Unknown channel/);
    assert.throws(() => selectTarget([], "stable"), /no stable release/);
    assert.throws(() => selectTarget([], "prerelease"), /no release/);
  });
});

// ---------------------------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------------------------

const ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
Object.assign(process.env, ENV);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root, file, text) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

const read = (root, file) => readFileSync(path.join(root, file), "utf8");

function wrangler({ name = "serverless-registry", bucket = "serverless-registry", extra = "" }) {
  return `// upstream
{
  "name": "${name}",
  "main": "src/index.ts",
  "kv_namespaces": [{ "binding": "AUTH" }],
  "r2_buckets": [{ "binding": "R2_BUCKET", "bucket_name": "${bucket}" }${extra}],
  "keep_vars": true,
}
`;
}

function manifest(version) {
  return `${JSON.stringify({ name: "serverless-registry-worker", version }, null, 2)}\n`;
}

let dir;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sync-upstream-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
const fresh = (name) => path.join(dir, `${name}-${counter++}`);

/** An upstream with the releases v0.1.0, v0.2.0-beta.1, v0.2.0, v0.3.0-beta.1 and a `main` after them. */
function makeUpstream() {
  const root = fresh("upstream");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  const commit = (message, tag) => {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", message);
    if (tag !== undefined) git(root, "tag", tag);
  };
  write(root, "package.json", manifest("0.1.0"));
  write(root, "wrangler.jsonc", wrangler({}));
  write(root, "src/a.txt", "one\ntwo\nthree\n");
  write(root, ".github/workflows/ci.yml", "name: CI\n");
  commit("0.1.0", "v0.1.0");

  write(root, "package.json", manifest("0.2.0-beta.1"));
  write(root, "wrangler.jsonc", wrangler({ extra: ', { "binding": "NEW" }' }));
  write(root, "src/a.txt", "one\nTWO upstream\nthree\n");
  write(root, "src/b.txt", "new file\n");
  write(root, ".github/workflows/ci.yml", "name: CI v2\n");
  write(root, ".github/workflows/update.yml", "name: Update\n");
  commit("0.2.0-beta.1", "v0.2.0-beta.1");

  write(root, "package.json", manifest("0.2.0"));
  commit("0.2.0", "v0.2.0");

  write(root, "package.json", manifest("0.3.0-beta.1"));
  commit("0.3.0-beta.1", "v0.3.0-beta.1");

  write(root, "src/c.txt", "unreleased\n");
  commit("after the beta");
  return root;
}

/** A copy of upstream at `tag` (with its history) whose wrangler.jsonc is configured. */
function makeCopy(upstream, tag, { bucket = "my-bucket", name = "my-registry" } = {}) {
  const root = fresh("copy");
  git(dir, "clone", "-q", upstream, root);
  git(root, "checkout", "-q", "-b", "work", tag);
  git(root, "branch", "-q", "-M", "main");
  write(
    root,
    "wrangler.jsonc",
    wrangler({ name, bucket }).replace(
      '[{ "binding": "AUTH" }]',
      '[{ "binding": "AUTH", "id": "0123456789abcdef0123456789abcdef" }]',
    ),
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "configure the bindings");
  return root;
}

const parents = (root) => git(root, "log", "-1", "--format=%P").split(" ").filter(Boolean);

// ---------------------------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------------------------

describe("plan", () => {
  it("chooses the newest stable release and says it is newer", () => {
    const upstream = makeUpstream();
    const copy = makeCopy(upstream, "v0.1.0");
    const result = plan({ root: copy, channel: "stable", upstream });
    assert.equal(result.label, "v0.2.0");
    assert.equal(result.version, "0.2.0");
    assert.equal(result.current, "0.1.0");
    assert.equal(result.relation, "newer");
    assert.equal(result.sha, git(upstream, "rev-parse", "v0.2.0^{commit}"));
  });

  it("chooses the newest prerelease, a tag asked for and main", () => {
    const upstream = makeUpstream();
    const copy = makeCopy(upstream, "v0.1.0");
    assert.equal(plan({ root: copy, channel: "prerelease", upstream }).label, "v0.3.0-beta.1");
    const custom = plan({ root: copy, channel: "custom", tag: "0.2.0-beta.1", upstream });
    assert.equal(custom.version, "0.2.0-beta.1");
    const develop = plan({ root: copy, channel: "develop", upstream });
    assert.equal(develop.label, "develop");
    assert.equal(develop.sha, git(upstream, "rev-parse", "main"));
  });

  it("accepts the version the repository already has", () => {
    const upstream = makeUpstream();
    const copy = makeCopy(upstream, "v0.2.0");
    assert.equal(plan({ root: copy, channel: "stable", upstream }).relation, "same");
  });

  it("refuses a version older than the one in the repository", () => {
    const upstream = makeUpstream();
    const copy = makeCopy(upstream, "v0.3.0-beta.1");
    assert.throws(
      () => plan({ root: copy, channel: "stable", upstream }),
      (err) => err instanceof SyncError && /older than the 0\.3\.0-beta\.1/.test(err.message),
    );
    assert.throws(() => plan({ root: copy, channel: "custom", tag: "v0.1.0", upstream }), /older/);
  });

  it("refuses a missing tag", () => {
    const upstream = makeUpstream();
    const copy = makeCopy(upstream, "v0.1.0");
    assert.throws(
      () => plan({ root: copy, channel: "custom", tag: "v7.0.0", upstream }),
      /no tag v7\.0\.0/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------------------------

describe("merge", () => {
  it("merges a release into a copy with the same history and keeps its bindings", () => {
    const upstream = makeUpstream();
    const copy = makeCopy(upstream, "v0.1.0");
    plan({ root: copy, channel: "stable", upstream });
    const result = merge({ root: copy, message: "chore: update from upstream v0.2.0" });

    assert.equal(result.status, "merged");
    assert.equal(result.related, true);
    assert.equal(parents(copy).length, 2);
    assert.equal(git(copy, "log", "-1", "--format=%s"), "chore: update from upstream v0.2.0");
    assert.equal(readConfig(read(copy, "package.json")).version, "0.2.0");
    assert.equal(read(copy, "src/a.txt"), "one\nTWO upstream\nthree\n");
    const config = readConfig(read(copy, "wrangler.jsonc"));
    assert.equal(config.name, "my-registry");
    assert.equal(config.r2_buckets[0].bucket_name, "my-bucket");
    assert.deepEqual(config.kv_namespaces[0].id, "0123456789abcdef0123456789abcdef");
  });

  it("settles a conflict in wrangler.jsonc with the installation's bindings", () => {
    const upstream = makeUpstream();
    const copy = makeCopy(upstream, "v0.1.0");
    plan({ root: copy, channel: "stable", upstream });
    const result = merge({ root: copy, message: "update" });

    assert.deepEqual(result.conflicts, ["wrangler.jsonc"]);
    assert.ok(result.carried.includes("r2_buckets"));
    const text = read(copy, "wrangler.jsonc");
    assert.doesNotMatch(text, /<<<<<<<|>>>>>>>/);
    assert.match(text, /\/\/ upstream/);
    const config = readConfig(text);
    assert.deepEqual(config.r2_buckets, [
      { binding: "R2_BUCKET", bucket_name: "my-bucket" },
      { binding: "NEW" },
    ]);
    assert.equal(config.main, "src/index.ts");
    assert.equal(git(copy, "status", "--porcelain"), "");
  });

  it("aborts without changes when another file conflicts", () => {
    const upstream = makeUpstream();
    const copy = makeCopy(upstream, "v0.1.0");
    write(copy, "src/a.txt", "one\nTWO mine\nthree\n");
    git(copy, "commit", "-q", "-am", "my change");
    const head = git(copy, "rev-parse", "HEAD");
    plan({ root: copy, channel: "stable", upstream });

    assert.throws(
      () => merge({ root: copy, message: "update" }),
      (err) => err instanceof SyncError && /conflicts .* in: src\/a\.txt/.test(err.message),
    );
    assert.equal(git(copy, "rev-parse", "HEAD"), head);
    assert.equal(git(copy, "status", "--porcelain"), "");
    assert.equal(read(copy, "src/a.txt"), "one\nTWO mine\nthree\n");
  });

  it("takes upstream's files and keeps the bindings of a copy without a shared history", () => {
    const upstream = makeUpstream();
    const copy = fresh("button");
    mkdirSync(copy);
    git(copy, "init", "-q", "-b", "main");
    write(copy, "package.json", manifest("0.1.0"));
    write(copy, "src/a.txt", "one\ntwo\nthree\n");
    write(copy, "wrangler.jsonc", wrangler({ name: "mine", bucket: "my-bucket" }));
    write(copy, ".github/workflows/ci.yml", "name: CI\n");
    git(copy, "add", "-A");
    git(copy, "commit", "-q", "-m", "copy");
    plan({ root: copy, channel: "stable", upstream });

    const result = merge({ root: copy, message: "update" });
    assert.equal(result.related, false);
    assert.equal(read(copy, "src/a.txt"), "one\nTWO upstream\nthree\n");
    const config = readConfig(read(copy, "wrangler.jsonc"));
    assert.equal(config.name, "mine");
    assert.equal(config.r2_buckets[0].bucket_name, "my-bucket");
    assert.equal(config.r2_buckets[1].binding, "NEW");
    assert.equal(readConfig(read(copy, "package.json")).version, "0.2.0");
  });

  it("leaves the files of .github/workflows alone without a token that may push them", () => {
    const upstream = makeUpstream();
    const copy = makeCopy(upstream, "v0.1.0");
    plan({ root: copy, channel: "stable", upstream });
    const result = merge({ root: copy, message: "update" });

    assert.deepEqual(result.skippedWorkflows.sort(), [
      ".github/workflows/ci.yml",
      ".github/workflows/update.yml",
    ]);
    assert.equal(read(copy, ".github/workflows/ci.yml"), "name: CI\n");
    assert.equal(existsSync(path.join(copy, ".github/workflows/update.yml")), false);
    assert.equal(read(copy, "src/b.txt"), "new file\n");
  });

  it("updates the files of .github/workflows with a token that may push them", () => {
    const upstream = makeUpstream();
    const copy = makeCopy(upstream, "v0.1.0");
    plan({ root: copy, channel: "stable", upstream });
    const result = merge({ root: copy, message: "update", allowWorkflows: true });

    assert.deepEqual(result.skippedWorkflows, []);
    assert.equal(read(copy, ".github/workflows/ci.yml"), "name: CI v2\n");
    assert.equal(read(copy, ".github/workflows/update.yml"), "name: Update\n");
  });

  it("does not commit without a message, and the merge can be undone", () => {
    const upstream = makeUpstream();
    const copy = makeCopy(upstream, "v0.1.0");
    const head = git(copy, "rev-parse", "HEAD");
    plan({ root: copy, channel: "stable", upstream });
    merge({ root: copy });
    assert.equal(git(copy, "rev-parse", "HEAD"), head);
    assert.match(git(copy, "diff", "--cached", "--stat"), /package\.json/);
    git(copy, "merge", "--abort");
    assert.equal(git(copy, "status", "--porcelain"), "");
  });

  it("reports an update that changes nothing", () => {
    const upstream = makeUpstream();
    const copy = makeCopy(upstream, "v0.1.0");
    plan({ root: copy, channel: "stable", upstream });
    merge({ root: copy, message: "update" });
    plan({ root: copy, channel: "stable", upstream });
    assert.equal(merge({ root: copy, message: "again" }).status, "up-to-date");
  });

  it("follows main for develop", () => {
    const upstream = makeUpstream();
    const copy = makeCopy(upstream, "v0.2.0");
    const result = plan({ root: copy, channel: "develop", upstream });
    assert.equal(result.version, "0.3.0-beta.1");
    merge({ root: copy, message: "update" });
    assert.equal(read(copy, "src/c.txt"), "unreleased\n");
  });
});
