import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addSecret, createCredential, createFirstAdmin } from "../../src/core/admin";
import {
  PBKDF2_ITERATIONS,
  PBKDF2_PREFIX,
  authEntryId,
  authenticate,
  getCredential,
  hashPassword,
  sha256Hex,
  verifyPasswordHash,
} from "../../src/core/auth";
import { ValidationError } from "../../src/core/errors";

// The tests of this file run in order: the first one needs an empty registry.

const NOW = new Date("2026-10-28T10:00:00Z");
const adminEnv = { AUTH: env.AUTH, TOKEN_PREFIX: "" };
const authEnv = { AUTH: env.AUTH, PUBLIC_URL: "https://registry.test", TOKEN_PREFIX: "" };

function request(authorization: string): Request {
  return new Request("https://registry.test/api/v1/whoami", { headers: { authorization } });
}

function basic(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ValidationError) return err.code;
    throw err;
  }
  return "ok";
}

describe("first run with a password", () => {
  it("creates the first admin with the chosen password", async () => {
    const { credential, token } = await createFirstAdmin(adminEnv, "root", NOW, "first.run-Pass");
    expect(token).toBe("root:first.run-Pass");
    expect(credential.auth[0]).toMatchObject({ type: "key", expires: null });
    const stored = await getCredential(env, "root", { fresh: true });
    const entry = stored?.auth[0];
    expect(entry?.type === "key" && entry.hash.startsWith(PBKDF2_PREFIX)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("first.run-Pass");
    const auth = await authenticate(request("Bearer root:first.run-Pass"), authEnv);
    expect(auth?.identity).toMatchObject({ project: "root", kind: "admin" });
  });
});

describe("password hashes", () => {
  it("stores pbkdf2-sha256 with the iteration count, a random salt and the hash", async () => {
    const stored = await hashPassword("correct-horse-battery");
    const [algorithm, iterations, salt = "", hash = ""] = stored.split("$");
    expect(algorithm).toBe("pbkdf2-sha256");
    expect(Number(iterations)).toBe(PBKDF2_ITERATIONS);
    expect(atob(salt)).toHaveLength(16);
    expect(atob(hash)).toHaveLength(32);
    expect(await hashPassword("correct-horse-battery")).not.toBe(stored);
    expect(await verifyPasswordHash(stored, "correct-horse-battery")).toBe(true);
    expect(await verifyPasswordHash(stored, "correct-horse-batterY")).toBe(false);
  });

  it("verifies with the stored iteration count and rejects malformed hashes", async () => {
    const cheap = await hashPassword("correct-horse-battery", 1000);
    expect(cheap.split("$")[1]).toBe("1000");
    expect(await verifyPasswordHash(cheap, "correct-horse-battery")).toBe(true);
    for (const bad of [
      "pbkdf2-sha256$0$AAAA$AAAA",
      "pbkdf2-sha256$99999999$AAAA$AAAA",
      "pbkdf2-sha256$x$AAAA$AAAA",
      "pbkdf2-sha256$1000$!!$AAAA",
      `${cheap}$extra`,
      "sha256:abc",
    ]) {
      expect(await verifyPasswordHash(bad, "correct-horse-battery")).toBe(false);
    }
  });

  it("derives the id from the SHA-256 of the stored string", async () => {
    const hash = await hashPassword("correct-horse-battery", 1000);
    const entry = { type: "key" as const, hash, created: "2026-10-28", expires: null };
    expect(await authEntryId(entry)).toBe((await sha256Hex(hash)).slice(0, 12));
  });

  it(`stays well inside the free plan's 10 ms of CPU at ${PBKDF2_ITERATIONS} iterations`, async () => {
    const stored = await hashPassword("correct-horse-battery");
    await verifyPasswordHash(stored, "warm-up-password");
    const runs = 5;
    const started = performance.now();
    for (let i = 0; i < runs; i++) await verifyPasswordHash(stored, "correct-horse-battery");
    const perVerification = (performance.now() - started) / runs;
    // Measured at about 5 ms in the test pool; the bound leaves room for slower machines.
    expect(perVerification).toBeLessThan(9);
  });
});

describe("admin passwords", () => {
  it("accepts a password for admin credentials and answers the token once", async () => {
    const created = await createCredential(
      adminEnv,
      {
        project: "pw-admin",
        kind: "admin",
        secret: { type: "key", password: "my.pass.word.long" },
      },
      NOW,
    );
    expect(created.token).toBe("pw-admin:my.pass.word.long");

    for (const header of [
      "Bearer pw-admin:my.pass.word.long",
      "Bearer pw-admin:key.my.pass.word.long",
      basic("pw-admin:my.pass.word.long"),
      basic("pw-admin:pw-admin:my.pass.word.long"),
      "pw-admin:my.pass.word.long",
    ]) {
      expect((await authenticate(request(header), authEnv))?.identity.project).toBe("pw-admin");
    }
    for (const header of [
      "Bearer pw-admin:my.pass.word.lonG",
      "Bearer pw-admin:my.pass.word",
      basic("pw-admin:"),
    ]) {
      expect(await authenticate(request(header), authEnv)).toBeNull();
    }
  });

  it("adds a password secret next to a generated one and supports any script", async () => {
    await createCredential(adminEnv, { project: "pw-second", kind: "admin" }, NOW);
    const password = "café-✓-über-secret";
    const added = await addSecret(adminEnv, "pw-second", { type: "key", password }, NOW);
    expect(added.token).toBe(`pw-second:${password}`);
    const stored = await getCredential(env, "pw-second", { fresh: true });
    expect(stored?.auth).toHaveLength(2);
    const auth = await authenticate(request(basic(`pw-second:${password}`)), authEnv);
    expect(auth?.identity.project).toBe("pw-second");
    const entry = stored?.auth[1];
    expect(entry).toBeDefined();
    if (entry !== undefined) expect(auth?.identity.entryId).toBe(await authEntryId(entry));
  });

  it("refuses passwords outside the rules", async () => {
    await createCredential(adminEnv, { project: "pw-rules", kind: "admin" }, NOW);
    const add = (password: unknown) =>
      code(addSecret(adminEnv, "pw-rules", { type: "key", password }, NOW));
    expect(await add("short-pass1")).toBe("invalid_request");
    expect(await add("x".repeat(129))).toBe("invalid_request");
    expect(await add("with:colon-password")).toBe("invalid_request");
    expect(await add("with space password")).toBe("invalid_request");
    expect(await add("tab\tseparated-password")).toBe("invalid_request");
    expect(await add(123456789012)).toBe("invalid_request");
    expect(await add("x".repeat(128))).toBe("ok");
    expect(await add("✓".repeat(12))).toBe("ok");
    expect(
      await code(
        addSecret(adminEnv, "pw-rules", { type: "gh", repository: "a/b", password: "p" }, NOW),
      ),
    ).toBe("invalid_request");
  });

  it("refuses passwords for read and publish credentials", async () => {
    for (const kind of ["read", "publish"] as const) {
      const body = {
        project: `pw-${kind}`,
        kind,
        secret: { type: "key", password: "long-enough-pass" },
      };
      const err = await createCredential(adminEnv, body, NOW).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: "invalid_request",
        message: "only admin credentials may use a password",
      });
      await createCredential(adminEnv, { project: `pw-${kind}`, kind }, NOW);
      expect(
        await code(
          addSecret(adminEnv, `pw-${kind}`, { type: "key", password: "long-enough-pass" }, NOW),
        ),
      ).toBe("invalid_request");
    }
  });
});
