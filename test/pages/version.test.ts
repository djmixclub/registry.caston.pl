import { describe, expect, it } from "vitest";
import { versionPage, type VersionFile, type VersionPageData } from "../../src/pages/version";

const ctx = {
  host: "packages.example.com",
  version: "1.0.0",
  user: { project: "shop", kind: "read" as const },
};
const SHA = "ab".repeat(32);

const data: VersionPageData = {
  eco: "composer",
  name: "acme/sdk",
  version: "1.2.0",
  published: "2026-10-28T10:12:00Z",
  yanked: false,
  files: [
    {
      name: "acme-sdk-1.2.0.zip",
      size: 1536,
      sha256: SHA,
      nativeUrl: "https://packages.example.com/composer/dist/acme/sdk/1.2.0.zip",
    },
  ],
};

describe("versionPage", () => {
  it("shows breadcrumbs, the badge, the name, the version and the date", () => {
    const page = versionPage(ctx, data);
    expect(page).toContain("<title>acme/sdk 1.2.0 · packages.example.com</title>");
    expect(page).toContain(
      '<ol><li><a href="/">Packages</a></li><li><a href="/packages/composer/acme%2Fsdk">acme/sdk</a></li><li aria-current="page">1.2.0</li></ol>',
    );
    expect(page).toContain('<span class="eco-badge" data-eco="composer">Composer</span>');
    expect(page).toContain('<h1>acme/sdk <span class="version">1.2.0</span></h1>');
    expect(page).toContain(
      'Published <time datetime="2026-10-28T10:12:00Z">2026-10-28</time> · 1 file',
    );
    expect(page).toContain(
      '<p class="back"><a href="/packages/composer/acme%2Fsdk">← acme/sdk</a></p>',
    );
    expect(page).not.toContain("yanked");
  });

  it("lists the files with size, sha256 and a download link", () => {
    const page = versionPage(ctx, data);
    expect(page).toContain('<table class="files">');
    expect(page).toContain('<span class="file-name">acme-sdk-1.2.0.zip</span>');
    expect(page).toContain('<span title="1,536 bytes">1.5 KiB</span>');
    expect(page).toContain(`<dt>sha256</dt><dd><code>${SHA}</code></dd>`);
    expect(page).not.toContain("Native URL");
    expect(page).toContain(
      '<a class="button small" href="/packages/composer/acme%2Fsdk/1.2.0/files/acme-sdk-1.2.0.zip">Download</a>',
    );
    expect(page).not.toContain("file-labels");
  });

  it("shows roles, labels and extra digests, and leaves out a missing native URL", () => {
    const page = versionPage(ctx, {
      ...data,
      eco: "generic",
      name: "tools",
      yanked: true,
      files: [
        {
          name: "tool linux.tar.gz",
          size: 3 * 1024 * 1024,
          sha256: SHA,
          role: "binary",
          labels: { os: "linux", arch: "x64" },
          digests: { sha512: "cd".repeat(64) },
        },
        { name: "README.md", size: 12, sha256: SHA },
      ],
    });
    expect(page).toContain(
      '<span class="file-labels"><span class="badge">binary</span><span class="badge">os: linux</span><span class="badge">arch: x64</span></span>',
    );
    expect(page).toContain(`<dt>sha512</dt><dd><code>${"cd".repeat(64)}</code></dd>`);
    expect(page).toContain('<span title="3,145,728 bytes">3.0 MiB</span>');
    expect(page).toContain('href="/packages/generic/tools/1.2.0/files/tool%20linux.tar.gz"');
    expect(page).not.toContain("Native URL");
    expect(page).toContain("2 files");
    expect(page).toContain('<span class="badge warn">yanked</span> This version');
  });

  it("lets native URLs wrap after each slash, not inside a segment", () => {
    const page = versionPage(ctx, {
      ...data,
      files: [{ name: "a.zip", size: 1, sha256: SHA, nativeUrl: "https://r.test/a//b/c-<x>/" }],
    });
    expect(page).toContain(
      '<li><span class="native-file">a.zip</span> → <code>https://<wbr>r.test/<wbr>a//<wbr>b/<wbr>c-&lt;x&gt;/</code></li>',
    );
  });

  it("collapses how to get exactly this version, with snippets and the client addresses", () => {
    const page = versionPage(ctx, {
      ...data,
      snippets: [
        {
          title: "Require this version",
          description: "Require exactly this version.",
          filename: "terminal",
          language: "shell",
          body: "composer require acme/sdk:1.2.0\n",
        },
      ],
    });
    expect(page).toContain(
      '<details class="collapsible" id="get-version">\n<summary>Get exactly this version</summary>',
    );
    expect(page).not.toContain("<details open");
    expect(page).toContain('<p class="snippet-desc">Require exactly this version.</p>');
    expect(page).toContain("<pre><code>composer require acme/sdk:1.2.0\n</code></pre>");
    expect(page).toContain('<h3 class="native-title">Addresses used by the client</h3>');
    expect(page).toContain(
      "These are the URLs the package manager requests for this version; they also appear in lock files. Files without an address are only available through the download buttons above.",
    );
    expect(page).toContain(
      '<span class="native-file">acme-sdk-1.2.0.zip</span> → <code>https://<wbr>packages.example.com/<wbr>composer/<wbr>dist/<wbr>acme/<wbr>sdk/<wbr>1.2.0.zip</code>',
    );
    expect(page.indexOf("Files</h2>")).toBeLessThan(page.indexOf("Get exactly this version"));
  });

  it("shows alternatives of the version snippets in a chooser", () => {
    const snippet = { filename: "f", language: "x", group: "Build tool", description: "D." };
    const page = versionPage(ctx, {
      ...data,
      snippets: [
        { ...snippet, title: "pom.xml", variant: "Maven", body: "<dependency/>" },
        { ...snippet, title: "build.gradle.kts", variant: "Gradle", body: "implementation()" },
      ],
    });
    expect(page).toContain('<fieldset class="chooser" data-chooser="Build tool">');
    expect(page).toContain('name="pin-1" id="pin-1-1" value="Maven" checked>');
    expect(page).toContain('<label for="pin-1-2">Gradle</label>');
  });

  it("leaves out the section without snippets and native URLs", () => {
    const page = versionPage(ctx, {
      ...data,
      files: [{ ...data.files[0], nativeUrl: null }] as VersionFile[],
    });
    expect(page).not.toContain("Get exactly this version");
    expect(page).not.toContain("Addresses used by the client");
  });

  it("shows a generic version's meta, and nothing when it is empty", () => {
    const generic = { ...data, eco: "generic" as const, name: "tools" };
    const page = versionPage(ctx, { ...generic, meta: { channel: "stable", tags: ["a", "b"] } });
    expect(page).toContain('<h2 id="metadata">Metadata</h2>');
    expect(page).toContain('<tr><th scope="row">channel</th><td>stable</td></tr>');
    expect(page).toContain(
      '<th scope="row">tags</th><td><code class="meta-json">[\n  &quot;a&quot;,\n  &quot;b&quot;\n]</code>',
    );
    expect(page.indexOf("Files</h2>")).toBeLessThan(page.indexOf("Metadata</h2>"));
    expect(versionPage(ctx, { ...generic, meta: {} })).not.toContain("Metadata");
    expect(versionPage(ctx, data)).not.toContain("Metadata");
  });

  it("lists only the files that have a native URL", () => {
    const page = versionPage(ctx, {
      ...data,
      eco: "nuget",
      name: "Acme.Sdk",
      files: [
        {
          name: "acme.sdk.1.2.0.nupkg",
          size: 10,
          sha256: SHA,
          nativeUrl: "https://r.test/n.nupkg",
        },
        { name: "acme.sdk.1.2.0.snupkg", size: 10, sha256: SHA, nativeUrl: null },
      ],
    });
    expect(page).toContain(
      '<span class="native-file">acme.sdk.1.2.0.nupkg</span> → <code>https://<wbr>r.test/<wbr>n.nupkg</code>',
    );
    expect(page).not.toContain('<span class="native-file">acme.sdk.1.2.0.snupkg</span>');
    expect(page).not.toContain("No native URL");
  });

  it("escapes file data", () => {
    const page = versionPage(ctx, {
      ...data,
      files: [{ name: "<x>.zip", size: 1, sha256: SHA, labels: { "<k>": "<v>" } }],
    });
    expect(page).toContain('<span class="file-name">&lt;x&gt;.zip</span>');
    expect(page).toContain("&lt;k&gt;: &lt;v&gt;");
    expect(page).not.toContain("<x>");
  });
});
