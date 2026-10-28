import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addSecret, createCredential, createFirstAdmin } from "../../src/core/admin";
import {
  PBKDF2_ITERATIONS,
  authEntryId,
  authenticate,
  getCredential,
  hashPassword,
  putCredential,
  sha256Hex,
  verifyPasswordHash,
} from "../../src/core/auth";
import { ValidationError } from "../../src/core/errors";
import { checkPassword } from "../../src/core/login";
import { legacy } from "../records";

// The tests of this file run in order: the first one needs an empty registry.

const NOW = new Date("2026-10-28T10:00:00Z");
const adminEnv = env;
const authEnv = env;

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

describe("first run", () => {
  it("creates the first admin with a login secret and the chosen password", async () => {
    const { credential, login } = await createFirstAdmin(adminEnv, "root", NOW, {
      password: "first.run-Pass",
    });
    expect(login).toEqual({ password: "first.run-Pass" });
    expect(credential).toMatchObject({ project: "root", kind: "admin", grants: [] });
    expect(credential.auth[0]).toMatchObject({ type: "login", totp: false, expires: null });
    const stored = await getCredential(env, "root", { fresh: true });
    expect(stored?.auth[0]?.type).toBe("login");
    expect(JSON.stringify(stored)).not.toContain("first.run-Pass");
    // The password signs in to the panel, but is not a token.
    const result = await checkPassword(
      env,
      { project: "root", password: "first.run-Pass" },
      NOW.getTime(),
      { allowAdmin: true },
    );
    expect(result).toMatchObject({ ok: true, needsCode: false });
    expect(await authenticate(request("Bearer root:first.run-Pass"), authEnv)).toBeNull();
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

  it("keeps the iteration count within the free plan's CPU budget", () => {
    // 20 000 iterations measured about 10 ms in the Workers test pool, the whole free-plan
    // budget of one request; 10 000 leaves half of it for the rest of the request. Raising the
    // constant is a deliberate decision that must come with a new measurement.
    expect(PBKDF2_ITERATIONS).toBe(10_000);
  });

  it(`verifies a password in a few milliseconds at ${PBKDF2_ITERATIONS} iterations`, async () => {
    const stored = await hashPassword("correct-horse-battery");
    await verifyPasswordHash(stored, "warm-up-password");
    // Wall-clock timing is noisy when the suite runs many files in parallel, so take the
    // fastest of several runs and only guard against a regression of an order of magnitude
    // (about 5 ms measured in the test pool).
    let fastest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 7; i++) {
      const started = performance.now();
      await verifyPasswordHash(stored, "correct-horse-battery");
      fastest = Math.min(fastest, performance.now() - started);
    }
    expect(fastest).toBeLessThan(40);
  });
});

describe("passwords of login secrets", () => {
  it("lets an admin credential have a login and checks it only where admins may sign in", async () => {
    const created = await createCredential(
      adminEnv,
      {
        project: "pw-admin",
        kind: "admin",
        secret: { type: "login", password: "my.pass.word.long", totp: true },
      },
      NOW,
    );
    expect(created.token).toBeUndefined();
    expect(created.login?.password).toBe("my.pass.word.long");
    expect(created.login?.totp?.secret).toMatch(/^[A-Z2-7]{32}$/);
    const input = { project: "pw-admin", password: "my.pass.word.long" };
    // The panel lets admins in; the approval page for the command line does not.
    expect(await checkPassword(env, input, NOW.getTime(), { allowAdmin: true })).toMatchObject({
      ok: true,
      needsCode: true,
    });
    expect(await checkPassword(env, input, NOW.getTime())).toEqual({ ok: false });
    expect(
      await checkPassword(env, { ...input, password: "my.pass.word.lonG" }, NOW.getTime(), {
        allowAdmin: true,
      }),
    ).toEqual({ ok: false });
  });

  it("accepts any script and adds a login next to a generated key", async () => {
    await createCredential(adminEnv, { project: "pw-second", kind: "admin" }, NOW);
    const password = "café-✓-über-secret";
    const added = await addSecret(adminEnv, "pw-second", { type: "login", password }, NOW);
    expect(added.token).toBeUndefined();
    expect(added.login?.password).toBe(password);
    const stored = await getCredential(env, "pw-second", { fresh: true });
    expect(stored?.auth.map((e) => e.type)).toEqual(["key", "login"]);
    const result = await checkPassword(env, { project: "pw-second", password }, NOW.getTime(), {
      allowAdmin: true,
    });
    const entry = stored?.auth[1];
    expect(entry).toBeDefined();
    if (entry !== undefined && result.ok) expect(result.entryId).toBe(await authEntryId(entry));
  });

  it("refuses passwords outside the rules", async () => {
    await createCredential(adminEnv, { project: "pw-rules", kind: "admin" }, NOW);
    const add = (password: unknown) =>
      code(addSecret(adminEnv, "pw-rules", { type: "login", password }, NOW));
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

  it("never lets a key be a password, for any kind of credential", async () => {
    for (const kind of ["read", "publish", "admin"] as const) {
      const body = {
        project: `pw-key-${kind}`,
        kind,
        secret: { type: "key", password: "long-enough-pass" },
      };
      const err = await createCredential(adminEnv, body, NOW).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "invalid_request" });
      expect((err as Error).message).toContain("`login`");
      await createCredential(adminEnv, { project: `pw-key-${kind}`, kind }, NOW);
      expect(
        await code(
          addSecret(adminEnv, `pw-key-${kind}`, { type: "key", password: "long-enough-pass" }, NOW),
        ),
      ).toBe("invalid_request");
    }
  });

  it("still verifies an admin password stored as a key by an older version", async () => {
    await putCredential(
      env,
      legacy({
        project: "pw-legacy",
        kind: "admin",
        auth: [
          {
            type: "key",
            hash: await hashPassword("my.pass.word.long"),
            created: "2026-01-01",
            expires: null,
          },
        ],
        grants: [],
      }),
    );
    for (const header of [
      "Bearer pw-legacy:my.pass.word.long",
      "Bearer pw-legacy:key.my.pass.word.long",
      basic("pw-legacy:my.pass.word.long"),
      basic("pw-legacy:pw-legacy:my.pass.word.long"),
      "pw-legacy:my.pass.word.long",
    ]) {
      expect((await authenticate(request(header), authEnv))?.identity.project).toBe("pw-legacy");
    }
    for (const header of [
      "Bearer pw-legacy:my.pass.word.lonG",
      "Bearer pw-legacy:my.pass.word",
      basic("pw-legacy:"),
    ]) {
      expect(await authenticate(request(header), authEnv)).toBeNull();
    }
  });
});
