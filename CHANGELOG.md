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
