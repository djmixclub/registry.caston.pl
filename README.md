# Serverless Registry – Worker

Serverless Registry is a private, serverless package registry for **Composer**, **npm**,
**cargo**, **NuGet**, **Swift**, **Maven** and arbitrary files, hosted entirely on your own
Cloudflare account (Workers, R2 and KV). This repository contains the Cloudflare Worker: it
serves the native read protocols of the package managers, the publishing and administration
API, and a small home page with an admin panel. Versions are published with the
[`sreg` CLI](https://github.com/kduma-OSS/serverless-registry-cli), usually from CI, and the
archives go straight to and from R2 through presigned URLs, never through the Worker.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kduma-OSS/serverless-registry-worker)

## Features

- **Seven ecosystems from one bucket**: Composer, npm, cargo (sparse index), NuGet (V3),
  Swift (package registry) and Maven/Gradle repositories, plus a generic JSON feed for
  arbitrary files such as binaries and installers. Enable only the ones you need.
- **Credentials with grants**: one named credential per consuming project, publishing
  pipeline or administrator, of exactly one kind (`read`, `publish` or `admin`), with grants
  on packages (`acme/*`) and version ranges in each ecosystem's own syntax. A `read` token is
  safe to commit into the consumer's repository.
- **Transitive access**: a `read` grant also opens the versions of this registry's packages
  that the granted versions depend on, computed from the declared constraints.
- **GitHub Actions OIDC**: pipelines publish (and install) with the job's OIDC token instead
  of a stored secret, matched on the repository, its IDs, the ref, the workflow and the
  environment.
- **Immutable versions**: a published version never changes; an admin can yank it (hidden
  from resolution, lockfiles keep working) or delete it.
- **Admin panel**: credentials, grants and secrets, packages and versions, settings and an
  update check, with no framework and no external resources.
- **Nothing to run**: one Worker, one R2 bucket and one KV namespace; the free plan is enough
  for a small team.

## Quick start

1. **Deploy.** Click the button above (or fork the repository and use the GitHub Actions
   workflow, or run `npm run deploy`). Cloudflare creates the Worker, the KV namespace and the
   R2 bucket from `wrangler.jsonc`.
2. **Configure.** In the Worker's **Settings** → **Variables and Secrets**, add `PUBLIC_URL`
   and `S3_ENDPOINT` (plain variables are fine) and, as secrets, `S3_ACCESS_KEY_ID` and
   `S3_SECRET_ACCESS_KEY` (an R2 API token scoped to the bucket) and `SESSION_SECRET`
   (`openssl rand -base64 48`); [`.dev.vars.example`](.dev.vars.example) lists them. Optional
   settings such as `ECOSYSTEMS` have defaults and are overridden there too; deploys keep
   everything set in the dashboard. Optionally add a custom domain.
3. **First run.** Open the registry in a browser, create the first admin and store its token,
   which is shown once. In the panel, create a `publish` credential for each package's
   pipeline (with a `gh` secret for GitHub Actions OIDC, or a key) and a `read` credential for
   each consumer.
4. **Publish** with [`sreg`](https://github.com/kduma-OSS/serverless-registry-cli#install):

   ```sh
   export REGISTRY_URL=https://packages.example.com
   export REGISTRY_TOKEN='ci-acme-sdk:…'
   sreg composer publish
   ```

   or, in GitHub Actions, with the
   [publish action](https://github.com/kduma-OSS/serverless-registry-publish-action):

   ```yaml
   - uses: kduma-OSS/serverless-registry-publish-action@v1
     with:
       ecosystem: composer
       registry: https://packages.example.com
   ```

The [deployment guide](docs/deployment.md) walks through every step, including the R2 API
token, the custom domain, updates, the free plan limits, backups and troubleshooting.

## Documentation

- [Deployment guide](docs/deployment.md) – deploying, configuring, updating and operating
  the registry.
- [Specification](docs/spec.md) – goals, architecture, data layout, protocols, deployment.
- [HTTP API contract](docs/api.md) – the `/api/v1` contract between the Worker and the CLI,
  and the generic, NuGet, Swift and Maven feeds.
- [`sreg` CLI](https://github.com/kduma-OSS/serverless-registry-cli) – installation,
  commands and publishing from CI.
- [Publish action](https://github.com/kduma-OSS/serverless-registry-publish-action) – the
  GitHub Action that installs `sreg` and publishes a package from a workflow.
- [Changelog](CHANGELOG.md) and [contributor guidelines](AGENTS.md).

## Landing page and admin panel

Opening the registry's address in a browser shows a small panel, rendered by the Worker
without any framework or external resource.

- **First run.** While the registry has no credential at all, the page offers to create the
  first admin: enter a project name and the Worker generates its token and shows it once.
  Or choose a password (twice, at least 12 characters) and log in with the project name as the
  login and that password. Store the token; the form never appears again.
- **Login.** Paste a token, or switch to "login and password" and enter the two sides of the
  token's colon. A signed session cookie keeps you signed in for 12 hours; "Log out" ends it.
- **Read credentials** see every package their grants cover in one list sorted by name, each
  row with an ecosystem badge, the number of versions and the latest version (marked when
  yanked); a filter bar narrows the list by name and ecosystem. A package's page
  (`/packages/<eco>/<name>`) lists its versions, the dependencies the grant opens (collapsed)
  and ready-to-paste client configuration for that package with copy buttons (collapsed, with
  a chooser between a command, files and environment variables); replace `<token>` in it with
  your token. A version's page lists its files with sizes and checksums, downloads them
  through a short-lived presigned link and shows how to install exactly that version.
- **Publish credentials** see a note that they publish with the `sreg` CLI.
- **Admin credentials** get three pages in the header:
  - _Packages_: the same list with "Reindex" and "Delete" on each row; a package's page also
    yanks or deletes its versions.
  - _Credentials_: every project in a table; a page per credential with the tabs Overview,
    Grants, Secrets (add `key` or GitHub Actions `gh` secrets, expire them) and Danger zone
    (delete it); a "New credential" form that shows the new token once.
  - _Settings_: the version, the variables and, unless `CHECK_UPDATES` is `false`, whether a
    newer release exists.

## Compatibility

The Worker and `sreg` are released independently. `sreg` sends its version in
`X-Client-Version`; the Worker answers every `/api/v1` request with the oldest client it
accepts in `X-Min-Client-Version` (also `minClientVersion` in `GET /api/v1/version`) and
rejects older clients with `426 client_too_old`, which `sreg` reports with exit code `3`.

- The Worker raises `minClientVersion` only after a `sreg` release that satisfies it exists:
  the CLI is released first, the publish action is released with it as its default `sreg`
  release (which moves the action's `v1` tag), and only then is the Worker released with the
  new minimum. Pipelines using `@v1` keep working; a pinned `sreg-version` has to be raised.
- After an incompatible change, the Worker keeps the previous API version (`/api/v1`) for at
  least one minor release.
- This release requires `sreg` 0.1.0 or newer.

See the CLI's [release process](https://github.com/kduma-OSS/serverless-registry-cli/blob/main/docs/releasing.md#client-and-worker-versions)
for the full rules.

## Development

```sh
npm install
npm run check   # type check
npm run lint    # eslint + prettier
npm test        # vitest inside the Workers runtime
npm run dev     # local Worker with wrangler
```

For `npm run dev`, copy `.dev.vars.example` to `.dev.vars` and fill in the values.

## Licence

[MIT](LICENSE)
