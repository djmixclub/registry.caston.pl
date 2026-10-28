import { env } from "cloudflare:workers";
import { GITHUB_ISSUER } from "../../src/core/auth";
import worker from "../../src/index";
import { ORIGIN } from "./helpers";

/**
 * GitHub Actions OIDC tokens for integration tests: a local RSA key whose public half is put
 * in the Worker's JWKS cache, so verification never reaches the network.
 */

const ALGORITHM = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};
const KID = "integration-key";

let signingKey: CryptoKey | null = null;

function base64Url(bytes: Uint8Array | ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Creates the signing key and caches its public half as GitHub's JWKS. */
export async function installGithubKey(): Promise<void> {
  const pair = (await crypto.subtle.generateKey(ALGORITHM, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const keys = [{ kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid: KID }];
  await env.AUTH.put("jwks:github", JSON.stringify({ keys, fetchedAt: Date.now() }));
}

/** A signed token for `repository` with the audience `ORIGIN`; `claims` override defaults. */
export async function githubJwt(
  repository: string,
  claims: Record<string, unknown> = {},
): Promise<string> {
  if (signingKey === null) throw new Error("installGithubKey() first");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: GITHUB_ISSUER,
    aud: ORIGIN,
    repository,
    ref: "refs/tags/v1.0.0",
    workflow_ref: `${repository}/.github/workflows/release.yml@refs/tags/v1.0.0`,
    iat: now - 10,
    nbf: now - 10,
    exp: now + 600,
    ...claims,
  };
  const input = `${encodeJson({ alg: "RS256", typ: "JWT", kid: KID })}.${encodeJson(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(signature)}`;
}

/**
 * Sends a request through the Worker with `PUBLIC_URL` set to `ORIGIN` (the audience of the
 * tokens above); the test bindings leave it unset.
 */
export function callWithPublicUrl(request: Request): Promise<Response> {
  // A test request carries no `cf` properties; the handler does not read them.
  const incoming = request as Parameters<typeof worker.fetch>[0];
  return worker.fetch(incoming, { ...env, PUBLIC_URL: ORIGIN });
}
