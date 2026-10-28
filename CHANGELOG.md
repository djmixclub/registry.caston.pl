# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases call
out breaking changes and changes that require a data migration in their own sections.

## [Unreleased]

### Added

- English specification (`docs/spec.md`) and HTTP API contract (`docs/api.md`).
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
  ecosystem's adapter. npm, cargo, generic and nuget use placeholders until their adapters
  land.
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

### Changed

- Specification version 5 and the matching HTTP API contract: a version is a list of files
  (`files[]` in manifests, `init`, `commit` and package listings), the new generic ecosystem
  with its JSON feed and appending files within `APPEND_WINDOW_HOURS`, the new NuGet
  ecosystem with its V3 feed, adapter-defined version formats, transitive read grants with
  `dependencies` in package listings, CLI packaging and monorepo flags, ecosystems enabled
  through `ECOSYSTEMS`, and no administrative CLI commands. `/api/v1` changes in place because it has
  not been released yet.
