/**
 * Stand-in adapter for ecosystems whose module is not written yet. Publishing, index building
 * and every other format-specific operation answer `404 not_found`; native routes are not
 * handled. Version rules fall back to the kernel's semver evaluation so that grants for the
 * ecosystem can already be created and stored. Replaced by the real adapter in later phases.
 */

import { ValidationError } from "../core/errors";
import { isValidRange, parseVersion, satisfies, type Dialect } from "../core/semver";
import { compareVersionStrings } from "../core/storage";
import type { Adapter, Eco } from "./types";

/** `MAJOR.MINOR.PATCH[-PRERELEASE]`: semver 2.0.0 without a leading `v` or build metadata. */
const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The range dialect used for an ecosystem until its adapter defines its own. */
function dialectOf(eco: Eco): Dialect {
  return eco === "composer" || eco === "cargo" ? eco : "npm";
}

/** An adapter for `eco` that has no format support yet. */
export function placeholderAdapter(eco: Eco): Adapter {
  const dialect = dialectOf(eco);
  const unavailable = (): never => {
    throw new ValidationError("not_found", `The ${eco} ecosystem is not available yet.`);
  };
  return {
    eco,
    parseManifest: unavailable,
    fileKey: unavailable,
    buildIndex: unavailable,
    route: () => null,
    filterIndex: unavailable,
    fileUrl: unavailable,
    versionUrl: unavailable,
    clientConfig: () => [],
    satisfies: (version, constraint) => satisfies(version, constraint, dialect),
    validateRange: (constraint) => isValidRange(constraint, dialect),
    validateVersion: (version) => STRICT_SEMVER_RE.test(version) && parseVersion(version) !== null,
    compareVersions: compareVersionStrings,
  };
}
