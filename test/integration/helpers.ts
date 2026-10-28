import { env, exports } from "cloudflare:workers";
import { generateSecret, hashSecret, putCredential, type Kind } from "../../src/core/auth";
import type { Grant } from "../../src/core/grants";
import { stagingKey } from "../../src/core/storage";

export const ORIGIN = "https://registry.test";

export interface CallOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Sends a request through the Worker's `fetch` handler. */
export function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["content-type"] ??= "application/json";
  }
  return exports.default.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body, redirect: "manual" }),
  );
}

/** Stores a credential with one `key` secret directly in KV and returns its token. */
export async function credential(
  project: string,
  kind: Kind,
  grants: Grant[] = [],
): Promise<string> {
  const secret = generateSecret();
  await putCredential(env, {
    project,
    kind,
    auth: [
      {
        type: "key",
        hash: await hashSecret(secret),
        created: "2026-01-01T00:00:00Z",
        expires: null,
      },
    ],
    grants: kind === "admin" ? [] : grants,
  });
  return `${project}:${secret}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface InitResult {
  uploadId: string;
  expires: string;
  uploads: { name: string; putUrl: string; headers: Record<string, string> }[];
}

/**
 * Publishes a composer version the way the CLI does: init, the presigned PUT (simulated by
 * writing the declared bytes to the staging key, as R2 would), then commit.
 */
export async function publishComposer(
  token: string,
  name: string,
  version: string,
  content = `${name}@${version}`,
): Promise<Response> {
  const bytes = new TextEncoder().encode(content);
  const sha = await sha256Hex(bytes);
  const file = `${name.replace("/", "-")}-${version}.zip`;
  const init = await call("POST", "/api/v1/publish/init", {
    token,
    body: {
      eco: "composer",
      name,
      version,
      files: [{ name: file, size: bytes.length, sha256: sha }],
      manifest: { name, description: `The ${name} library`, require: { php: "^8.1" } },
    },
  });
  if (init.status !== 200) return init;
  const { uploadId } = await init.json<InitResult>();
  await env.R2_BUCKET.put(stagingKey(uploadId, file), bytes, { sha256: sha });
  return call("POST", "/api/v1/publish/commit", { token, body: { uploadId } });
}

export interface ErrorBody {
  error: string;
  message: string;
}
