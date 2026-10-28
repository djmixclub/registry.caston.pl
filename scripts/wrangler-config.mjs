// Edits `wrangler.jsonc` as text, keeping its comments: reads it, sets top-level keys and carries
// the installation's own configuration (bindings, name, routes, vars) over a new copy from
// upstream. Used by scripts/sync-upstream.mjs and scripts/configure-wrangler.mjs, and by the
// workflows .github/workflows/update.yml and configure.yml. No dependencies: only Node.

export class ConfigError extends Error {}

/**
 * Keys that belong to the upstream project: an update always takes them from upstream, whatever
 * the installation's file says.
 */
export const UPSTREAM_KEYS = new Set([
  "$schema",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "assets",
  "triggers",
  "observability",
  "keep_vars",
]);

/** Arrays of bindings; the entries are matched by their `binding` name. */
export const BINDING_ARRAYS = new Set([
  "kv_namespaces",
  "r2_buckets",
  "d1_databases",
  "services",
  "vectorize",
  "hyperdrive",
  "analytics_engine_datasets",
]);

// ---------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------

/** The index after the whitespace and comments that start at `i`. */
function skipTrivia(text, i) {
  for (;;) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
    } else if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new ConfigError("wrangler.jsonc has an unterminated comment");
      i = end + 2;
    } else {
      return i;
    }
  }
}

/** The index after the string that starts at `i`. */
function endOfString(text, i) {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  if (j >= text.length) throw new ConfigError("wrangler.jsonc has an unterminated string");
  return j + 1;
}

/** The index after the value that starts at `i`. */
function endOfValue(text, i) {
  const c = text[i];
  if (c === '"') return endOfString(text, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    let j = i;
    while (j < text.length) {
      const d = text[j];
      if (d === '"') {
        j = endOfString(text, j);
        continue;
      }
      if (d === "/" && (text[j + 1] === "/" || text[j + 1] === "*")) {
        j = skipTrivia(text, j);
        continue;
      }
      if (d === "{" || d === "[") depth += 1;
      if (d === "}" || d === "]") depth -= 1;
      j += 1;
      if (depth === 0) return j;
    }
    throw new ConfigError("wrangler.jsonc has an unterminated object or array");
  }
  let j = i;
  while (j < text.length && !/[\s,}\]/]/.test(text[j])) j += 1;
  if (j === i) throw new ConfigError("wrangler.jsonc has a value that cannot be read");
  return j;
}

/**
 * The keys of the top-level object with the span of each value:
 * `{ open, close, entries: [{ key, keyStart, valueStart, valueEnd }] }`.
 */
export function topLevelEntries(text) {
  let i = skipTrivia(text, 0);
  if (text[i] !== "{") throw new ConfigError("wrangler.jsonc must hold one object");
  const open = i;
  i += 1;
  const entries = [];
  for (;;) {
    i = skipTrivia(text, i);
    if (i >= text.length) throw new ConfigError("wrangler.jsonc has an unterminated object");
    if (text[i] === "}") return { open, close: i, entries };
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (text[i] !== '"') throw new ConfigError("wrangler.jsonc has a key that is not a string");
    const keyStart = i;
    const keyEnd = endOfString(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd));
    i = skipTrivia(text, keyEnd);
    if (text[i] !== ":") throw new ConfigError(`wrangler.jsonc has no value for "${key}"`);
    i = skipTrivia(text, i + 1);
    const valueStart = i;
    const valueEnd = endOfValue(text, i);
    entries.push({ key, keyStart, valueStart, valueEnd });
    i = valueEnd;
  }
}

/** Plain JSON: the text without comments and without trailing commas. */
function stripJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      i = skipTrivia(text, i);
    } else if (c === "}" || c === "]") {
      out = out.replace(/,(\s*)$/, "$1");
      out += c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** The configuration as an object. */
export function readConfig(text) {
  try {
    const config = JSON.parse(stripJsonc(text));
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new ConfigError("wrangler.jsonc must hold one object");
    }
    return config;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`wrangler.jsonc is not valid: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

/** JSON of a value, its lines after the first indented by `indent`. */
function serialize(value, indent) {
  return JSON.stringify(value, null, 2).replaceAll("\n", `\n${indent}`);
}

/** The whitespace at the start of the line that holds `index`. */
function indentOf(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, index))[0];
}

/**
 * The text with the top-level `key` set to `value`: the value of an existing key is replaced
 * (its comments stay), a missing key is added after the last one.
 */
export function setTopLevel(text, key, value) {
  const { open, entries } = topLevelEntries(text);
  const existing = entries.find((e) => e.key === key);
  if (existing !== undefined) {
    const indent = indentOf(text, existing.keyStart);
    return (
      text.slice(0, existing.valueStart) + serialize(value, indent) + text.slice(existing.valueEnd)
    );
  }
  const last = entries.at(-1);
  const indent = last === undefined ? "  " : indentOf(text, last.keyStart);
  const entry = `"${key}": ${serialize(value, indent)}`;
  if (last === undefined)
    return `${text.slice(0, open + 1)}\n${indent}${entry}\n${text.slice(open + 1)}`;
  const next = skipTrivia(text, last.valueEnd);
  if (text[next] === ",") {
    return `${text.slice(0, next + 1)}\n${indent}${entry},${text.slice(next + 1)}`;
  }
  return `${text.slice(0, last.valueEnd)},\n${indent}${entry}${text.slice(last.valueEnd)}`;
}

/** A canonical form of a value, for comparing. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * The bindings of upstream with the installation's fields over them (matched by `binding`),
 * then the installation's own bindings that upstream does not have.
 */
export function mergeBindings(upstream, installation) {
  const merged = upstream.map((u) => {
    const own = installation.find((i) => i?.binding === u?.binding);
    return own === undefined ? u : { ...u, ...own };
  });
  for (const own of installation) {
    if (!upstream.some((u) => u?.binding === own?.binding)) merged.push(own);
  }
  return merged;
}

/**
 * The text of `upstreamText` (its comments and the keys it owns) with what the installation
 * configured in `installationText` laid over it: its bindings (merged by name), its name,
 * routes, account, variables and any key upstream does not know. `carried` lists the keys whose
 * value differs from upstream's.
 */
export function overlayInstallation(upstreamText, installationText) {
  const upstream = readConfig(upstreamText);
  const installation = readConfig(installationText);
  let text = upstreamText;
  const carried = [];
  for (const [key, own] of Object.entries(installation)) {
    if (UPSTREAM_KEYS.has(key)) continue;
    const value =
      BINDING_ARRAYS.has(key) && Array.isArray(own) ? mergeBindings(upstream[key] ?? [], own) : own;
    if (canonical(value) === canonical(upstream[key])) continue;
    text = setTopLevel(text, key, value);
    carried.push(key);
  }
  return { text, carried };
}

// ---------------------------------------------------------------------------------------------
// Configuring the bindings
// ---------------------------------------------------------------------------------------------

const WORKER_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const KV_ID = /^[0-9a-f]{32}$/;
/** Values of the R2 jurisdiction setting: a jurisdiction, or `none` for the default one. */
export const R2_JURISDICTIONS = ["eu", "fedramp", "none"];
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function setBindingField(text, key, binding, field, value) {
  const config = readConfig(text);
  const list = Array.isArray(config[key]) ? [...config[key]] : [];
  const index = list.findIndex((b) => b?.binding === binding);
  if (value === undefined) {
    if (index === -1 || !(field in list[index])) return text;
    list[index] = Object.fromEntries(Object.entries(list[index]).filter(([k]) => k !== field));
    return setTopLevel(text, key, list);
  }
  if (index !== -1 && list[index][field] === value) return text;
  if (index === -1) list.push({ binding, [field]: value });
  else list[index] = { ...list[index], [field]: value };
  return setTopLevel(text, key, list);
}

/**
 * The text with the given settings written: `workerName` (`name`), `r2Bucket` (`bucket_name` of
 * `R2_BUCKET`), `r2Jurisdiction` (`jurisdiction` of `R2_BUCKET`: `eu`, `fedramp` or `none` for
 * the default one), `kvNamespaceId` (`id` of `AUTH`) and `route` (a custom domain, as `routes`).
 * Empty or missing settings are left as they are. Returns `{ text, changes }`.
 */
export function configureBindings(text, settings) {
  const changes = [];
  const given = (value) => (typeof value === "string" ? value.trim() : "");
  const workerName = given(settings.workerName);
  const r2Bucket = given(settings.r2Bucket);
  const r2Jurisdiction = given(settings.r2Jurisdiction).toLowerCase();
  const kvNamespaceId = given(settings.kvNamespaceId).toLowerCase();
  const route = given(settings.route).toLowerCase();

  if (r2Jurisdiction !== "" && !R2_JURISDICTIONS.includes(r2Jurisdiction)) {
    throw new ConfigError(`The R2 jurisdiction is one of ${R2_JURISDICTIONS.join(", ")}`);
  }
  if (workerName !== "") {
    if (!WORKER_NAME.test(workerName)) {
      throw new ConfigError(`"${workerName}" is not a valid Worker name`);
    }
    const next = setTopLevel(text, "name", workerName);
    if (next !== text) changes.push(`name = ${workerName}`);
    text = next;
  }
  if (r2Bucket !== "") {
    if (!BUCKET_NAME.test(r2Bucket)) {
      throw new ConfigError(`"${r2Bucket}" is not a valid R2 bucket name`);
    }
    const next = setBindingField(text, "r2_buckets", "R2_BUCKET", "bucket_name", r2Bucket);
    if (next !== text) changes.push(`R2_BUCKET bucket_name = ${r2Bucket}`);
    text = next;
  }
  if (r2Jurisdiction !== "") {
    const value = r2Jurisdiction === "none" ? undefined : r2Jurisdiction;
    const next = setBindingField(text, "r2_buckets", "R2_BUCKET", "jurisdiction", value);
    if (next !== text) changes.push(`R2_BUCKET jurisdiction = ${r2Jurisdiction}`);
    text = next;
  }
  if (kvNamespaceId !== "") {
    if (!KV_ID.test(kvNamespaceId)) {
      throw new ConfigError("The KV namespace ID is 32 hexadecimal characters");
    }
    const next = setBindingField(text, "kv_namespaces", "AUTH", "id", kvNamespaceId);
    if (next !== text) changes.push(`AUTH id = ${kvNamespaceId}`);
    text = next;
  }
  if (route !== "") {
    if (!HOSTNAME.test(route)) {
      throw new ConfigError(`"${route}" is not a host name (a custom domain has no path)`);
    }
    const routes = [{ pattern: route, custom_domain: true }];
    if (canonical(readConfig(text).routes) !== canonical(routes)) {
      text = setTopLevel(text, "routes", routes);
      changes.push(`routes = ${route} (custom domain)`);
    }
  }
  return { text, changes };
}
