#!/usr/bin/env node
// Writes the bindings of this installation into wrangler.jsonc. Used by
// .github/workflows/configure.yml and runnable locally:
//
//   node scripts/configure-wrangler.mjs [--worker-name <name>] [--r2-bucket <bucket>]
//                                       [--r2-jurisdiction eu|fedramp|none]
//                                       [--kv-namespace-id <id>] [--route <host>]
//                                       [--dry-run] [--root <dir>]
//
// Settings that are empty or left out stay as they are. It prints JSON with the changes made
// (or, with --dry-run, that would be made). See docs/deployment.md ("Configure bindings").
// No dependencies: only Node's standard library.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ConfigError, configureBindings } from "./wrangler-config.mjs";

const OPTIONS = {
  "worker-name": "workerName",
  "r2-bucket": "r2Bucket",
  "r2-jurisdiction": "r2Jurisdiction",
  "kv-namespace-id": "kvNamespaceId",
  route: "route",
};

function parseArgs(argv) {
  const options = { settings: {}, dryRun: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const key = arg.startsWith("--") ? arg.slice(2) : "";
    if (key !== "root" && !(key in OPTIONS)) throw new ConfigError(`Unexpected argument "${arg}"`);
    const value = argv[i + 1];
    if (value === undefined) throw new ConfigError(`${arg} needs a value`);
    if (key === "root") options.root = path.resolve(value);
    else options.settings[OPTIONS[key]] = value;
    i += 1;
  }
  return options;
}

export function run(argv) {
  const { settings, dryRun, root } = parseArgs(argv);
  const file = path.join(root, "wrangler.jsonc");
  const before = readFileSync(file, "utf8");
  const { text, changes } = configureBindings(before, settings);
  const changed = text !== before;
  if (changed && !dryRun) writeFileSync(file, text);
  return { changed, dryRun, changes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    process.stderr.write(`${err.message}\n`);
    process.exit(err instanceof ConfigError ? 1 : 2);
  }
}
