# Guidelines for contributors and AI agents

This repository contains the Cloudflare Worker of **Serverless Registry**: a private,
serverless package registry for Composer, npm and cargo hosted entirely on Cloudflare
(Workers, R2, KV). The companion command-line tool lives in the
`serverless-registry-cli` repository.

Read these before changing anything:

- `docs/spec.md` – the full product and architecture specification. It is the source of
  truth for behaviour; when code and spec disagree, fix the code or update the spec in the
  same change.
- `docs/api.md` – the HTTP contract between the Worker and the CLI (`/api/v1`). The CLI is
  developed against this document, so any change here must stay backwards compatible or
  bump the API version.

## Language

Everything in this repository is written in **English**: code, comments, identifiers,
commit messages, documentation, test names, error messages and UI strings. Do not add
text in any other language.

## Repository layout

```
src/
  index.ts              # fetch + scheduled entry points, routing by path prefix
  core/                 # ecosystem-agnostic kernel (auth, grants, presign, storage, publish, admin, cron, migrate)
  adapters/             # one module per ecosystem (composer, npm, cargo) implementing the Adapter interface
  pages/                # HTML rendering for the landing page and admin panel (template strings)
public/                 # static assets served through Workers Static Assets (CSS, minimal vanilla JS)
test/                   # vitest + @cloudflare/vitest-pool-workers tests and fixtures
docs/                   # specification, API contract, deployment guide
```

Design rules that must hold:

- The kernel never knows ecosystem formats; adapters never touch R2, KV or auth directly.
- Archive bytes never pass through the Worker. Uploads use presigned `PUT`, downloads
  are `302` redirects to presigned `GET` URLs.
- Indexes are derived from version manifests and can always be rebuilt from them.
- Every native-protocol response is `Cache-Control: private, no-store`.
- No framework, no bundler for the front-end, no external runtime dependencies in the
  panel. Keep the dependency list of the Worker itself minimal.
- Nothing installation-specific is committed (no account IDs, bucket IDs, domains).

## Tooling

```
npm install            # install dependencies
npm run check          # TypeScript type check
npm run lint           # eslint + prettier check
npm run format         # prettier write
npm test               # vitest (workers pool)
npm run dev            # wrangler dev
```

Before every commit run `npm run check`, `npm run lint` and `npm test`. A commit must
leave the tree green.

`package.json` has an `overrides` entry that makes `@cloudflare/vitest-pool-workers` use the
same `miniflare` (and therefore `workerd`) as `wrangler`. The pool pins an older `miniflare`
whose runtime rejects the compatibility date in `wrangler.jsonc`. Keep the override in step
with the `miniflare` version `wrangler` depends on when upgrading `wrangler`.

## Testing

- Unit-test every kernel module and every adapter. Adapters are tested against real
  fixtures (a real `composer.json`, a real npm tarball manifest, a real cargo index line).
- Integration tests go through the Worker's `fetch` handler with the Miniflare bindings
  provided by `@cloudflare/vitest-pool-workers`.
- Tests are deterministic: no network access, no real clocks (inject or fake `Date`).

## Git conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope)?: description`. Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`,
  `test`, `chore`, `build`, `ci`, `perf`, `revert`. Use the lower-case imperative mood and
  keep the subject under 72 characters.
- Scopes used here: `core`, `auth`, `grants`, `presign`, `storage`, `publish`, `admin`,
  `cron`, `migrate`, `composer`, `npm`, `cargo`, `pages`, `api`, `deps`, `ci`, `docs`.
- Make small, focused commits. One logical change per commit; a feature plus its tests is
  one commit, two unrelated features are two commits.
- **Never** add `Co-Authored-By` or `Claude-Session` trailers, or any other trailer. The
  `commit-msg` hook rejects both.
- Enable the hooks once per clone:

  ```
  git config core.hooksPath .githooks
  ```

- Do not rewrite published history. Do not force-push.

## Coding style

- TypeScript, strict mode, ES modules, no `any` unless justified with a comment.
- Prefer small pure functions; keep I/O at the edges (`storage.ts`, `auth.ts`).
- Secrets (tokens, hashes, presigned URLs) never appear in logs or error messages.
- Error responses are JSON `{ "error": "<code>", "message": "<human text>" }` for
  `/api/v1`; native protocol endpoints answer with the status codes their clients expect.
