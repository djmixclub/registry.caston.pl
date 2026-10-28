import { describe, expect, it } from "vitest";
import { versionPage, type VersionPageData } from "../../src/pages/version";

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

  it("lists the files with size, sha256, native URL and a download link", () => {
    const page = versionPage(ctx, data);
    expect(page).toContain('<table class="files">');
    expect(page).toContain('<span class="file-name">acme-sdk-1.2.0.zip</span>');
    expect(page).toContain('<span title="1,536 bytes">1.5 KB</span>');
    expect(page).toContain(`<dt>sha256</dt><dd><code>${SHA}</code></dd>`);
    expect(page).toContain(
      "Native URL: <code>https://packages.example.com/composer/dist/acme/sdk/1.2.0.zip</code>",
    );
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
    expect(page).toContain('<span title="3,145,728 bytes">3.0 MB</span>');
    expect(page).toContain('href="/packages/generic/tools/1.2.0/files/tool%20linux.tar.gz"');
    expect(page).not.toContain("Native URL");
    expect(page).toContain("2 files");
    expect(page).toContain('<span class="badge warn">yanked</span> This version');
  });

  it("says when a file has no native URL", () => {
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
    expect(page).toContain("Native URL: <code>https://r.test/n.nupkg</code>");
    expect(page).toContain(
      '<span class="file-name">acme.sdk.1.2.0.snupkg</span><span class="native-url">No native URL</span>',
    );
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
