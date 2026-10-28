# Serverless Registry – Worker

> **Work in progress.** Nothing here is ready for production use yet.

Serverless Registry is a private, serverless package registry for **Composer**, **npm** and
**cargo**, hosted entirely on Cloudflare (Workers, R2, KV). This repository contains the
Cloudflare Worker: it serves the native read protocols of the three ecosystems, the
publishing and administration API, and a small home page with an admin panel.

- Versions are published with the `sreg` CLI (repository `serverless-registry-cli`), usually
  from CI; native `npm publish` and `cargo publish` are not supported.
- Archives never pass through the Worker: uploads and downloads use presigned R2 URLs.
- Access is controlled by named per-project credentials with grants on packages and version
  ranges.

## Documentation

- [Specification](docs/spec.md) – goals, architecture, data layout, protocols, deployment.
- [HTTP API contract](docs/api.md) – the `/api/v1` contract between the Worker and the CLI.
- [Contributor guidelines](AGENTS.md) – repository layout, tooling and conventions.

A step-by-step deployment guide will follow.

## Landing page and admin panel

Opening the registry's address in a browser shows a small panel, rendered by the Worker
without any framework or external resource.

- **First run.** While the registry has no credential at all, the page offers to create the
  first admin: enter a project name and the Worker generates its token and shows it once.
  Store it; the form never appears again.
- **Login.** Paste a token, or switch to "login and password" and enter the two sides of the
  token's colon. A session cookie keeps you signed in for 12 hours; "Log out" ends it.
- **Read credentials** see the packages their grants cover, grouped by ecosystem, with the
  versions they may install (yanked ones marked) and, collapsed under each package, the
  dependencies the grant opens. Each ecosystem has ready-to-paste client configuration with
  copy buttons; replace `<token>` in it with your token.
- **Publish credentials** only see a note that they can publish with the `sreg` CLI.
- **Admin credentials** get three tabs: _Packages_ (yank, delete a version, reindex, delete a
  package), _Credentials_ (create credentials with grants, edit grants, add `key` or GitHub
  Actions `gh` secrets, expire secrets, delete projects) and _Settings_ (version, variables
  and, with `CHECK_UPDATES=true`, whether a newer release exists).

## Development

```sh
npm install
npm run check   # type check
npm run lint    # eslint + prettier
npm test        # vitest inside the Workers runtime
npm run dev     # local Worker with wrangler
```

## Licence

[MIT](LICENSE)
