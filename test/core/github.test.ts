import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors";
import { lookupRepository } from "../../src/core/github";
import { VERSION } from "../../src/version";

function fake(respond: () => Response | Promise<Response>) {
  const calls: { url: string; headers: Headers }[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return respond();
  };
  return { fetch: fetcher as typeof fetch, calls };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (err) {
    return err instanceof ValidationError ? err.code : "other";
  }
}

const REPO = { full_name: "acme/sdk", id: 123456789, owner: { id: 42, login: "acme" } };

describe("lookupRepository", () => {
  it("returns the full name and the ids as strings of digits", async () => {
    const f = fake(() => Response.json(REPO));
    expect(await lookupRepository("acme/sdk", f.fetch)).toEqual({
      fullName: "acme/sdk",
      id: "123456789",
      ownerId: "42",
    });
    expect(f.calls[0]?.url).toBe("https://api.github.com/repos/acme/sdk");
    expect(f.calls[0]?.headers.get("user-agent")).toBe(`serverless-registry/${VERSION}`);
    expect(f.calls[0]?.headers.get("accept")).toBe("application/vnd.github+json");
  });

  it("rejects malformed names without asking GitHub", async () => {
    const f = fake(() => Response.json(REPO));
    for (const name of ["", "acme", "acme/*", "acme/sdk/x", "../x", "acme/..", "a b/c"]) {
      expect(await code(lookupRepository(name, f.fetch))).toBe("invalid_request");
    }
    expect(f.calls).toHaveLength(0);
  });

  it("answers not_found when GitHub answers 404", async () => {
    const f = fake(() => new Response("{}", { status: 404 }));
    expect(await code(lookupRepository("acme/private", f.fetch))).toBe("not_found");
  });

  it("answers provider_unavailable on other failures", async () => {
    const cases = [
      () => new Response("limited", { status: 403 }),
      () => new Response("down", { status: 502 }),
      () => new Response("not json"),
      () => Response.json({ full_name: "acme/sdk", id: "1", owner: { id: 2 } }),
      () => {
        throw new TypeError("network");
      },
    ];
    for (const respond of cases) {
      expect(await code(lookupRepository("acme/sdk", fake(respond).fetch))).toBe(
        "provider_unavailable",
      );
    }
  });
});
