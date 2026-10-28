import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../../src/adapters/index";
import type { Eco } from "../../src/adapters/types";

const BASE = "https://packages.example.com";

/** One package name per ecosystem, in its own syntax. */
const NAMES: Readonly<Record<Eco, string>> = {
  composer: "acme/sdk",
  npm: "@acme/sdk",
  cargo: "acme-core",
  generic: "tools/cli",
  nuget: "Acme.Sdk",
  swift: "acme.networking",
  maven: "com.acme:sdk",
};

/** The groups of alternatives and their variants, in order, per ecosystem. */
const GROUPS: Readonly<Record<Eco, Record<string, string[]>>> = {
  composer: {
    "Set up the registry": [
      "Command",
      "Bearer (auth.json)",
      "Bearer (auth.json)",
      "HTTP basic (auth.json)",
      "HTTP basic (auth.json)",
      "Token in the URL",
      "Environment variables",
      "Environment variables",
    ],
  },
  npm: {
    "Set up the registry": [
      "Command",
      "_authToken (Bearer)",
      "_auth (Basic)",
      "Environment variables",
      "Environment variables",
    ],
  },
  cargo: { "Set up the registry": ["Files", "Files", "Environment variables"] },
  generic: { Download: ["curl", "sreg", "Environment variables"] },
  nuget: {
    "Set up the registry": [
      "Command",
      "nuget.config",
      "Environment variables",
      "Environment variables",
    ],
  },
  swift: { "Set up the registry": ["Command", "Environment variables"] },
  maven: {
    "Build tool": ["Maven", "Maven", "Gradle", "Environment variables", "Environment variables"],
  },
};

function groupsOf(snippets: { group?: string; variant?: string }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of snippets) {
    if (s.group !== undefined) (out[s.group] ??= []).push(s.variant ?? "");
  }
  return out;
}

describe("client configuration snippets", () => {
  for (const [eco, adapter] of Object.entries(ADAPTERS) as [Eco, (typeof ADAPTERS)[Eco]][]) {
    it(`${eco}: describe every snippet and group the alternatives`, () => {
      const snippets = adapter.clientConfig(BASE, "shop:secret", [NAMES[eco]]);
      expect(snippets.length).toBeGreaterThan(0);
      for (const s of snippets) {
        expect(s.description, s.title).toMatch(/^[A-Z].+\.$/);
        expect(s.group === undefined, s.title).toBe(s.variant === undefined);
      }
      expect(groupsOf(snippets)).toEqual(GROUPS[eco]);
    });

    it(`${eco}: take the token from REGISTRY_TOKEN in the environment variant`, () => {
      const env = adapter
        .clientConfig(BASE, "shop:secret", [NAMES[eco]])
        .filter((s) => s.variant === "Environment variables");
      const text = env.map((s) => s.body).join("\n");
      if (eco === "cargo") expect(text).toContain("CARGO_REGISTRIES_SREG_TOKEN=shop:secret");
      else if (eco === "composer") expect(text).toContain("export COMPOSER_AUTH='{");
      else
        expect(text).toMatch(
          /\$REGISTRY_TOKEN|\$\{REGISTRY_TOKEN\}|%REGISTRY_TOKEN%|env\.REGISTRY_TOKEN|getenv\("REGISTRY_TOKEN"\)/,
        );
    });
  }
});

describe("version snippets", () => {
  const VERSION = "1.2.3";
  /** A line each ecosystem's snippets for version 1.2.3 must contain. */
  const PINNED: Readonly<Record<Eco, string[]>> = {
    composer: ["composer require acme/sdk:1.2.3\n"],
    npm: ["npm install --save-exact @acme/sdk@1.2.3\n"],
    cargo: ["cargo add acme-core@=1.2.3 --registry sreg\n"],
    generic: [
      `REGISTRY_URL=${BASE} sreg generic get tools/cli 1.2.3 --out .\n`,
      'curl -fsSL -H "Authorization: Bearer $REGISTRY_TOKEN" -o <file>',
      `"${BASE}/generic/tools%2Fcli/1.2.3/<file>"`,
    ],
    nuget: ["dotnet add package Acme.Sdk --version 1.2.3 --source sreg\n"],
    swift: ['.package(id: "acme.networking", exact: "1.2.3"),\n'],
    maven: [
      "<groupId>com.acme</groupId>\n  <artifactId>sdk</artifactId>\n  <version>1.2.3</version>",
      'implementation("com.acme:sdk:1.2.3")\n',
    ],
  };

  for (const [eco, adapter] of Object.entries(ADAPTERS) as [Eco, (typeof ADAPTERS)[Eco]][]) {
    it(`${eco}: pin the version, with a description`, () => {
      const snippets = adapter.versionSnippets?.(`${BASE}/`, NAMES[eco], VERSION) ?? [];
      expect(snippets.length).toBeGreaterThan(0);
      for (const s of snippets) expect(s.description, s.title).toMatch(/^[A-Z].+\.$/);
      const text = snippets.map((s) => s.body).join("\n");
      for (const line of PINNED[eco]) expect(text).toContain(line);
      expect(text).not.toContain("secret");
    });
  }

  it("maven: offers Maven and Gradle as alternatives", () => {
    const snippets = ADAPTERS.maven.versionSnippets?.(BASE, "com.acme:sdk", VERSION) ?? [];
    expect(snippets.map((s) => [s.group, s.variant])).toEqual([
      ["Build tool", "Maven"],
      ["Build tool", "Gradle"],
    ]);
  });
});
