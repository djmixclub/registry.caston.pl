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
