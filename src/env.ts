/** Bindings, variables and secrets available to the Worker. */
export interface Env {
  /** Credentials, panel sessions and `schema_version`. */
  AUTH: KVNamespace;
  /** Archives, version manifests and generated indexes. */
  R2_BUCKET: R2Bucket;
  /** Workers Static Assets (`./public`). */
  ASSETS: Fetcher;

  /** Full public address of the registry, e.g. `https://packages.example.com`. */
  PUBLIC_URL?: string;
  /** R2 S3 API access key ID used for presigning (secret). */
  S3_ACCESS_KEY_ID?: string;
  /** R2 S3 API secret access key used for presigning (secret). */
  S3_SECRET_ACCESS_KEY?: string;
  /** R2 S3 API endpoint, `https://<account>.r2.cloudflarestorage.com`. */
  S3_ENDPOINT?: string;

  /** Name of the R2 bucket bound as `R2_BUCKET`, used in presigned S3 URLs. */
  R2_BUCKET_NAME: string;

  /** Maximum accepted archive size in bytes, as a decimal string. */
  MAX_UPLOAD_BYTES: string;
  /** `"true"` to compare the running version with the latest GitHub release. */
  CHECK_UPDATES: string;
  /** Optional fixed prefix of issued tokens; empty to disable. */
  TOKEN_PREFIX: string;
  /** External credential providers (reserved, not implemented yet). */
  AUTH_PROVIDERS?: string;
}
