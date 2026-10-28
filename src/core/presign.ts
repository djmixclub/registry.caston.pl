/**
 * Dependency-free AWS Signature Version 4 query-string presigning (WebCrypto HMAC-SHA256),
 * used for R2's S3 API: uploads go to a presigned `PUT`, downloads redirect to a presigned
 * `GET`, so archive bytes never pass through the Worker.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** R2 accepts any region name; `auto` is the documented one. */
export const R2_REGION = "auto";
export const S3_SERVICE = "s3";

/** Default lifetime of a presigned upload (10 minutes). */
export const PUT_EXPIRES_SECONDS = 600;
/** Default lifetime of a presigned download (15 minutes). */
export const GET_EXPIRES_SECONDS = 900;

const encoder = new TextEncoder();

/**
 * URI-encodes a string per SigV4: every byte except the unreserved characters
 * `A-Z a-z 0-9 - _ . ~` is percent-encoded with upper-case hex; `/` is kept when `keepSlash`.
 */
export function uriEncode(value: string, keepSlash = false): string {
  let out = "";
  for (const byte of encoder.encode(value)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === "/")) out += ch;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}

/** Converts a 64-hex SHA-256 digest to the base64 form of `x-amz-checksum-sha256`. */
export function sha256HexToBase64(hex: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new TypeError("Invalid SHA-256 digest.");
  let binary = "";
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(binary);
}

/** `YYYYMMDDTHHMMSSZ` of a date. */
export function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** Input of {@link presignUrl}. */
export interface SigV4Params {
  method: string;
  /** Scheme and authority, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  origin: string;
  /** Path as it appears in the URL, already URI-encoded (`/bucket/key`). */
  path: string;
  /** Extra query parameters that are signed (not URI-encoded). */
  query?: Record<string, string>;
  /** Extra signed headers besides `host` (names in any case). */
  headers?: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  expiresSeconds: number;
  now: Date;
}

/** The intermediate values of a signature, exposed for tests. */
export interface SigV4Result {
  url: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** Signs a request with SigV4 query-string authentication (`X-Amz-*` query parameters). */
export async function presignUrl(p: SigV4Params): Promise<SigV4Result> {
  if (!Number.isInteger(p.expiresSeconds) || p.expiresSeconds < 1 || p.expiresSeconds > 604800) {
    throw new RangeError("expiresSeconds must be between 1 and 604800.");
  }
  const origin = new URL(p.origin);
  const datetime = amzDate(p.now);
  const date = datetime.slice(0, 8);
  const scope = `${date}/${p.region}/${p.service}/aws4_request`;

  const headers: Record<string, string> = { host: origin.host };
  for (const [name, value] of Object.entries(p.headers ?? {})) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");

  const query: Record<string, string> = {
    ...p.query,
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${p.accessKeyId}/${scope}`,
    "X-Amz-Date": datetime,
    "X-Amz-Expires": String(p.expiresSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const queryString = canonicalQuery(query);

  const canonicalRequest = [
    p.method.toUpperCase(),
    p.path,
    queryString,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join("\n");
  const stringToSign = [ALGORITHM, datetime, scope, await sha256Hex(canonicalRequest)].join("\n");

  let key = await hmac(encoder.encode(`AWS4${p.secretAccessKey}`), date);
  for (const part of [p.region, p.service, "aws4_request"]) key = await hmac(key, part);
  const signature = toHex(await hmac(key, stringToSign));

  const url = `${origin.protocol}//${origin.host}${p.path}?${queryString}&X-Amz-Signature=${signature}`;
  return { url, canonicalRequest, stringToSign, signature };
}

/** Where and as whom to presign: the R2 S3 endpoint, bucket and API key. */
export interface PresignTarget {
  /** `https://<account>.r2.cloudflarestorage.com` (a trailing slash is ignored). */
  endpoint: string;
  bucket: string;
  /** Object key, not encoded. */
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Defaults to `auto` (R2). */
  region?: string;
  /** Defaults to `s3`. */
  service?: string;
  /** Defaults to the current time. */
  now?: Date;
}

function targetOf(t: PresignTarget): { origin: string; path: string } {
  const endpoint = new URL(t.endpoint);
  const base = endpoint.pathname.replace(/\/+$/, "");
  return {
    origin: endpoint.origin,
    path: `${base}/${uriEncode(t.bucket)}/${uriEncode(t.key, true)}`,
  };
}

export interface PresignPutParams extends PresignTarget {
  /** Exact size of the body in bytes. */
  contentLength: number;
  /** Base64 of the SHA-256 digest of the body. */
  sha256Base64: string;
  expiresSeconds?: number;
}

export interface PresignedPut {
  url: string;
  /** Exactly the headers the uploader must send (besides `Host`). */
  headers: { "content-length": string; "x-amz-checksum-sha256": string };
  expires: Date;
}

/**
 * Presigns a path-style `PUT <endpoint>/<bucket>/<key>` whose signature covers `host`,
 * `content-length` and `x-amz-checksum-sha256`, so only the declared bytes can be uploaded.
 */
export async function presignPut(p: PresignPutParams): Promise<PresignedPut> {
  if (!Number.isSafeInteger(p.contentLength) || p.contentLength < 0) {
    throw new RangeError("contentLength must be a non-negative integer.");
  }
  const now = p.now ?? new Date();
  const expiresSeconds = p.expiresSeconds ?? PUT_EXPIRES_SECONDS;
  const headers = {
    "content-length": String(p.contentLength),
    "x-amz-checksum-sha256": p.sha256Base64,
  };
  const { url } = await presignUrl({
    method: "PUT",
    ...targetOf(p),
    query: { "X-Amz-Content-Sha256": UNSIGNED_PAYLOAD },
    headers,
    accessKeyId: p.accessKeyId,
    secretAccessKey: p.secretAccessKey,
    region: p.region ?? R2_REGION,
    service: p.service ?? S3_SERVICE,
    expiresSeconds,
    now,
  });
  return { url, headers, expires: new Date(now.getTime() + expiresSeconds * 1000) };
}

export interface PresignGetParams extends PresignTarget {
  expiresSeconds?: number;
  /** Signed `response-content-disposition` override, e.g. `attachment; filename="a.zip"`. */
  responseContentDisposition?: string;
}

export interface PresignedGet {
  url: string;
  expires: Date;
}

/** Presigns a path-style `GET <endpoint>/<bucket>/<key>` (signed header: `host`). */
export async function presignGet(p: PresignGetParams): Promise<PresignedGet> {
  const now = p.now ?? new Date();
  const expiresSeconds = p.expiresSeconds ?? GET_EXPIRES_SECONDS;
  const query: Record<string, string> = {};
  if (p.responseContentDisposition !== undefined) {
    query["response-content-disposition"] = p.responseContentDisposition;
  }
  const { url } = await presignUrl({
    method: "GET",
    ...targetOf(p),
    query,
    accessKeyId: p.accessKeyId,
    secretAccessKey: p.secretAccessKey,
    region: p.region ?? R2_REGION,
    service: p.service ?? S3_SERVICE,
    expiresSeconds,
    now,
  });
  return { url, expires: new Date(now.getTime() + expiresSeconds * 1000) };
}
