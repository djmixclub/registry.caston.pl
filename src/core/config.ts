/**
 * Installation configuration read from Worker variables and secrets (see "Deployment,
 * configuration and updates" in docs/spec.md). Nothing installation-specific is committed, so
 * every value here comes from the Cloudflare dashboard or `wrangler secret put`. The optional
 * settings have their defaults here, not in `wrangler.jsonc`: a value in its `vars` would be
 * re-applied on every deploy and overwrite the one set in the dashboard.
 */

import { ECOS, type Eco } from "../adapters/types";
import type { Env } from "../env";
import { ValidationError } from "./errors";

/** Bucket name used when `R2_BUCKET_NAME` is unset or blank (the `bucket_name` in `wrangler.jsonc`). */
export const DEFAULT_BUCKET_NAME = "serverless-registry";

/** `MAX_UPLOAD_BYTES` used when the variable is missing or invalid (512 MiB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 536870912;

/** `APPEND_WINDOW_HOURS` used when the variable is missing or invalid. */
export const DEFAULT_APPEND_WINDOW_HOURS = 24;

/** `TOKEN_PREFIX` used when the variable is unset: issued tokens carry no prefix. */
export const DEFAULT_TOKEN_PREFIX = "";

/** `LOGIN_TOKEN_EXTENDED_TTL_HOURS` used when the variable is missing or invalid. */
export const DEFAULT_LOGIN_TOKEN_EXTENDED_TTL_HOURS = 24;

/** Whether update checks run when `CHECK_UPDATES` is unset or blank. */
export const DEFAULT_CHECK_UPDATES = true;

/** Everything `presignPut` and `presignGet` need besides the key. */
export interface PresignConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type PresignEnv = Pick<
  Env,
  "S3_ENDPOINT" | "S3_ACCESS_KEY_ID" | "S3_SECRET_ACCESS_KEY" | "R2_BUCKET_NAME"
>;

/**
 * The R2 S3 API endpoint, bucket and key used for presigning. Throws a `500 internal_error`
 * naming the missing settings (never their values) when presigning is not configured.
 */
export function presignConfig(env: PresignEnv): PresignConfig {
  const endpoint = env.S3_ENDPOINT?.trim() ?? "";
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() ?? "";
  const missing = [
    ["S3_ENDPOINT", endpoint],
    ["S3_ACCESS_KEY_ID", accessKeyId],
    ["S3_SECRET_ACCESS_KEY", secretAccessKey],
  ]
    .filter(([, value]) => value === "")
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new ValidationError(
      "internal_error",
      `Presigning is not configured: set ${missing.join(", ")} in the Worker settings.`,
    );
  }
  if (!URL.canParse(endpoint) || !/^https?:$/.test(new URL(endpoint).protocol)) {
    throw new ValidationError(
      "internal_error",
      "Presigning is not configured: S3_ENDPOINT must be an http(s) URL.",
    );
  }
  const bucket = env.R2_BUCKET_NAME?.trim() || DEFAULT_BUCKET_NAME;
  return { endpoint: endpoint.replace(/\/+$/, ""), bucket, accessKeyId, secretAccessKey };
}

/**
 * The registry's public base URL without a trailing slash: `PUBLIC_URL` when set, otherwise
 * the origin of the request.
 */
export function publicUrl(env: Pick<Env, "PUBLIC_URL">, request: Request): string {
  const configured = env.PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
  return configured !== "" ? configured : new URL(request.url).origin;
}

/** `MAX_UPLOAD_BYTES` as a number; the default when missing or not a positive integer. */
export function maxUploadBytes(env: Pick<Env, "MAX_UPLOAD_BYTES">): number {
  const raw = env.MAX_UPLOAD_BYTES?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return DEFAULT_MAX_UPLOAD_BYTES;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_UPLOAD_BYTES;
}

/**
 * The ecosystems enabled by `ECOSYSTEMS` (comma-separated, case-insensitive, unknown names
 * ignored), in the canonical order; every ecosystem when the variable is missing or blank.
 */
export function enabledEcosystems(env: Pick<Env, "ECOSYSTEMS">): Eco[] {
  const raw = env.ECOSYSTEMS?.trim() ?? "";
  if (raw === "") return [...ECOS];
  const named = new Set(raw.split(",").map((part) => part.trim().toLowerCase()));
  return ECOS.filter((eco) => named.has(eco));
}

/** `APPEND_WINDOW_HOURS` as a number; the default when missing or not a non-negative integer. */
export function appendWindowHours(env: Pick<Env, "APPEND_WINDOW_HOURS">): number {
  const raw = env.APPEND_WINDOW_HOURS?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return DEFAULT_APPEND_WINDOW_HOURS;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : DEFAULT_APPEND_WINDOW_HOURS;
}

/**
 * `LOGIN_TOKEN_EXTENDED_TTL_HOURS` as a number: how long a pull login token approved with
 * "extended validity" lasts. The default when missing or not an integer from 1 to 720.
 */
export function loginTokenExtendedTtlHours(
  env: Pick<Env, "LOGIN_TOKEN_EXTENDED_TTL_HOURS">,
): number {
  const raw = env.LOGIN_TOKEN_EXTENDED_TTL_HOURS?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return DEFAULT_LOGIN_TOKEN_EXTENDED_TTL_HOURS;
  const value = Number(raw);
  return value >= 1 && value <= 720 ? value : DEFAULT_LOGIN_TOKEN_EXTENDED_TTL_HOURS;
}

/** `TOKEN_PREFIX`, or the default (no prefix) when the variable is unset. */
export function tokenPrefix(env: Pick<Env, "TOKEN_PREFIX">): string {
  return env.TOKEN_PREFIX ?? DEFAULT_TOKEN_PREFIX;
}

/**
 * Whether the update check is enabled: `CHECK_UPDATES` is `true` (case-insensitive), or the
 * default when it is unset or blank. Any other value disables it.
 */
export function checkUpdates(env: Pick<Env, "CHECK_UPDATES">): boolean {
  const raw = env.CHECK_UPDATES?.trim().toLowerCase() ?? "";
  return raw === "" ? DEFAULT_CHECK_UPDATES : raw === "true";
}

/** How much a setting matters for a working installation. */
export type SetupLevel = "required" | "recommended" | "optional";

/** The settings of the setup checklist. */
export type SetupName =
  | "SESSION_SECRET"
  | "S3_ENDPOINT"
  | "S3_ACCESS_KEY_ID"
  | "S3_SECRET_ACCESS_KEY"
  | "PUBLIC_URL"
  | "ECOSYSTEMS"
  | "MAX_UPLOAD_BYTES"
  | "APPEND_WINDOW_HOURS"
  | "TOKEN_PREFIX"
  | "LOGIN_TOKEN_EXTENDED_TTL_HOURS"
  | "CHECK_UPDATES"
  | "R2_BUCKET_NAME";

/**
 * One row of the setup checklist: whether a setting is present, never its value, so the
 * checklist can be shown before anyone has signed in.
 */
export interface SetupItem {
  name: SetupName;
  level: SetupLevel;
  /** The variable is present and not blank. */
  set: boolean;
  /** Stored as a secret (`wrangler secret put`); otherwise a plain text variable. */
  secret: boolean;
  /** What the Worker uses while an optional setting is unset. */
  default?: string;
  /** What the setting is for, in one sentence. */
  purpose: string;
  /** What happens or how to fix it while it is missing, in one sentence. */
  howTo: string;
  /** The heading of `docs/deployment.md` that explains the setting. */
  docsAnchor: string;
}

type SetupRow = Omit<SetupItem, "set">;

const SETUP_ROWS: readonly SetupRow[] = [
  {
    name: "SESSION_SECRET",
    level: "required",
    secret: true,
    purpose: "Signs the session cookies of the panel.",
    howTo: "Nobody can sign in to the panel until it is set; API tokens keep working.",
    docsAnchor: "session_secret",
  },
  {
    name: "S3_ENDPOINT",
    level: "required",
    secret: false,
    purpose: "The R2 S3 API endpoint of the account, used to presign uploads and downloads.",
    howTo: "Publishing and downloads fail until it is set.",
    docsAnchor: "r2-api-token-s3_",
  },
  {
    name: "S3_ACCESS_KEY_ID",
    level: "required",
    secret: true,
    purpose: "The access key ID of an R2 API token, used to presign uploads and downloads.",
    howTo: "Publishing and downloads fail until it is set.",
    docsAnchor: "r2-api-token-s3_",
  },
  {
    name: "S3_SECRET_ACCESS_KEY",
    level: "required",
    secret: true,
    purpose: "The secret access key of that R2 API token.",
    howTo: "Publishing and downloads fail until it is set.",
    docsAnchor: "r2-api-token-s3_",
  },
  {
    name: "PUBLIC_URL",
    level: "recommended",
    secret: false,
    purpose:
      "The registry's address in indexes, links and snippets, and the audience of GitHub Actions OIDC tokens.",
    howTo:
      "Until it is set the address of each request is used, and GitHub Actions (OIDC) tokens are rejected.",
    docsAnchor: "public_url",
  },
  {
    name: "ECOSYSTEMS",
    level: "optional",
    secret: false,
    default: ECOS.join(","),
    purpose: "The enabled ecosystems.",
    howTo: "Unset: every ecosystem is enabled.",
    docsAnchor: "optional-variables",
  },
  {
    name: "MAX_UPLOAD_BYTES",
    level: "optional",
    secret: false,
    default: String(DEFAULT_MAX_UPLOAD_BYTES),
    purpose: "The largest accepted file of a version, in bytes.",
    howTo: "Unset: 512 MiB.",
    docsAnchor: "optional-variables",
  },
  {
    name: "APPEND_WINDOW_HOURS",
    level: "optional",
    secret: false,
    default: String(DEFAULT_APPEND_WINDOW_HOURS),
    purpose: "How long after publishing files may still be appended to a generic version.",
    howTo: "Unset: 24 hours.",
    docsAnchor: "optional-variables",
  },
  {
    name: "TOKEN_PREFIX",
    level: "optional",
    secret: false,
    default: DEFAULT_TOKEN_PREFIX,
    purpose: "A fixed prefix in front of every issued token, so leaked tokens can be found.",
    howTo: "Unset: tokens carry no prefix.",
    docsAnchor: "optional-variables",
  },
  {
    name: "LOGIN_TOKEN_EXTENDED_TTL_HOURS",
    level: "optional",
    secret: false,
    default: String(DEFAULT_LOGIN_TOKEN_EXTENDED_TTL_HOURS),
    purpose: "How long a pull token lasts when it is approved with extended validity.",
    howTo: "Unset: 24 hours (1 to 720). A pull token otherwise lasts one hour.",
    docsAnchor: "optional-variables",
  },
  {
    name: "CHECK_UPDATES",
    level: "optional",
    secret: false,
    default: String(DEFAULT_CHECK_UPDATES),
    purpose: "Whether the Settings page checks GitHub for a newer release.",
    howTo: "Unset: the check runs once a day.",
    docsAnchor: "optional-variables",
  },
  {
    name: "R2_BUCKET_NAME",
    level: "optional",
    secret: false,
    default: DEFAULT_BUCKET_NAME,
    purpose: "The bucket name in presigned URLs; it must equal the bucket of the R2 binding.",
    howTo: `Unset: ${DEFAULT_BUCKET_NAME}.`,
    docsAnchor: "optional-variables",
  },
];

/**
 * The setup checklist: every installation setting with its level and whether it is present
 * (set and not blank). Values are never read into the result.
 */
export function setupStatus(env: Pick<Env, SetupName>): SetupItem[] {
  return SETUP_ROWS.map((row) => ({ ...row, set: (env[row.name] ?? "").trim() !== "" }));
}

/** The required settings that are missing. */
export function missingRequired(items: readonly SetupItem[]): SetupItem[] {
  return items.filter((item) => item.level === "required" && !item.set);
}
