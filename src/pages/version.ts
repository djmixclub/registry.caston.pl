/**
 * The version page (`GET /packages/<eco>/<name>/<version>`): the files of one version with
 * their size, role and labels, checksums (`sha256` and any extra `digests`), a download link
 * through the panel (`…/files/<file>`, a redirect to a presigned URL), for generic packages the
 * version's `meta` as a key/value table and, collapsed, how to get exactly this version: the
 * adapter's pinned install snippets and the native URLs the package manager requests.
 */

import type { Eco, ManifestFile, Snippet } from "../adapters/types";
import {
  backLink,
  breadcrumbs,
  day,
  ecoBadge,
  fileHref,
  humanSize,
  metadataSection,
  packageHref,
  plural,
  snippetList,
} from "./catalog";
import { breakAfterSlashes } from "./components";
import { markup, type SafeHtml } from "./html";
import { layout, type PageContext } from "./layout";

/** One file of the version page. */
export interface VersionFile extends ManifestFile {
  /** Extra digests computed at commit (docs/api.md 6.5), lower-case hex by algorithm. */
  digests?: Record<string, string>;
  /**
   * The native download URL (`adapter.fileUrl`); `null` when the adapter serves this file
   * through no native endpoint (NuGet symbols), absent when the ecosystem has none at all.
   */
  nativeUrl?: string | null;
}

/** What the version page shows. */
export interface VersionPageData {
  eco: Eco;
  name: string;
  version: string;
  published: string;
  yanked: boolean;
  files: VersionFile[];
  /** Generic: the version's free-form `meta` (the manifest's `native`). */
  meta?: Record<string, unknown>;
  /** `adapter.versionSnippets` for this version: how to get exactly it. */
  snippets?: Snippet[];
}

/** `1234567` → `1,234,567`. */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function labels(file: VersionFile): SafeHtml {
  const role = file.role === undefined ? "" : markup`<span class="badge">${file.role}</span>`;
  const pairs = Object.entries(file.labels ?? {}).map(
    ([key, value]) => markup`<span class="badge">${key}: ${value}</span>`,
  );
  if (role === "" && pairs.length === 0) return markup``;
  return markup`<span class="file-labels">${role}${pairs}</span>`;
}

function checksums(file: VersionFile): SafeHtml {
  const all: [string, string][] = [["sha256", file.sha256], ...Object.entries(file.digests ?? {})];
  return markup`<dl class="checksums">${all.map(
    ([algorithm, hex]) => markup`<div><dt>${algorithm}</dt><dd><code>${hex}</code></dd></div>`,
  )}</dl>`;
}

function fileRow(data: VersionPageData, file: VersionFile): SafeHtml {
  return markup`<tr>
<td data-label="File"><span class="file-name">${file.name}</span>${labels(file)}</td>
<td data-label="Size"><span title="${groupDigits(file.size)} bytes">${humanSize(file.size)}</span></td>
<td data-label="Checksums">${checksums(file)}</td>
<td data-label="Download"><a class="button small" href="${fileHref(data.eco, data.name, data.version, file.name)}">Download</a></td>
</tr>`;
}

/** The native URLs of the files that have one; nothing when none has. */
function addresses(files: readonly VersionFile[]): SafeHtml {
  const items = files.flatMap((file) =>
    typeof file.nativeUrl === "string"
      ? [
          markup`<li><span class="native-file">${file.name}</span> → <code>${breakAfterSlashes(file.nativeUrl)}</code></li>`,
        ]
      : [],
  );
  if (items.length === 0) return markup``;
  return markup`<h3 class="native-title">Addresses used by the client</h3>
<p class="hint">These are the URLs the package manager requests for this version; they also appear in lock files. Files without an address are only available through the download buttons above.</p>
<ul class="native-urls">
${items}
</ul>`;
}

/** The collapsed "Get exactly this version"; nothing without snippets or addresses. */
function getThisVersion(data: VersionPageData): SafeHtml {
  const snippets = data.snippets ?? [];
  const urls = addresses(data.files);
  if (snippets.length === 0 && urls.value === "") return markup``;
  return markup`<details class="collapsible" id="get-version">
<summary>Get exactly this version</summary>
${snippetList(snippets, "pin")}
${urls}
</details>`;
}

/** The version page. */
export function versionPage(ctx: PageContext, data: VersionPageData): string {
  const pkg = packageHref(data.eco, data.name);
  const yanked = data.yanked
    ? markup`<p class="hint"><span class="badge warn">yanked</span> This version is no longer offered to dependency resolution; existing lockfiles can still download it.</p>`
    : "";
  return layout(
    ctx,
    `${data.name} ${data.version}`,
    markup`<div class="catalog">
${breadcrumbs([
  { label: "Packages", href: "/" },
  { label: data.name, href: pkg },
  { label: data.version },
])}
<header class="pkg-header">
${ecoBadge(data.eco)}
<h1>${data.name} <span class="version">${data.version}</span></h1>
<p class="pkg-meta">Published <time datetime="${data.published}">${day(data.published)}</time> · ${plural(data.files.length, "file")}</p>
${yanked}
</header>
<section class="pkg-section" aria-labelledby="files">
<h2 id="files">Files</h2>
<div class="files-wrap"><table class="files">
<thead><tr><th>File</th><th>Size</th><th>Checksums</th><th><span class="visually-hidden">Download</span></th></tr></thead>
<tbody>
${data.files.map((file) => fileRow(data, file))}
</tbody>
</table></div>
</section>
${metadataSection(data.meta)}
${getThisVersion(data)}
${backLink(pkg, data.name)}
</div>`,
  );
}
