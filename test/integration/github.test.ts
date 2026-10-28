import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { handleApi } from "../../src/api";
import { credential, ORIGIN } from "./helpers";

let admin: string;
let reader: string;

const github = (async (input: RequestInfo | URL) => {
  if (String(input).endsWith("/repos/acme/sdk")) {
    return Response.json({ full_name: "acme/sdk", id: 1001, owner: { id: 7 } });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

function lookup(name: string, token: string): Promise<Response> {
  const url = new URL(`${ORIGIN}/api/v1/github/repository?name=${encodeURIComponent(name)}`);
  const request = new Request(url, { headers: { authorization: `Bearer ${token}` } });
  return handleApi(request, env, url, new Date(), github);
}

beforeAll(async () => {
  admin = await credential("github-admin", "admin");
  reader = await credential("github-reader", "read");
});

describe("GET /api/v1/github/repository", () => {
  it("returns the repository ids to admins", async () => {
    const res = await lookup("acme/sdk", admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fullName: "acme/sdk", id: "1001", ownerId: "7" });
  });

  it("answers 404 for unknown or private repositories and 400 for bad names", async () => {
    expect((await lookup("acme/missing", admin)).status).toBe(404);
    expect((await lookup("acme/*", admin)).status).toBe(400);
  });

  it("is admin only", async () => {
    expect((await lookup("acme/sdk", reader)).status).toBe(403);
  });
});
