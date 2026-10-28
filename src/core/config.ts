/**
 * Installation configuration read from Worker variables and secrets (see "Deployment,
 * configuration and updates" in docs/spec.md). Nothing installation-specific is committed, so
 * every value here comes from the Cloudflare dashboard or `wrangler secret put`.
 */

import type { Env } from "../env";
import { ValidationError } from "./errors";

/** Bucket name used when `R2_BUCKET_NAME` is empty (the `bucket_name` in `wrangler.jsonc`). */
export const DEFAULT_BUCKET_NAME = "serverless-registry";

/** `MAX_UPLOAD_BYTES` used when the variable is missing or invalid (512 MiB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 536870912;

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
