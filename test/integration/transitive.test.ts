import { beforeAll, describe, expect, it } from "vitest";
import { expand } from "../../src/adapters/composer/index";
import { call, credential, publishComposer } from "./helpers";

interface P2 {
  packages: Record<string, Record<string, unknown>[]>;
}

let admin: string;
let ci: string;
let reader: string;

async function p2(name: string, token: string): Promise<number | string[]> {
  const res = await call("GET", `/composer/p2/${name}.json`, { token });
  if (res.status !== 200) return res.status;
  const body = await res.json<P2>();
  return expand(body.packages[name] ?? []).map((v) => String(v.version));
}

async function available(token: string): Promise<string[]> {
  const res = await call("GET", "/composer/packages.json", { token });
  expect(res.status).toBe(200);
  return (await res.json<{ "available-packages": string[] }>())["available-packages"];
}

async function dist(name: string, version: string, token: string): Promise<number> {
  return (await call("GET", `/composer/dist/${name}/${version}.zip`, { token })).status;
}

beforeAll(async () => {
  admin = await credential("transitive-admin", "admin");
  ci = await credential("transitive-ci", "publish", [
    { eco: "composer", package: "acme/*", versions: "*" },
  ]);
  reader = await credential("transitive-reader", "read", [
    { eco: "composer", package: "acme/a", versions: "*" },
  ]);
  const versions: [string, string, Record<string, unknown>][] = [
    ["acme/a", "1.0.0", { require: { php: "^8.1", "acme/b": "^1.1" } }],
    ["acme/b", "1.0.0", {}],
    ["acme/b", "1.1.0", {}],
    ["acme/b", "1.4.0", { require: { php: "^8.1", "acme/c": "^0.1" } }],
    ["acme/b", "2.0.0", { require: { "acme/c": "*" } }],
    ["acme/c", "0.1.0", {}],
    ["acme/c", "0.2.0", {}],
  ];
  for (const [name, version, manifest] of versions) {
    const res = await publishComposer(ci, name, version, `${name}@${version}`, manifest);
    expect(res.status).toBe(201);
  }
});

describe("transitive access through the native protocol", () => {
  it("lists transitively reachable packages in available-packages", async () => {
    expect(await available(reader)).toEqual(["acme/a", "acme/b", "acme/c"]);
  });

  it("serves the versions the dependency constraints admit from p2", async () => {
    expect(await p2("acme/a", reader)).toEqual(["1.0.0"]);
    expect(await p2("acme/b", reader)).toEqual(["1.4.0", "1.1.0"]);
    expect(await p2("acme/c", reader)).toEqual(["0.1.0"]);
    expect(await p2("acme/b", admin)).toEqual(["2.0.0", "1.4.0", "1.1.0", "1.0.0"]);
  });

  it("serves the dist of reachable versions only", async () => {
    expect(await dist("acme/b", "1.1.0", reader)).toBe(302);
    expect(await dist("acme/b", "1.4.0", reader)).toBe(302);
    expect(await dist("acme/c", "0.1.0", reader)).toBe(302);
    expect(await dist("acme/b", "1.0.0", reader)).toBe(404);
    expect(await dist("acme/b", "2.0.0", reader)).toBe(404);
    expect(await dist("acme/c", "0.2.0", reader)).toBe(404);
  });

  it("opens nothing for a grant with transitive false", async () => {
    const opaque = await credential("transitive-opaque", "read", [
      { eco: "composer", package: "acme/a", versions: "*", transitive: false },
    ]);
    expect(await available(opaque)).toEqual(["acme/a"]);
    expect(await p2("acme/b", opaque)).toBe(404);
    expect(await dist("acme/b", "1.4.0", opaque)).toBe(404);
  });
});
