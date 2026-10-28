/**
 * The version page (`GET /packages/<eco>/<name>/<version>`): the files of one version with
 * their size, role and labels, checksums (`sha256` and any extra `digests`), a download link
 * through the panel (`…/files/<file>`, a redirect to a presigned URL) and, for reference, the
 * native download URL that package managers use; for generic packages also the version's
 * `meta` as a key/value table.
 */

import type { Eco, ManifestFile } from "../adapters/types";
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
  const native =
    file.nativeUrl === undefined
      ? ""
      : file.nativeUrl === null
        ? markup`<span class="native-url">No native URL</span>`
        : markup`<span class="native-url">Native URL: <code>${breakAfterSlashes(file.nativeUrl)}</code></span>`;
  return markup`<tr>
<td data-label="File"><span class="file-name">${file.name}</span>${labels(file)}${native}</td>
<td data-label="Size"><span title="${groupDigits(file.size)} bytes">${humanSize(file.size)}</span></td>
<td data-label="Checksums">${checksums(file)}</td>
<td data-label="Download"><a class="button small" href="${fileHref(data.eco, data.name, data.version, file.name)}">Download</a></td>
</tr>`;
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
${backLink(pkg, data.name)}
</div>`,
  );
}
