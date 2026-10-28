#!/usr/bin/env node
// Brings the code of the upstream repository into this one: picks the release (or `main`) to
// update to, refuses to go back to an older version and merges it, laying this installation's
// bindings over `wrangler.jsonc` when the two files conflict. Used by
// .github/workflows/update.yml and runnable locally:
//
//   node scripts/sync-upstream.mjs plan --channel stable|prerelease|custom|develop
//                                       [--tag <tag>] [--upstream <url>] [--root <dir>]
//   node scripts/sync-upstream.mjs merge [--message <commit message>] [--allow-workflows]
//                                        [--root <dir>]
//
// `plan` fetches the chosen ref into refs/sync/upstream and prints JSON about it; `merge` merges
// that ref into the checked-out branch (and commits it with --message) and prints JSON about
// the result. Nothing is pushed. See docs/deployment.md ("Updating with a workflow").
// No dependencies: only Node's standard library.

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { compareVersions, parseVersion, readCurrentVersion } from "./bump-version.mjs";
import { overlayInstallation } from "./wrangler-config.mjs";

export const DEFAULT_UPSTREAM = "https://github.com/kduma-OSS/serverless-registry-worker.git";
export const CHANNELS = ["stable", "prerelease", "custom", "develop"];
/** Where `plan` keeps the fetched upstream ref. */
export const UPSTREAM_REF = "refs/sync/upstream";

const CONFIG_FILE = "wrangler.jsonc";
const WORKFLOWS_DIR = ".github/workflows";

export class SyncError extends Error {}

// ---------------------------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------------------------

/** Runs git in `root`. With `allowFail` a failure is returned instead of thrown. */
function git(root, args, { allowFail = false } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error !== undefined) throw new SyncError(`git could not run: ${result.error.message}`);
  if (result.status !== 0 && !allowFail) {
    const message = (result.stderr || result.stdout || "").trim();
    throw new SyncError(`git ${args.join(" ")} failed: ${message}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------------------------
// Choosing the release
// ---------------------------------------------------------------------------------------------

/** The `vX.Y.Z` release tags of a `git ls-remote --tags` listing, as `{ tag, version }`. */
export function parseTags(listing) {
  const tags = new Set();
  for (const line of listing.split("\n")) {
    const match = /\srefs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (match !== null) tags.add(match[1]);
  }
  const releases = [];
  for (const tag of tags) {
    const version = tag.startsWith("v") ? tag.slice(1) : null;
    if (version !== null && parseVersion(version) !== null) releases.push({ tag, version });
  }
  return releases.sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * What to update to: `{ ref, label }` where `ref` is the ref to fetch from upstream. `stable` is
 * the newest release without a prerelease suffix, `prerelease` the newest release of any kind,
 * `custom` the tag asked for (with or without the `v`) and `develop` the `main` branch.
 */
export function selectTarget(releases, channel, tag = "") {
  switch (channel) {
    case "stable": {
      const stable = releases.filter((r) => parseVersion(r.version).prerelease.length === 0);
      const latest = stable.at(-1);
      if (latest === undefined) throw new SyncError("Upstream has no stable release yet");
      return { ref: `refs/tags/${latest.tag}`, label: latest.tag };
    }
    case "prerelease": {
      const latest = releases.at(-1);
      if (latest === undefined) throw new SyncError("Upstream has no release yet");
      return { ref: `refs/tags/${latest.tag}`, label: latest.tag };
    }
    case "custom": {
      const wanted = tag.trim().replace(/^v/, "");
      if (wanted === "") throw new SyncError("The custom channel needs a tag");
      if (parseVersion(wanted) === null) {
        throw new SyncError(`"${tag.trim()}" is not a release tag such as v1.2.3`);
      }
      const found = releases.find((r) => r.version === wanted);
      if (found === undefined) {
        const latest = releases.slice(-5).map((r) => r.tag);
        throw new SyncError(
          `Upstream has no tag v${wanted}${latest.length > 0 ? ` (latest: ${latest.join(", ")})` : ""}`,
        );
      }
      return { ref: `refs/tags/${found.tag}`, label: found.tag };
    }
    case "develop":
      return { ref: "refs/heads/main", label: "develop" };
    default:
      throw new SyncError(`Unknown channel "${channel}"; use ${CHANNELS.join(", ")}`);
  }
}

/**
 * Chooses the release, fetches it into {@link UPSTREAM_REF} and checks that its version is not
 * older than the one in this repository. Returns what was chosen.
 */
export function plan({ root, channel, tag = "", upstream = DEFAULT_UPSTREAM }) {
  const listing = git(root, ["ls-remote", "--tags", upstream]).stdout;
  const target = selectTarget(parseTags(listing), channel, tag);
  git(root, ["fetch", "--no-tags", "--quiet", upstream, `+${target.ref}:${UPSTREAM_REF}`]);
  const sha = git(root, ["rev-parse", `${UPSTREAM_REF}^{commit}`]).stdout.trim();
  const manifest = git(root, ["show", `${sha}:package.json`]).stdout;
  const version = JSON.parse(manifest).version;
  if (typeof version !== "string" || parseVersion(version) === null) {
    throw new SyncError(`${target.label} has no valid version in package.json`);
  }
  const current = readCurrentVersion(root);
  const order = compareVersions(version, current);
  if (order < 0) {
    throw new SyncError(
      `${target.label} is version ${version}, older than the ${current} in this repository; ` +
        "an update never goes back (roll back in the Cloudflare dashboard instead).",
    );
  }
  return {
    channel,
    label: target.label,
    ref: UPSTREAM_REF,
    sha,
    version,
    current,
    relation: order === 0 ? "same" : "newer",
  };
}

// ---------------------------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------------------------

function lines(text) {
  return text.split("\n").filter((line) => line !== "");
}

function readAtRef(root, ref, file) {
  const result = git(root, ["show", `${ref}:${file}`], { allowFail: true });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Merges {@link UPSTREAM_REF} into the checked-out branch. Without a common history (a copy
 * made by the Deploy to Cloudflare button) upstream's files win; either way a conflict in
 * `wrangler.jsonc` is settled by laying the installation's bindings and settings over upstream's
 * file, and a conflict anywhere else aborts the merge. Files of `.github/workflows` stay as they
 * are unless `allowWorkflows` (a token that may push them). With `message` the result is
 * committed. Returns what happened.
 */
export function merge({ root, message = "", allowWorkflows = false, ref = UPSTREAM_REF }) {
  const head = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  const own = readAtRef(root, "HEAD", CONFIG_FILE);
  const related = git(root, ["merge-base", "HEAD", ref], { allowFail: true }).status === 0;

  const args = ["merge", "--no-commit", "--no-ff"];
  if (!related) args.push("--allow-unrelated-histories", "-X", "theirs");
  args.push(ref);
  const merged = git(root, args, { allowFail: true });
  const inProgress = git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
    allowFail: true,
  });
  if (inProgress.status !== 0) {
    if (merged.status !== 0) {
      throw new SyncError(`git merge failed: ${(merged.stderr || merged.stdout).trim()}`);
    }
    return { status: "up-to-date", related, conflicts: [], carried: [], skippedWorkflows: [] };
  }

  const conflicts = lines(git(root, ["diff", "--name-only", "--diff-filter=U"]).stdout);
  const carried = [];
  const settled = [];
  if (conflicts.length > 0 || !related) {
    const upstreamConfig = readAtRef(root, ref, CONFIG_FILE);
    if (own !== null && upstreamConfig !== null) {
      const result = overlayInstallation(upstreamConfig, own);
      writeFileSync(path.join(root, CONFIG_FILE), result.text);
      git(root, ["add", CONFIG_FILE]);
      carried.push(...result.carried);
      if (conflicts.includes(CONFIG_FILE)) settled.push(CONFIG_FILE);
    }
  }
  const unsettled = conflicts.filter((file) => !settled.includes(file));
  if (unsettled.length > 0) {
    git(root, ["merge", "--abort"]);
    throw new SyncError(
      `The update conflicts with changes in this repository in: ${unsettled.join(", ")}. ` +
        "Nothing was changed. Merge the update by hand (docs/deployment.md, Updating).",
    );
  }

  const skippedWorkflows = [];
  if (!allowWorkflows) {
    const changed = lines(
      git(root, ["diff", "--cached", "--name-status", head, "--", WORKFLOWS_DIR]).stdout,
    );
    for (const line of changed) {
      const [status, file] = line.split("\t");
      if (status === "A") git(root, ["rm", "-q", "-f", "--", file]);
      else git(root, ["checkout", head, "--", file]);
      skippedWorkflows.push(file);
    }
  }

  if (message !== "") {
    git(root, ["commit", "--quiet", "-m", message]);
  }
  return { status: "merged", related, conflicts: settled, carried, skippedWorkflows };
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new SyncError(`Unexpected argument "${arg}"`);
    const key = arg.slice(2);
    if (key === "allow-workflows") {
      options[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new SyncError(`${arg} needs a value`);
    options[key] = value;
    i += 1;
  }
  return options;
}

export function run(argv) {
  const [command, ...rest] = argv;
  const options = parseArgs(rest);
  const root = path.resolve(options.root ?? process.cwd());
  if (!existsSync(path.join(root, "package.json"))) {
    throw new SyncError(`${root} is not a checkout of the registry (no package.json)`);
  }
  switch (command) {
    case "plan":
      return plan({
        root,
        channel: options.channel ?? "",
        tag: options.tag ?? "",
        upstream: options.upstream ?? process.env.UPSTREAM_URL ?? DEFAULT_UPSTREAM,
      });
    case "merge":
      return merge({
        root,
        message: options.message ?? "",
        allowWorkflows: options["allow-workflows"] === true,
      });
    default:
      throw new SyncError("Usage: sync-upstream.mjs plan|merge [options] (see the file header)");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    process.stderr.write(`${err.message}\n`);
    process.exit(err instanceof SyncError ? 1 : 2);
  }
}
