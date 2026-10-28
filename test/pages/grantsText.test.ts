import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

interface Grant {
  eco: string;
  package: string;
  versions: string;
  transitive: boolean;
}

interface GrantText {
  parse(text: string, ecosystems: string[]): Grant[];
  format(grants: Grant[], withTransitive: boolean): string;
}

const ECOSYSTEMS = ["composer", "npm", "cargo", "generic", "nuget", "swift", "maven"];

/** The pure part of `public/grants.js`, evaluated the way a browser reads the classic script. */
async function load(): Promise<GrantText> {
  const res = await exports.default.fetch(new Request("https://registry.example/grants.js"));
  expect(res.status).toBe(200);
  const source = await res.text();
  return new Function(`${source}\nreturn GrantText;`)() as GrantText;
}

const grant = (eco: string, pkg: string, versions = "*", transitive = true): Grant => ({
  eco,
  package: pkg,
  versions,
  transitive,
});

describe("grants as text", async () => {
  const text = await load();
  const parse = (value: string) => text.parse(value, ECOSYSTEMS);

  it("reads eco:package[:versions[:transitive]] like the CLI shorthand", () => {
    expect(parse("npm:@licensing-kit/activation-client:1.2.*")).toEqual([
      grant("npm", "@licensing-kit/activation-client", "1.2.*"),
    ]);
    expect(parse("composer:acme/*")).toEqual([grant("composer", "acme/*")]);
    expect(parse("npm:@acme/sdk:^2.0:false")).toEqual([grant("npm", "@acme/sdk", "^2.0", false)]);
    expect(parse("composer:acme/*:*:true")).toEqual([grant("composer", "acme/*")]);
  });

  it("keeps colons, commas and spaces of a version constraint", () => {
    expect(parse("cargo:acme-core:>=1.4, <2")).toEqual([grant("cargo", "acme-core", ">=1.4, <2")]);
    expect(parse("npm:@acme/sdk:a:b")).toEqual([grant("npm", "@acme/sdk", "a:b")]);
    expect(parse("nuget:Acme.*:[1.0,2.0):false")).toEqual([
      grant("nuget", "Acme.*", "[1.0,2.0)", false),
    ]);
  });

  it("keeps the colon of a maven package", () => {
    expect(parse("maven:com.acme:sdk:[1.0,2.0)")).toEqual([
      grant("maven", "com.acme:sdk", "[1.0,2.0)"),
    ]);
    expect(parse("maven:com.acme:*")).toEqual([grant("maven", "com.acme:*")]);
    expect(parse("maven:com.acme:sdk:*:false")).toEqual([
      grant("maven", "com.acme:sdk", "*", false),
    ]);
  });

  it("skips empty lines and comments, and accepts CRLF and indentation", () => {
    const input = "# release keys\r\n\r\n  npm:a:1.0  \r\n  # off\r\ncargo:b\n";
    expect(parse(input)).toEqual([grant("npm", "a", "1.0"), grant("cargo", "b")]);
    expect(parse("")).toEqual([]);
  });

  it("names the line and the problem of an invalid grant", () => {
    expect(() => parse("npm:a\nfoo")).toThrow("line 2: expected eco:package");
    expect(() => parse("\nrubygems:a")).toThrow("line 2: unknown ecosystem rubygems");
    expect(() => parse("npm:")).toThrow("line 1: missing package");
    expect(() => parse("maven:com.acme")).not.toThrow();
    expect(() => parse("npm: :1.0")).toThrow("line 1: missing package");
  });

  it("writes one line per grant, with the versions always and :false only when set", () => {
    const grants = [
      grant("npm", "@licensing-kit/activation-client", "1.2.*"),
      grant("composer", "acme/*"),
      grant("npm", "@acme/sdk", "*", false),
      grant("maven", "com.acme:sdk", "[1.0,2.0)", false),
    ];
    expect(text.format(grants, true)).toBe(
      [
        "npm:@licensing-kit/activation-client:1.2.*",
        "composer:acme/*:*",
        "npm:@acme/sdk:*:false",
        "maven:com.acme:sdk:[1.0,2.0):false",
      ].join("\n"),
    );
    // Publish credentials have no `transitive`.
    expect(text.format(grants, false)).not.toContain(":false");
  });

  it("reads back what it writes", () => {
    const grants = [
      grant("cargo", "acme-core", ">=1.4, <2", false),
      grant("maven", "com.acme:sdk", "[1.0,2.0)"),
      grant("npm", "@acme/*"),
    ];
    expect(parse(text.format(grants, true))).toEqual(grants);
  });
});
