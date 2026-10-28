/**
 * Test helpers around the `.nuspec` fixture: the metadata object the CLI derives from a
 * `.nuspec` (docs/api.md 6.4, nuget `manifest`), and a fixture rewritten for another id,
 * version or dependency list.
 */

import sample from "./sample.nuspec?raw";

export const SAMPLE_NUSPEC = sample;

function decode(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function element(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m?.[1] === undefined ? undefined : decode(m[1].trim());
}

function attribute(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m?.[1] === undefined ? undefined : decode(m[1]);
}

/** The dependency groups of a `.nuspec`, as `sreg nuget publish` sends them. */
function dependencyGroups(xml: string) {
  const block = /<dependencies>([\s\S]*?)<\/dependencies>/.exec(xml)?.[1] ?? "";
  const groups = [...block.matchAll(/<group(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/group>)/g)];
  return groups.map((g) => ({
    targetFramework: attribute(g[1] ?? "", "targetFramework") ?? null,
    dependencies: [...(g[2] ?? "").matchAll(/<dependency\s[^>]*\/?>/g)].map((d) => ({
      id: attribute(d[0], "id") ?? "",
      range: attribute(d[0], "version") ?? "",
    })),
  }));
}

/** The nuget `manifest` of `init` for a `.nuspec`, as the CLI builds it. */
export function metadataFromNuspec(xml: string): Record<string, unknown> {
  const tags = element(xml, "tags");
  const license = /<license\s+type="expression">([^<]*)<\/license>/.exec(xml)?.[1];
  return {
    id: element(xml, "id"),
    version: element(xml, "version"),
    nuspec: xml,
    description: element(xml, "description"),
    authors: element(xml, "authors"),
    projectUrl: element(xml, "projectUrl"),
    ...(license === undefined ? {} : { licenseExpression: license }),
    ...(tags === undefined ? {} : { tags: tags.split(/\s+/).filter((t) => t !== "") }),
    dependencyGroups: dependencyGroups(xml),
  };
}

/** The sample `.nuspec` with another id and version and, optionally, other dependencies. */
export function nuspecFor(
  id: string,
  version: string,
  dependencies?: { targetFramework: string | null; dependencies: { id: string; range: string }[] }[],
): string {
  let xml = sample
    .replace(/<id>[^<]*<\/id>/, `<id>${id}</id>`)
    .replace(/<version>[^<]*<\/version>/, `<version>${version}</version>`);
  if (dependencies !== undefined) {
    const groups = dependencies
      .map((g) => {
        const tfm = g.targetFramework === null ? "" : ` targetFramework="${g.targetFramework}"`;
        const deps = g.dependencies
          .map((d) => `        <dependency id="${d.id}" version="${d.range}" />\n`)
          .join("");
        return `      <group${tfm}>\n${deps}      </group>\n`;
      })
      .join("");
    xml = xml.replace(
      /<dependencies>[\s\S]*<\/dependencies>/,
      `<dependencies>\n${groups}    </dependencies>`,
    );
  }
  return xml;
}
