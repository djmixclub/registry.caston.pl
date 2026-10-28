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
  composer: { Authentication: ["Bearer token", "HTTP basic", "Token in the URL"] },
  npm: { Authentication: ["_authToken (Bearer)", "_auth (Basic)"] },
  cargo: {},
  generic: { Download: ["curl", "sreg"] },
  nuget: { "Package source": ["dotnet CLI", "nuget.config"] },
  swift: {},
  maven: { "Build tool": ["Maven", "Maven", "Gradle"] },
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
  }
});
