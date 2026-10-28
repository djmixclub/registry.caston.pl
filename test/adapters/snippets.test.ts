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
