import { describe, expect, it } from "vitest";
import {
  amzDate,
  presignGet,
  presignPut,
  presignUrl,
  sha256HexToBase64,
  uriEncode,
} from "../../src/core/presign";

// AWS documentation example "Authenticating Requests: Using Query Parameters (AWS Signature
// Version 4)", GET /test.txt presigned for 24 hours.
const AWS_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const AWS_NOW = new Date("2013-05-24T00:00:00Z");
const AWS_SIGNATURE = "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404";

const NOW = new Date("2026-10-28T10:12:00Z");
const R2 = {
  endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
  bucket: "serverless-registry",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
};
const SHA256_HEX = "9f2c4e0a1b3d5f7092a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8";

// An independent, deliberately literal SigV4 implementation used to check the module.
const enc = new TextEncoder();
const hex = (b: ArrayBuffer): string =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
async function hmacRaw(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}
async function referenceSignature(
  secret: string,
  date: string,
  region: string,
  stringToSign: string,
): Promise<string> {
  const kDate = await hmacRaw(enc.encode("AWS4" + secret), date);
  const kRegion = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, "s3");
  const kSigning = await hmacRaw(kService, "aws4_request");
  return hex(await hmacRaw(kSigning, stringToSign));
}
async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

describe("uriEncode", () => {
  it("keeps unreserved characters", () => {
    expect(uriEncode("AZaz09-_.~")).toBe("AZaz09-_.~");
  });

  it("encodes reserved characters with upper-case hex", () => {
    expect(uriEncode("a b+c=d&e@f:g!h*i'j(k)l$")).toBe(
      "a%20b%2Bc%3Dd%26e%40f%3Ag%21h%2Ai%27j%28k%29l%24",
    );
  });

  it("encodes UTF-8 bytes", () => {
    expect(uriEncode("café-π-€")).toBe("caf%C3%A9-%CF%80-%E2%82%AC");
  });

  it("keeps slashes only when asked", () => {
    expect(uriEncode("a/b")).toBe("a%2Fb");
    expect(uriEncode("a/b", true)).toBe("a/b");
  });
});

describe("helpers", () => {
  it("formats amz dates", () => {
    expect(amzDate(new Date("2013-05-24T00:00:00.123Z"))).toBe("20130524T000000Z");
  });

  it("converts a hex digest to base64", () => {
    expect(sha256HexToBase64(SHA256_HEX)).toBe("nyxOChs9X3CSpMbosNL0psjgstT2qMDitNb4oMLkttg=");
    expect(() => sha256HexToBase64("abc")).toThrow(TypeError);
  });
});

describe("presignUrl", () => {
  it("matches the AWS documented example", async () => {
    const result = await presignUrl({
      method: "GET",
      origin: "https://examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      accessKeyId: AWS_ACCESS_KEY,
      secretAccessKey: AWS_SECRET,
      region: "us-east-1",
      service: "s3",
      expiresSeconds: 86400,
      now: AWS_NOW,
    });

    const canonicalRequest = [
      "GET",
      "/test.txt",
      "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host",
      "host:examplebucket.s3.amazonaws.com",
      "",
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    expect(result.canonicalRequest).toBe(canonicalRequest);

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      "20130524T000000Z",
      "20130524/us-east-1/s3/aws4_request",
      await sha256(canonicalRequest),
    ].join("\n");
    expect(result.stringToSign).toBe(stringToSign);
    expect(await referenceSignature(AWS_SECRET, "20130524", "us-east-1", stringToSign)).toBe(
      AWS_SIGNATURE,
    );

    expect(result.signature).toBe(AWS_SIGNATURE);
    expect(result.url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=" +
        AWS_SIGNATURE,
    );
  });

  it.each([0, 604801, 1.5])("rejects expiresSeconds %j", async (expiresSeconds) => {
    await expect(
      presignUrl({
        method: "GET",
        origin: "https://example.com",
        path: "/a",
        accessKeyId: "a",
        secretAccessKey: "b",
        region: "auto",
        service: "s3",
        expiresSeconds,
        now: NOW,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("presignPut", () => {
  const base64 = sha256HexToBase64(SHA256_HEX);

  it("signs host, content-length and the checksum header", async () => {
    const put = await presignPut({
      ...R2,
      key: "_staging/01JBX9T6Q4ZK3M8N2P5R7S9V0W/sdk-2.3.1.tgz",
      contentLength: 48213,
      sha256Base64: base64,
      now: NOW,
    });

    expect(put.headers).toEqual({ "content-length": "48213", "x-amz-checksum-sha256": base64 });
    expect(put.expires.toISOString()).toBe("2026-10-28T10:22:00.000Z");

    const url = new URL(put.url);
    expect(url.origin).toBe(R2.endpoint);
    expect(url.pathname).toBe(
      "/serverless-registry/_staging/01JBX9T6Q4ZK3M8N2P5R7S9V0W/sdk-2.3.1.tgz",
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;host;x-amz-checksum-sha256",
    );
    expect(put.url).toContain("X-Amz-SignedHeaders=content-length%3Bhost%3Bx-amz-checksum-sha256");
    expect(url.searchParams.get("X-Amz-Content-Sha256")).toBe("UNSIGNED-PAYLOAD");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "test-access-key/20261028/auto/s3/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");

    // Recompute the signature independently from the literal canonical request.
    const query = put.url.slice(put.url.indexOf("?") + 1).replace(/&X-Amz-Signature=.*$/, "");
    const canonicalRequest = [
      "PUT",
      "/serverless-registry/_staging/01JBX9T6Q4ZK3M8N2P5R7S9V0W/sdk-2.3.1.tgz",
      "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=test-access-key%2F20261028%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261028T101200Z&X-Amz-Expires=600&X-Amz-SignedHeaders=content-length%3Bhost%3Bx-amz-checksum-sha256",
      "content-length:48213",
      "host:0123456789abcdef.r2.cloudflarestorage.com",
      `x-amz-checksum-sha256:${base64}`,
      "",
      "content-length;host;x-amz-checksum-sha256",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    expect(query).toBe(canonicalRequest.split("\n")[2]);
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      "20261028T101200Z",
      "20261028/auto/s3/aws4_request",
      await sha256(canonicalRequest),
    ].join("\n");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      await referenceSignature(R2.secretAccessKey, "20261028", "auto", stringToSign),
    );
  });

  it("encodes package keys segment by segment", async () => {
    const put = await presignPut({
      ...R2,
      endpoint: R2.endpoint + "/",
      key: "npm/pkg/@acme__sdk/2.3.1+build.1/sdk 2.3.1.tgz",
      contentLength: 1,
      sha256Base64: base64,
      now: NOW,
    });
    expect(put.url).toContain(
      "/serverless-registry/npm/pkg/%40acme__sdk/2.3.1%2Bbuild.1/sdk%202.3.1.tgz?",
    );
  });

  it("honours a custom lifetime and region", async () => {
    const put = await presignPut({
      ...R2,
      key: "a",
      contentLength: 0,
      sha256Base64: base64,
      expiresSeconds: 60,
      region: "us-east-1",
      now: NOW,
    });
    expect(new URL(put.url).searchParams.get("X-Amz-Credential")).toContain("/us-east-1/s3/");
    expect(put.expires.getTime() - NOW.getTime()).toBe(60_000);
  });

  it("rejects an invalid content length", async () => {
    await expect(
      presignPut({ ...R2, key: "a", contentLength: -1, sha256Base64: base64, now: NOW }),
    ).rejects.toThrow(RangeError);
  });
});

describe("presignGet", () => {
  it("signs only host and defaults to 15 minutes", async () => {
    const get = await presignGet({ ...R2, key: "composer/pkg/acme__sdk/1.2.0/sdk.zip", now: NOW });
    const url = new URL(get.url);
    expect(url.pathname).toBe("/serverless-registry/composer/pkg/acme__sdk/1.2.0/sdk.zip");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.has("X-Amz-Content-Sha256")).toBe(false);
    expect(get.expires.toISOString()).toBe("2026-10-28T10:27:00.000Z");

    const query = get.url.slice(get.url.indexOf("?") + 1).replace(/&X-Amz-Signature=.*$/, "");
    const canonicalRequest = [
      "GET",
      "/serverless-registry/composer/pkg/acme__sdk/1.2.0/sdk.zip",
      query,
      "host:0123456789abcdef.r2.cloudflarestorage.com",
      "",
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      "20261028T101200Z",
      "20261028/auto/s3/aws4_request",
      await sha256(canonicalRequest),
    ].join("\n");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      await referenceSignature(R2.secretAccessKey, "20261028", "auto", stringToSign),
    );
  });

  it("signs a response-content-disposition override", async () => {
    const get = await presignGet({
      ...R2,
      key: "a.zip",
      responseContentDisposition: 'attachment; filename="a.zip"',
      now: NOW,
    });
    expect(get.url).toContain(
      "response-content-disposition=attachment%3B%20filename%3D%22a.zip%22&X-Amz-Signature=",
    );
    expect(new URL(get.url).searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="a.zip"',
    );
  });
});
