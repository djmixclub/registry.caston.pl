# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases call
out breaking changes and changes that require a data migration in their own sections.

## [Unreleased]

### Added

- **Bump and release** workflow (`.github/workflows/bump-and-release.yml`, started by hand on
  `main`): computes the next version (`prerelease`, `patch`, `minor`, `release`, `custom`, …)
  with the dependency-free `scripts/bump-version.mjs`, sets it in `package.json`,
  `package-lock.json` and `src/version.ts`, rolls `CHANGELOG.md`, commits and tags
  `v<version>` and creates the GitHub Release (a prerelease for `-beta.N` versions, which the
  update check ignores).

## [0.1.0] - 2026-10-28

### Added

- English specification (`docs/spec.md`) and HTTP API contract (`docs/api.md`).
- Deployment guide (`docs/deployment.md`): the Deploy to Cloudflare button, a fork with the
  GitHub Actions workflow and a local deploy, the settings and secrets, the custom domain, the
  first run, updates, the free plan limits, backups and troubleshooting. The README leads with
  the deploy button and a quick start, and `wrangler.jsonc` explains its bindings and
  variables.
- Worker project scaffold: TypeScript, ESLint, Prettier, Wrangler configuration and tests
  running inside the Workers runtime.
- `GET /api/v1/version` endpoint.
- CI workflow and a GitHub Actions deploy workflow for forks.
- Adapter contracts (`Adapter`, `Manifest`, `IndexFile`, routes, snippets), the
  `ValidationError` class and JSON response helpers.
- Dependency-free version parsing and range evaluation in the npm, Composer and cargo
  dialects.
- Grant evaluation (package patterns, version constraints) and the `eco:package[:versions]`
  shorthand.
- Token parsing (`TOKEN_PREFIX`, sources, secret types) and normalisation of the Bearer,
  Basic and raw `Authorization` forms.
- Credential records in KV and verification of `key` secrets and GitHub Actions OIDC tokens
  (JWKS and positive verifications cached in KV).
- Panel sessions in KV with a 12-hour `sreg_session` cookie.
- Version manifests list one or more files (name, size, SHA-256, optional role and labels);
  `generic` and `nuget` ecosystems in the adapter contracts, with adapter-defined version
  validation and ordering.
- Dependency-free AWS Signature V4 presigning of R2 `PUT` (covering `content-length` and
  `x-amz-checksum-sha256`) and `GET` URLs.
- Installation settings helpers and the `R2_BUCKET_NAME`, `ECOSYSTEMS` and
  `APPEND_WINDOW_HOURS` variables.
- R2 storage layer: key layout, immutable manifest writes, version deletion, manifest and
  package listings, index files, optimistic read-modify-write with etag conditions,
  `_meta/packages.json`, appending files to a version (`409 file_exists`) and staging of
  uploads.
- Data schema migrations run once per isolate on the first request (`schema_version` in KV,
  best-effort `migrate:lock`); migration 1 creates `_meta/packages.json`.
- Hourly cleanup of uploads older than 24 hours and of expired auth entries.
- Adapter registry: adapters are created on first use and only the ecosystems enabled by
  `ECOSYSTEMS` are routed and listed; grant version constraints are validated by the
  ecosystem's adapter.
- Composer adapter: `composer.json` validation, Composer 2 minified `p2` metadata (newest
  first, yanked versions omitted, empty `~dev` file), per-credential `packages.json`, dist
  downloads and client configuration snippets (bearer, http-basic and token-in-URL).
- `POST /api/v1/publish/init` and `POST /api/v1/publish/commit` with one presigned `PUT` per
  file, staged object verification (`upload_incomplete`, `upload_mismatch`), idempotent
  commits and appending files to versions of adapters that support it (`version_closed`,
  `file_exists`).
- Package administration (`yank`, delete of a version or a package, `reindex`) and the
  credentials API (create, list, read, replace grants, delete, add and expire secrets), plus
  first-run helpers for creating the first admin.
- `GET /api/v1/packages` and `GET /api/v1/packages/<eco>/<name>` filtered by the caller's
  grants.
- Request routing: `/api/v1` with client version negotiation, JSON body limits, Bearer, Basic
  and raw tokens or the panel session cookie (`X-Requested-With` for mutations); native
  routes per enabled ecosystem with grant filtering and `302` redirects to presigned
  downloads; static assets for everything else.
- Transitive read grants (`transitive`, default `true`, also as the `:true`/`:false` shorthand
  suffix): the closure of the dependency constraints declared in the manifests (composer
  `require` and `require-dev`, yanked versions included) is served by the native protocol,
  cached in KV as `closure:<project>:<eco>` for 60 seconds and dropped on every publish,
  yank, delete, reindex and grant change; read entries of the package listings carry the
  `dependencies` each grant opens.
- Home page and admin panel rendered by the Worker (styles and a small dependency-free script
  served as static assets, `Content-Security-Policy: default-src 'self'`, no inline scripts):
  first-run creation of the admin with its token shown once, login with a token or a login
  and password (`POST /login`, `POST /logout`, 12-hour session cookie), the consumer view
  with the granted packages, their transitive dependencies and client configuration
  snippets, a publish-only notice, and the admin pages Packages, Credentials and Settings.
- Update check: with `CHECK_UPDATES=true` the Settings tab compares the running version with
  the latest GitHub release, fetched at most once a day and cached in KV (`updates:latest`).
- `gh` secrets store the optional `repository_id`, `repository_owner_id` and `environment`
  claims, a `ref` glob and an `owner/*` repository; the panel's add-secret form has the fields.
- `GET /api/v1/github/repository?name=owner/repo` (admin) returns a repository's ids from
  GitHub; the add-secret form's "Look up" button fills them in.
- `publish` credentials may hold `key` secrets; the panel offers them for every kind.
- npm adapter: scoped `package.json` manifests (fields starting with `_` dropped, the requested
  dist-tag recorded in the manifest's `meta`), the packument with tarball URLs, `sha256`
  integrity and `time`, dist-tags derived from the manifests (yanked versions removed, `latest`
  and `next` falling back to the highest stable and prerelease version) and recomputed for
  the versions each credential may see, single versions and dist-tags at
  `/npm/<name>/<version>`, tarball redirects, `ping`, `whoami`, `.npmrc` snippets (`_authToken`
  and `_auth`) and dependencies from every `package.json` dependency section.
- cargo adapter: index lines validated against the sparse index shape, lower-case crate names,
  one `<name>-<version>.crate` archive whose SHA-256 is the `cksum`, one sparse index file per
  crate with every version (yanked ones marked) and `v: 2`, `config.json`, `dl` redirects, a
  minimal `/cargo/api/v1/crates/<name>`, `config.toml`/`credentials.toml`/`Cargo.toml`
  snippets and dependencies from `deps[]` entries of this registry.
- Native routes for credential checks (`ping`, `whoami`) and configuration documents, index
  routes that select one entry or render another view, and `404` when the adapter's filter
  leaves nothing to serve (a cargo index file without visible versions, a hidden npm version).
- The reserved login `_:gh.<jwt>` resolves the project of a GitHub Actions token from its
  `repository` claim through the `gh-repo:<owner/repo>` and `gh-repo:<owner>/*` KV index:
  the matching credential of kind `publish` on `/api/v1/publish/*`, of kind `read` everywhere
  else (native protocols and the panel login included), never an `admin`; more than one match
  answers `401` asking for `<project>:gh.<jwt>`. Every credential write (API, panel, hourly
  cleanup) keeps the index in step, and data migration 2 builds it for existing credentials.
- Adapters may declare extra digests (`sha1`, `md5`, `sha512`): `commit` computes them while
  streaming each staged file to its final key (a `DigestStream` per algorithm, nothing
  buffered) and stores them as `files[].digests`, returned by the package listings and the
  yank response; `reindex` never recomputes them.
- `swift` and `maven` ecosystems in the adapter registry; `ECOSYSTEMS` defaults to all seven.
  Maven names
  (`group:artifact`) and Swift names (`scope.name`) keep `:` and `.` literally in R2 keys and
  grant patterns, Swift names match case-insensitively, and the grant shorthand splits Maven
  names correctly (`maven:com.acme:sdk:<versions>`).
- Generic adapter and feed (`/generic/…`): versions of any number of labelled files with a
  free-form `meta` (at most 64 KiB), appends within `APPEND_WINDOW_HOURS`, the package listing
  with each package's `latest`, package and version documents filtered by `?label=` and
  `?include=yanked`, `latest` with `?channel=prerelease`, `302` file downloads and client
  snippets for `curl` and `sreg generic get`.
- NuGet adapter and V3 feed (`/nuget/…`): NuGet versions (one to four parts, normalised form)
  and version ranges (minimums, intervals, exact and floating versions), `.nupkg` with an
  optional `.snupkg`, the service index, the flat container with `.nupkg` redirects and the
  `.nuspec`, an inlined registration index (`listed: false` for yanked versions), search,
  transitive access through dependency groups and `dotnet`/`nuget.config` snippets. A `401`
  on the feed carries a Basic challenge next to the Bearer one.
- Native JSON responses carry a strong `ETag` and answer a matching `If-None-Match` with
  `304`.
- Panel: `gh` secrets can pin their repository and owner ids on first use (a checkbox,
  checked by default), and entries still waiting for their ids are marked in the secrets
  table.
- Panel: admin credentials can use a chosen password (at least 12 characters, typed twice)
  instead of a generated secret, at first run, when creating an admin credential and when
  adding a key secret to one.
- Swift adapter and registry (`/swift/…`, SE-0292): `<scope>.<name>` identities matched
  case-insensitively (lower case in R2 keys, the published casing in responses), semver
  versions, the source archive plus `Package.swift` and its `Package@swift-X[.Y[.Z]].swift`
  variants (file names may contain `@`), one `releases.json` index per package, the release
  list (yanked releases with a `problem`), release metadata with `latest-version`,
  `successor-version` and `predecessor-version` links (`410` for a yanked release), manifests
  served from storage with SwiftPM's variant selection and `alternate` links, archive
  redirects with a `Digest` header, `GET /swift/identifiers?url=`, `POST /swift/login`,
  `Content-Version: 1` and problem details on every response, `415` for other API versions,
  transitive access through `registry` dependencies of `dump-package` and SwiftPM snippets.
- Maven adapter and repository (`/maven/…`): `ComparableVersion` ordering (no `-SNAPSHOT`
  versions), Maven version ranges (a plain version is a minimum in grants and exact as a
  dependency), file roles derived from the names (`pom`, `archive` by packaging, `sources`,
  `javadoc`, `module`, `extra`; checksum uploads rejected), `sha1`/`md5`/`sha512` digests
  computed at commit, `maven-metadata.xml` generated per credential from a JSON index
  (yanked versions left out) with its checksums, file redirects and file checksums, transitive
  access through `compile` and `runtime` dependencies and Maven/Gradle snippets.
- Swift and Maven `401` responses carry a Basic challenge next to the Bearer one.
- Adapter hooks for native responses: index filters may answer asynchronously and with their
  own status and headers, archive routes may serve small files inline from R2 and let the
  adapter pick the file and add headers (`selectFile`), static routes may set a status and
  content type, and `finalizeResponse` adjusts every response of an ecosystem.
- Generic feed: `?version=<range>` (npm syntax) on the package document and on `latest`
  (prereleases of a matching release with `?channel=prerelease`), and
  `GET /generic/<name>/<version|latest>/-/download?label=…`, which redirects to the single
  file the labels select (with `X-Resolved-Version` and `X-Resolved-File`) and answers
  `409 ambiguous` with the candidate files when several match. Archive routes can have their
  version resolved by the kernel through an index route (`resolve`), and error bodies can
  carry extra fields.

### Changed

- Specification version 8 and the matching HTTP API contract (including HMAC-signed panel
  session cookies, the Cache API for JWKS and the transitive closure, and no KV caches): a version is a list of files
  (`files[]` in manifests, `init`, `commit` and package listings), the new generic ecosystem
  with its JSON feed and appending files within `APPEND_WINDOW_HOURS`, the new NuGet
  ecosystem with its V3 feed, the Swift registry (SE-0292) and the Maven repository layout,
  adapter-defined version formats, transitive read grants with
  `dependencies` in package listings, CLI packaging and monorepo flags, the `_` login that
  resolves the project of a `gh` token through the `gh-repo:<owner/repo>` index, the full set
  of `gh` entry fields, optional `files[].digests`, ecosystems enabled through `ECOSYSTEMS`,
  and no administrative CLI commands. `/api/v1` changes in place because it has
  not been released yet.
- A panel session ends as soon as none of its credential's secrets is active any more.
- `gh` entries match every field of docs/api.md 2.5: `repository` case-insensitively or as an
  `owner/*` glob, `repository_id`, `repository_owner_id` and `environment` by equality, `ref`
  as a glob where `*` also matches `/`, and `workflow` against the workflow file path of the
  `workflow_ref` claim (previously the workflow's display name in the `workflow` claim).
- Data schema version 2 (migration 2 builds the `gh-repo:` index).
- Transitive access is computed from the dependency graph `_meta/deps/<eco>.json` in R2
  (`{ "<package>": { "<version>": { "<dependency>": "<constraint>" } } }`, yanked versions
  included; a dependency declared with several constraints lists them in an array), which
  `commit`, yank, delete and `reindex` update with the etag retry, so a closure costs one R2
  read instead of listing the manifests of every reachable package. The closure is cached
  per credential in the Cache API (`https://cache.internal/closure/<eco>/<project>`, 60
  seconds) instead of KV (`closure:<project>:<eco>`), with no invalidation: publications
  and grant changes reach transitive access within 60 seconds.
- Data schema version 3 (migration 3 builds `_meta/deps/<eco>.json` for every ecosystem from
  the existing manifests).
- The update check caches GitHub's answer in the Cache API
  (`https://cache.internal/updates/latest`, 24 hours, a failure for 1 hour) instead of KV
  (`updates:latest`).
- **Breaking:** `gh` tokens are verified on every request; the `ghok:` KV cache of positive
  verifications is gone. GitHub's JWKS is cached in the Cache API (`caches.default`, 24 hours,
  refetched after five minutes for an unknown key id) instead of KV (`jwks:github`).
- **Breaking:** panel sessions are signed cookies (`{ project, exp }` with HMAC-SHA256, 12
  hours) instead of `session:<id>` records in KV; logging out clears the cookie. The new
  `SESSION_SECRET` secret must be set, otherwise the panel login answers `500` naming it
  (API tokens keep working). Existing sessions end with the upgrade.
- Credential records and `gh-repo:` lists are cached in each Worker isolate for 60 seconds
  and replaced at once by the isolate's own writes.
- `gh` entries pin their repository on first use: with `pin_on_first_use` (stored explicitly,
  default `true`) the first matching token fills in a missing `repository_id` (exact entries)
  and `repository_owner_id`, after which the ids must match. Adding a secret through the
  credentials API accepts the field, and responses echo it.
- `admin` credentials may use a chosen password as a `key` secret (`password` when creating a
  credential, adding a secret or setting up the first admin; 12 to 128 printable characters
  without `:` or whitespace), stored as PBKDF2-SHA256 with 10 000 iterations; `read` and
  `publish` credentials answer `400`. The password part of a token is split into
  `<type>.<secret>` only when its first segment is a known type, so passwords may contain
  dots.
- Settings set in the dashboard survive deploys: `wrangler.jsonc` sets `keep_vars: true` and
  has no `vars` any more, so a deploy neither deletes plain-text variables nor resets them to
  the repository's values. `PUBLIC_URL` and `S3_ENDPOINT` may be plain variables. The defaults
  live in code and apply when a variable is unset: every ecosystem for `ECOSYSTEMS`,
  `536870912` for `MAX_UPLOAD_BYTES`, `24` for `APPEND_WINDOW_HOURS`, no `TOKEN_PREFIX`,
  `serverless-registry` for `R2_BUCKET_NAME`, and `CHECK_UPDATES` defaults to `true` (any
  other value than `true` disables the check). `.dev.vars.example` lists the five installation
  settings.
- The consumer view of the panel lists every package in one list sorted by name instead of a
  section per ecosystem: each row shows an ecosystem badge, the number of versions and the
  latest version (marked when yanked), and a filter bar narrows the list by name and
  ecosystem. Versions, dependencies and the configuration snippets moved to the new package
  page (`/packages/<eco>/<name>`), with snippets for that one package and the `<token>` note
  shown once; the new version page (`/packages/<eco>/<name>/<version>`) lists the files with
  sizes and checksums and downloads them through a presigned redirect. The layout is calmer:
  one card per package, more whitespace, snippets framed with a header row.
- The Settings tab shows, for a variable that is not set, the default the Worker uses (marked
  "(default)") instead of "not set".
- Package page: the configuration is collapsed under "Configuration and installation", every
  snippet has a one-line description, and alternative ways to set up the registry (a command,
  files, environment variables, Maven or Gradle) are shown one at a time in a chooser that
  works without JavaScript. Every adapter offers the command and environment-variable variants
  its client supports (`Snippet` gained the optional `description`, `group` and `variant`).
  The generic page shows the latest version's `meta` and an `sreg generic get` example built
  from a label the package really has; the adapter's own snippets use placeholders instead of
  made-up labels.
- Version page: a collapsed "Get exactly this version" with the adapter's pinned install
  snippets (new optional `Adapter.versionSnippets`) and the native URLs the client requests,
  which replace the "Native URL" line in the files table; generic versions show their `meta`.
- Sizes use binary units (`KiB`, `MiB`, `GiB`) on every page, and the admin Packages tab links
  each package to its package page.
- The package filter says "Showing N of M packages." while a filter is active.
- The admin panel has pages instead of tabs: the header links **Packages**, **Credentials**
  and **Settings**, and `/` opens `/admin/packages`. Packages are managed on each package's
  page (yank, delete a version, reindex, delete the package after typing its name);
  credentials have a list with a filter (which counts like the package filter), a "New credential" form and a page each with its
  overview, grants, secrets, "Add a secret" and a danger zone. A new token is shown once on
  the page that answers the form.
- The login page is a centred card with a Token / Login & password switch, "show" buttons on
  the secret fields and a link to the documentation; the first-run and token pages share the
  card.
- The first run and the admin **Settings** page show a setup checklist: every installation
  setting as Set, Missing or Default (never a secret's value), how to add a missing one and,
  for `SESSION_SECRET`, a value generated in the browser. While `SESSION_SECRET` is missing,
  the first run shows only the checklist instead of creating an admin who could not sign in.

### Fixed

- A password chosen for a new admin credential in the panel was ignored and a token was
  generated instead.
- `/api/v1/packages/<eco>/<name>` paths (package view, yank, delete, reindex) match NuGet and
  Swift names case-insensitively and accept NuGet versions in any form that normalises to the
  stored one, as docs/api.md 1.3 says; package listings show NuGet and Swift names with the
  casing of the highest visible version.

- Panel form posts (`/first-run`, `/login`, `/logout`) no longer answer `403` in browsers:
  pages are served with `Referrer-Policy: same-origin` instead of `no-referrer`, and a post
  with `Origin: null` or no `Origin` is accepted when `Sec-Fetch-Site` is `same-origin` or
  `none` (anything else without the registry's own origin is refused).
- The "Copy" button of code blocks sits above the block instead of covering it on narrow
  screens, and the "Look up" button no longer wraps.
- Spacing in the panel: sections of a credential card are set apart, card headings start at
  the card's top, and the card of the current tab joins the tabs bar.
- The grants of a credential card are headed once instead of twice.
- The `transitive` option is hidden for publish grants, where it has no effect.
- The version tables of the Packages tab have fixed columns that line up across packages.
- Every claim value of a `gh` secret (repository, ref, workflow, ids, environment) is shown in
  code style.
- The consumer view omits "Dependencies" for packages that have none.
- Input placeholders are lighter, and the first-run example reads "e.g. admin".
- Package, version and download routes of the panel find npm, Composer, NuGet and Swift
  packages whatever the casing of the name in the URL (`/packages/nuget/Acme.Sdk`), and the
  pages show NuGet ids and Swift identities with their published casing.
- Native URLs wrap after a `/` instead of in the middle of a word.
- The secrets table keeps dates on one line and gives the details the remaining width.
- The ecosystem chips of the filter bar are centred vertically.
- The first-run intro covers both a generated token and a chosen password.

[Unreleased]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kduma-OSS/serverless-registry-worker/releases/tag/v0.1.0
