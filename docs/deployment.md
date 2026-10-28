# Deploying Serverless Registry

This guide takes you from nothing to a working registry on your own Cloudflare account, and
then covers updates, the limits of the free plan, backups and troubleshooting. The
[specification](spec.md) ("Deployment, configuration and updates") describes the design behind
it; the [HTTP API contract](api.md) has the exact behaviour of every endpoint.

- [1. Before you start](#1-before-you-start)
- [2. Deploy the Worker](#2-deploy-the-worker)
- [3. What gets provisioned](#3-what-gets-provisioned)
- [4. Settings](#4-settings)
- [5. Custom domain](#5-custom-domain)
- [6. First run](#6-first-run)
- [7. Updating](#7-updating)
- [8. Cloudflare free plan limits](#8-cloudflare-free-plan-limits)
- [9. Backups](#9-backups)
- [10. Troubleshooting](#10-troubleshooting)

## 1. Before you start

You need:

- A **Cloudflare account**. The free plan is enough for a small team (see
  [section 8](#8-cloudflare-free-plan-limits)). R2 has to be enabled once in the dashboard
  (**R2 Object Storage** → **Overview**); Cloudflare may ask for a payment method even for the
  free tier.
- A **GitHub account** for the repository the registry is deployed from, and for publishing
  with GitHub Actions.
- Optionally, a **domain whose DNS is on Cloudflare**, e.g. `packages.example.com`. Without
  one the registry runs at `https://serverless-registry.<your-subdomain>.workers.dev`.
- The [`sreg` CLI](https://github.com/kduma-OSS/serverless-registry-cli#install) on your
  machine, or its [GitHub Action](https://github.com/kduma-OSS/serverless-registry-cli/blob/main/action/README.md)
  in your pipelines, to publish packages.

Nothing installation-specific is ever committed to the repository: account IDs, bucket
credentials, the domain and every secret live in the Cloudflare dashboard. That is what keeps
updates conflict-free ([section 7](#7-updating)).

## 2. Deploy the Worker

The same repository supports three ways to deploy. Pick one.

| Path                                                        | For whom                        | Deploys on                       |
| ----------------------------------------------------------- | ------------------------------- | -------------------------------- |
| [Deploy to Cloudflare button](#deploy-to-cloudflare-button) | most installations              | every push to your `main`        |
| [Fork + GitHub Actions](#fork-and-github-actions)           | those who prefer GitHub Actions | every push to your fork's `main` |
| [Local `npm run deploy`](#local-deploy)                     | developers and one-off installs | every time you run it            |

### Deploy to Cloudflare button

1. Open
   <https://deploy.workers.cloudflare.com/?url=https://github.com/kduma-OSS/serverless-registry-worker>
   (the button at the top of the [README](../README.md) links there) and sign in to
   Cloudflare.
2. Connect your GitHub account and choose a name for the repository Cloudflare creates for
   you. It is a copy of this repository in your account, not a fork.
3. Review the resources Cloudflare is about to create from `wrangler.jsonc`: the Worker
   `serverless-registry`, a KV namespace for the `AUTH` binding and the R2 bucket
   `serverless-registry`. **Keep the suggested names.** If you rename the bucket, the
   `R2_BUCKET_NAME` variable must be changed to the same name ([section 4](#4-settings)), and
   every renamed resource makes later updates harder.
4. The setup page also asks for the five installation settings listed in
   [`.dev.vars.example`](../.dev.vars.example) (`PUBLIC_URL`, `S3_ENDPOINT`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `SESSION_SECRET`) and stores them as secrets.
   [Section 4](#4-settings) explains each one; whatever you do not have yet (the R2 API token
   needs the bucket to exist), enter as a placeholder and replace it there after the deploy.
5. Leave the build settings at their defaults (`npx wrangler deploy`) and click **Create and
   deploy**.

<!-- screenshot: the Deploy to Cloudflare page with the repository name, the KV namespace and the R2 bucket -->

Cloudflare builds and deploys the Worker with Workers Builds and redeploys it on every push to
the `main` branch of the new repository. The registry is not usable yet: continue with
[section 4](#4-settings).

### Fork and GitHub Actions

The repository contains `.github/workflows/deploy.yml`, which runs `npx wrangler deploy` on
every push to `main` and on demand. In the upstream repository it skips itself because the
secrets below are not set.

1. **Fork** the repository on GitHub.
2. **Create a Cloudflare API token**: **My Profile** → **API Tokens** → **Create Token** →
   template **Edit Cloudflare Workers**. Limit it to your account (and, if you use a custom
   domain, to its zone). Make sure it includes **Workers KV Storage: Edit** and **Workers R2
   Storage: Edit**: the first deploy creates the KV namespace and the bucket.
3. **Find your account ID**: the **Account ID** shown on the account home page or on
   **Workers & Pages** → **Overview**.
4. In the fork, open **Settings** → **Secrets and variables** → **Actions** and add two
   repository secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. Open the **Actions** tab. GitHub disables workflows in new forks; enable them, then run
   **Deploy** with **Run workflow**.

<!-- screenshot: the fork's Actions secrets with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID -->

From now on, every push to the fork's `main` (including "Sync fork") deploys.

### Local deploy

With Node.js 22:

```sh
git clone https://github.com/kduma-OSS/serverless-registry-worker.git
cd serverless-registry-worker
npm ci
npx wrangler login
npm run deploy
```

`wrangler login` opens a browser to authorise Wrangler for your account. To update, check out
a newer release tag and run `npm ci` and `npm run deploy` again.

For local development, copy [`.dev.vars.example`](../.dev.vars.example) to `.dev.vars` (it is
ignored by git), fill in the values and run `npm run dev`. `.dev.vars` is read only by
`wrangler dev`; it is never deployed.

## 3. What gets provisioned

Everything comes from [`wrangler.jsonc`](../wrangler.jsonc). Its bindings carry no IDs:
Wrangler creates the resources on the first deploy and finds them by name afterwards.

| What                            | Name                                          | Used for                                                                               |
| ------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Worker                          | `serverless-registry`                         | the registry: native protocols, `/api/v1`, the home page and the panel                 |
| KV namespace, binding `AUTH`    | created by Wrangler                           | credentials, the `gh-repo:` index, `schema_version` and short-lived caches             |
| R2 bucket, binding `R2_BUCKET`  | `serverless-registry`                         | package files, version manifests, generated indexes, staging of uploads                |
| Static assets, binding `ASSETS` | `./public`                                    | the panel's stylesheet, script and icon                                                |
| Cron trigger                    | `0 * * * *`                                   | hourly cleanup: uploads that were never committed (after 24 hours) and expired secrets |
| `keep_vars: true`, no `vars`    | see [section 4](#where-settings-live)         | deploys keep the variables set in the dashboard; the defaults live in code             |
| Observability                   | enabled                                       | Workers Logs in the dashboard                                                          |
| `workers.dev` route             | `serverless-registry.<subdomain>.workers.dev` | the address until you add a custom domain                                              |

What is **not** provisioned, because it is specific to your installation, are the settings in
the next section.

## 4. Settings

### Where settings live

Every setting lives in the dashboard (**Workers & Pages** → `serverless-registry` →
**Settings** → **Variables and Secrets** → **Add**) or comes from `npx wrangler secret put
<NAME>`, never from a file of the repository. Five of them are needed:

| Name                   | Required           | Value                                                                           |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `PUBLIC_URL`           | yes                | the registry's address without a trailing slash, `https://packages.example.com` |
| `S3_ENDPOINT`          | yes                | `https://<account-id>.r2.cloudflarestorage.com`                                 |
| `S3_ACCESS_KEY_ID`     | yes                | access key ID of the R2 API token (below)                                       |
| `S3_SECRET_ACCESS_KEY` | yes                | secret access key of the R2 API token                                           |
| `SESSION_SECRET`       | yes, for the panel | a long random string (below)                                                    |

Add `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `SESSION_SECRET` with the type _Secret_.
`PUBLIC_URL` and `S3_ENDPOINT` are not confidential and may be plain _Text_ variables, so you
can read them back in the dashboard; secrets work too. The Worker reads both kinds the same
way, and both survive deploys (Workers Builds, the GitHub workflow or `npm run deploy`):
`wrangler.jsonc` sets `keep_vars: true` and has no `vars` of its own, so a deploy neither
deletes the variables set in the dashboard nor resets them.

<!-- screenshot: Settings → Variables and Secrets with the five settings added -->

With Wrangler, run each command and paste the value when asked (add `--name
serverless-registry` when you are not inside a checkout of the repository); this stores all
five as secrets:

```sh
npx wrangler secret put PUBLIC_URL
npx wrangler secret put S3_ENDPOINT
npx wrangler secret put S3_ACCESS_KEY_ID
npx wrangler secret put S3_SECRET_ACCESS_KEY
npx wrangler secret put SESSION_SECRET
```

If you use Workers Builds, do not put these under the build settings: build variables are
visible only to the build, not to the running Worker.

### R2 API token (`S3_*`)

Archives never pass through the Worker. It signs short-lived S3 URLs with which the CLI
uploads and package managers download straight from R2, and it needs an R2 API token for that.
Scope the token to the registry's bucket only:

1. **R2 Object Storage** → **Overview** → **Manage API tokens** → **Create API token** (an
   account token, so that it does not depend on your user).
2. **Permissions**: **Object Read & Write**.
3. **Specify bucket(s)**: **Apply to specific buckets only** → `serverless-registry`.
4. **TTL**: forever (or a date, if you want to rotate it; set a reminder).
5. **Create**. Copy the **Access Key ID** into `S3_ACCESS_KEY_ID`, the **Secret Access Key**
   into `S3_SECRET_ACCESS_KEY` and the S3 endpoint
   (`https://<account-id>.r2.cloudflarestorage.com`, without the bucket name) into
   `S3_ENDPOINT`. The secret access key is shown only once.

<!-- screenshot: creating the R2 API token with Object Read & Write on the serverless-registry bucket -->

A bucket created in a jurisdiction (for example the EU) has its own endpoint,
`https://<account-id>.eu.r2.cloudflarestorage.com`; use the endpoint shown on the bucket's
**Settings** page.

### `SESSION_SECRET`

`SESSION_SECRET` signs the panel's session cookies (HMAC-SHA256). Generate at least 48 random
bytes:

```sh
openssl rand -base64 48
# or
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"
```

Changing it signs everyone out of the panel; API tokens are not affected. Without it, the
panel login answers `500` naming the setting, while tokens keep working.

### `PUBLIC_URL`

`PUBLIC_URL` is the address clients use: it appears in indexes, download links and the
configuration snippets of the panel, and it is the audience every GitHub Actions OIDC token
must carry. Set it to the custom domain ([section 5](#5-custom-domain)) or to the
`workers.dev` address, with `https://` and without a trailing slash. Without it the Worker
falls back to the address of each request, but `gh` (OIDC) tokens are always rejected.

### Optional variables

These have defaults in the Worker's code that apply while the variable is not set. To change
one, add it in the dashboard as a plain _Text_ variable (**Settings** → **Variables and
Secrets**); to go back to the default, delete it. The panel's **Settings** tab shows these
variables as set in the dashboard, and for one that is not set the default the Worker uses,
marked "(default)".

| Variable              | Default                                        | Effect                                                                                                                              |
| --------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `R2_BUCKET_NAME`      | `serverless-registry`                          | bucket name in presigned URLs; must equal `bucket_name` of the `R2_BUCKET` binding                                                  |
| `ECOSYSTEMS`          | `composer,npm,cargo,generic,nuget,swift,maven` | enabled ecosystems; a disabled one answers `404` everywhere and disappears from listings and the panel                              |
| `MAX_UPLOAD_BYTES`    | `536870912` (512 MiB)                          | largest accepted file of a version                                                                                                  |
| `APPEND_WINDOW_HOURS` | `24`                                           | how long after publishing files may still be appended to a generic version                                                          |
| `TOKEN_PREFIX`        | empty                                          | a fixed prefix such as `srg_` in front of every issued token, so leaked tokens can be found with grep; existing tokens keep working |
| `CHECK_UPDATES`       | `true`                                         | the Settings tab compares the running version with the latest release on GitHub (once a day)                                        |

A value set in the dashboard stays in place across deploys and updates. Do not add a `vars`
block to `wrangler.jsonc` for this: Wrangler re-applies every value in `vars` on each deploy,
which would overwrite the dashboard and make updates conflict with your copy of the file.

## 5. Custom domain

Add the domain in the dashboard, not through `routes` in `wrangler.jsonc`:

1. **Workers & Pages** → `serverless-registry` → **Settings** → **Domains & Routes** →
   **Add** → **Custom domain**.
2. Enter the host name, e.g. `packages.example.com`. Its zone must be on Cloudflare;
   Cloudflare creates the DNS record and the certificate.
3. Set `PUBLIC_URL` to `https://packages.example.com` ([section 4](#public_url)).

<!-- screenshot: Settings → Domains & Routes → Add custom domain -->

The `workers.dev` address keeps working, but links the Worker generates use `PUBLIC_URL`, and
OIDC tokens must be requested for `PUBLIC_URL`. Publish and install through one address.

## 6. First run

### Create the admin

Open `PUBLIC_URL` in a browser. While the registry has no credential at all, the page offers
to create the first **admin**: enter a project name (e.g. `admin`) and the Worker generates
the token and shows it **once**. Store it in a password manager. The form never appears again,
and there is no password reset: consider creating a second `admin` credential for a colleague
or for a safe, because when every admin token is lost the only way back is editing KV by hand.

<!-- screenshot: the first-run form and the token shown once -->

Log in with the token (or switch to "login and password" and paste the two sides of its
colon). The admin sees three tabs: **Packages**, **Credentials** and **Settings**. Check that
**Settings** shows your `PUBLIC_URL` and the expected ecosystems.

### Credentials in short

Every credential is a project name with exactly one kind, a list of grants and one or more
secrets:

- `read` – installs packages; its `key` token is meant to be committed into the consumer's
  repository (`auth.json`, `.npmrc`, …).
- `publish` – publishes versions with `sreg`, usually from GitHub Actions; never reads.
- `admin` – the panel and the administrative API; no grants.

A grant is an ecosystem, a package name or `vendor/*` pattern and a version constraint in that
ecosystem's syntax (`*` for all). `read` grants are transitive by default: they also open the
versions of this registry's packages that the granted versions depend on. The token format is
`<project>:<secret>`; it works as Bearer, Basic and raw `Authorization` header.

### A publish credential for GitHub Actions (OIDC, no secret)

1. **Credentials** → **Create a credential**: project `ci-acme-sdk`, kind `publish`, grant
   `composer` / `acme/sdk` / `*`. The form creates a first `key` secret and shows its token;
   you do not need it for OIDC (expire it in the credential's **Secrets**).
2. **Add a secret** → **gh (GitHub Actions OIDC)**:
   - **Repository**: `acme/sdk`. **Look up** fills in the repository and owner IDs for a
     public repository; for a private one, enter them by hand (they protect against a
     deleted repository's name being taken again).
   - **Ref**: `refs/tags/v*`, and/or **Workflow**: `.github/workflows/release.yml`, so that
     only the release workflow can publish, not every pull request.
3. In the package's repository, publish on tags with the
   [publish action](https://github.com/kduma-OSS/serverless-registry-cli/blob/main/action/README.md):

   ```yaml
   on:
     push:
       tags: ["v*"]

   jobs:
     publish:
       runs-on: ubuntu-latest
       permissions:
         contents: read
         id-token: write
       steps:
         - uses: actions/checkout@v4
         - uses: kduma-OSS/serverless-registry-cli/action@v1
           with:
             ecosystem: composer
             registry: https://packages.example.com
   ```

   `registry` must be exactly `PUBLIC_URL`. Without a `token` input the action uses the job's
   OIDC token and the registry finds the project from the repository; when one repository
   has several matching `publish` credentials, name it with `oidc-project`.

<!-- screenshot: adding a gh secret with the repository, its IDs, the ref and the workflow -->

### A publish credential with a key

Outside GitHub Actions, or if you prefer a stored secret: create the `publish` credential as
above, copy the token shown once into a repository secret (e.g. `REGISTRY_PUBLISH_TOKEN`) and
pass it as `token: ${{ secrets.REGISTRY_PUBLISH_TOKEN }}` to the action, or as
`REGISTRY_TOKEN` to `sreg`.

### Read credentials for consumers

Create one `read` credential per consuming project (`shop-frontend`, grant `composer` /
`acme/*` / `*`), copy its token and give it to that project. Logging in to the panel with it
shows the packages it may install and ready-to-paste client configuration for each ecosystem.
For the consumer's own CI, add a `gh` secret for its repository and use
`sreg auth <eco> --oidc` there instead of committing anything (see the CLI's
[README](https://github.com/kduma-OSS/serverless-registry-cli#commands)).

<!-- screenshot: the consumer view with packages and configuration snippets -->

### Publish the first version

Install `sreg` ([install instructions](https://github.com/kduma-OSS/serverless-registry-cli#install))
and publish from a tagged checkout:

```sh
export REGISTRY_URL=https://packages.example.com
export REGISTRY_TOKEN='ci-acme-sdk:…'
git tag v1.0.0
sreg composer publish --dry-run   # the registry checks everything, nothing is uploaded
sreg composer publish
```

The version appears in the admin's **Packages** tab and, for credentials whose grants cover
it, in the consumer view.

## 7. Updating

Releases are tagged `vX.Y.Z` (semantic versioning). Read [`CHANGELOG.md`](../CHANGELOG.md)
before updating:

- Entries marked **Breaking** need something from you, e.g. a new required secret.
- Entries marked **Requires migration** change the data schema. You do not run anything: on
  the first request after the deploy, the Worker compares `schema_version` in KV with the
  version it expects and runs the missing migrations in order (they are small and
  idempotent). If a release changes an index format, it says so and asks for a reindex of
  the packages, which rebuilds them from the manifests.

The **Settings** tab shows the running version and data schema version and, unless
`CHECK_UPDATES` is set to `false`, whether a newer release exists.

How to update depends on the path you deployed with. You never edit files, and the settings in
the dashboard survive the deploy, so there is nothing to conflict:

- **Fork + GitHub Actions**: on GitHub, open your fork → **Sync fork** → **Update branch**. The
  push to `main` deploys. To follow releases rather than `main`, merge a release tag instead:

  ```sh
  git remote add upstream https://github.com/kduma-OSS/serverless-registry-worker.git
  git fetch upstream --tags
  git merge v0.2.0
  git push origin main
  ```

- **Deploy to Cloudflare button**: your repository is a copy, not a fork, so GitHub offers no
  "Sync fork". Merge a release tag as above; Workers Builds deploys the push. If Git refuses
  because the histories are unrelated (the copy may start from a fresh commit), merge the
  first time with `git merge --allow-unrelated-histories -X theirs v0.2.0`.
- **Local**: `git fetch --tags`, `git checkout v0.2.0`, `npm ci`, `npm run deploy`.

`sreg` and the Worker are released independently; see the [README](../README.md#compatibility)
for how their versions are kept compatible.

To roll back, use **Workers & Pages** → `serverless-registry` → **Deployments** (or
`npx wrangler rollback`), but only to a version that expects the same `schema_version`: a
migration is not undone by rolling back the code.

## 8. Cloudflare free plan limits

The registry is designed to run on the free plan for a small team. These are the limits that
matter (as of this release; check Cloudflare's current pricing pages):

| Resource              | Free plan                                            | What uses it                                                                     |
| --------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Worker requests**   | **100,000 a day**                                    | every request that reaches the Worker (below); this is the limit you reach first |
| KV reads              | 100,000 a day                                        | credential lookups, mostly absorbed by a 60-second cache in each Worker isolate  |
| KV writes and deletes | 1,000 a day each                                     | credential changes in the panel, the hourly cleanup and migrations (below)       |
| R2                    | 10 GB, 1 million writes and 10 million reads a month | uploads, downloads and index rebuilds; egress is free                            |
| CPU time              | 10 ms per request                                    | signature checks and index building; ample for metadata requests                 |

**What counts against the 100,000 requests a day.** Every metadata request of a package
manager (Composer's `packages.json` and one `p2` file per package, npm's packument per package,
one cargo index file per crate, the NuGet, Swift, Maven and generic feeds), every download
(the Worker answers with a redirect to R2, so each download is one Worker request plus one R2
read), every `/api/v1` call (a publish is two: `init` and `commit`) and every panel page or
form. Not counted: the transfers to and from R2 themselves, the panel's static files, and
requests answered from a client's own cache. A `composer install` of 20 private packages with
an empty cache is about 40 requests, so the daily limit is roughly 2,500 such installs.

Practical advice:

- **Cache package manager downloads in CI** (`actions/cache` or the setup actions' `cache:`
  option). A warm cache skips the download redirects, which are about half of the requests.
- **Enable only the ecosystems you use** (`ECOSYSTEMS`) – it does not save requests, but keeps
  the panel short and closes endpoints nobody needs.
- **Watch the usage** in **Workers & Pages** → **Overview** (requests) and **Storage &
  Databases** → **KV** (operations). When the daily request limit is used up, Cloudflare
  answers further requests with an error page until the counter resets at 00:00 UTC; installs
  and publishes fail in that time.
- KV writes come only from credential changes, the hourly cleanup of expired secrets and data
  migrations. The update check and the 60-second cache of the transitive dependencies of
  `read` credentials use the Cache API, and the dependency graph behind that cache is stored in
  R2, so installing and publishing write nothing to KV.

**When to move to Workers Paid.** A larger team, CI that installs many times an hour, or a
registry that serves public pipelines should switch the account to **Workers Paid** ($5 a
month: 10 million requests and 10 million KV reads a month included, 1 million KV writes, 30
seconds of CPU per request). Nothing in the registry changes; it is a billing setting of the
account (the **Workers plans** page of the dashboard). Paid is also the answer if commits of very large
files with extra digests (Maven's SHA-1 and MD5) fail with a CPU-time error on the free plan.

**D1.** The registry does not use D1. Moving credentials from KV to D1 (whose free plan allows
5 million row reads and 100,000 row writes a day) has been considered and is not planned; it
would only become worthwhile if the registry needed queries such as search or reports.

## 9. Backups

**R2 is the source of truth.** Each version is a `manifest.json` and its files under
`<eco>/pkg/<name>/<version>/`. Everything else in the bucket is derived from the manifests:
the indexes under `<eco>/index/`, `_meta/packages.json` and the dependency graphs
`_meta/deps/<eco>.json`. **The manifests are the only
durable data contract** – future releases may change index formats, but they will always read
the manifests.

- **Back up the bucket**, at least the `*/pkg/` prefixes, with any S3 tool and a read-only R2
  API token for the bucket, e.g. with [rclone](https://rclone.org/s3/#cloudflare-r2):

  ```sh
  rclone sync r2:serverless-registry ./registry-backup --exclude "_staging/**"
  ```

  Deleting a version or a package in the panel is permanent; R2 keeps no previous versions.

- **Back up the credentials** if recreating them would be painful. KV holds only hashes of
  secrets, so a backup cannot leak tokens, but restoring it saves redistributing new tokens.
  The `cred:<project>` keys are enough:

  ```sh
  # the namespace ID is shown in Storage & Databases → KV
  npx wrangler kv key list --namespace-id <id> --remote --prefix cred: > cred-keys.json
  npx wrangler kv key get --namespace-id <id> --remote cred:shop-frontend > cred-shop-frontend.json
  ```

  After restoring `cred:` keys into a namespace, delete its `schema_version` key: the
  migrations then run again on the next request and rebuild the `gh-repo:` index.

- **Restore** by copying the `<eco>/pkg/` prefixes back into the bucket and running
  **Reindex** for each package (the Packages tab, or
  `POST /api/v1/packages/<eco>/<name>/reindex` with an admin token for every package listed by
  `GET /api/v1/packages`). Reindex rebuilds the package's indexes from its manifests; a
  missing `_meta/packages.json` is rebuilt by the migrations as above.

## 10. Troubleshooting

Start with the Worker's logs: **Workers & Pages** → `serverless-registry` → **Logs**, or
`npx wrangler tail` while you reproduce the problem. Messages never contain secrets.

### `500` "Presigning is not configured: set … in the Worker settings."

Publishing (`init`) and every download need `S3_ENDPOINT`, `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY`; the message names the ones that are missing, or says that
`S3_ENDPOINT` is not an `http(s)` URL. Add them in **Settings** → **Variables and Secrets**
([section 4](#4-settings)), not among the build variables of Workers Builds, which the running
Worker does not see.

If the settings are present but the upload to R2 fails (`403` with `SignatureDoesNotMatch` or
`AccessDenied` from R2), check that the token has **Object Read & Write** on this bucket, that
`S3_ENDPOINT` is the account's endpoint (or the jurisdiction's) without the bucket name, and
that `R2_BUCKET_NAME` equals the bucket's real name.

### `500` "Sessions are not configured"

The panel login needs `SESSION_SECRET`. API tokens and package managers work without it.

### `401 unauthorized`

`401` means the credential could not be verified. A valid credential that lacks the right
kind or grant gets `403` instead, and a `read` credential asking for a package it has no grant
for gets `404`, so that it cannot learn which packages exist.

| Symptom                                                             | Likely cause                                                                                                                                                        | Fix                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| every request with the token fails                                  | token mistyped or truncated (no `:`), unknown project, secret expired or removed                                                                                    | check the token against the panel (Credentials → Secrets); issue a new `key`                                             |
| a token stops working at a known date                               | the secret had an `expires` date; the hourly cleanup removed it                                                                                                     | add a new secret before expiring the old one                                                                             |
| `gh` (OIDC) tokens always fail, `key` tokens work                   | `PUBLIC_URL` is not set, or differs from the `registry` URL the CLI requested the token for (the token's audience)                                                  | set `PUBLIC_URL`; use exactly the same URL (scheme, host, no trailing slash) in `REGISTRY_URL` / the action's `registry` |
| `gh` tokens fail for one repository                                 | the `gh` entry does not match the job: repository, its IDs (recreated or transferred repository), `ref` (branch vs. `refs/tags/v*`), `workflow` path, `environment` | compare the entry with the job; the workflow path is the file, e.g. `.github/workflows/release.yml`                      |
| "more than one project matches this token"                          | the `_` login found several credentials of the same kind with a matching `gh` entry                                                                                 | name the project: `oidc-project` in the action, `--oidc-project` / `--project` in `sreg`                                 |
| `_:gh.…` fails although an `admin` credential trusts the repository | `_` never resolves to an `admin` credential                                                                                                                         | use a `publish` or `read` credential for CI                                                                              |
| Basic authentication fails with a pasted token                      | the Basic login differs from the project in the pasted token                                                                                                        | use the project as login, or put the whole token in the password and the project in the login                            |
| a token with a `source.` prefix (`okta.project:…`)                  | external credential providers are not implemented yet                                                                                                               | use a credential stored in the registry                                                                                  |
| a change to a credential seems to be ignored                        | credentials are cached for up to 60 seconds per Worker isolate, and KV takes up to a minute to propagate                                                            | wait a minute                                                                                                            |

### `426 client_too_old` (exit code `3`)

The Worker requires a newer `sreg` than the one that sent the request; the message names the
minimum version. Update `sreg`, or the action (`@v1` picks up new releases; a pinned
`sreg-version` or full release tag must be raised). `sreg version --registry <url>` shows the
registry's version and the minimum client version it accepts.

### The update check shows nothing or fails

Unless `CHECK_UPDATES` is set to `false`, the Settings tab asks `https://api.github.com` for
the latest release at most once a day and caches a failure for an hour. The Worker needs
outbound access to `api.github.com` for this, and so does the **Look up** button for
repository IDs. GitHub limits anonymous API calls per IP address, and Workers share their
outbound addresses, so an occasional failure is normal; it is retried after the hour. Set
`CHECK_UPDATES=false` to turn the check off. GitHub Actions OIDC verification separately fetches GitHub's signing keys from
`token.actions.githubusercontent.com`.

### Other errors

- `413 payload_too_large` when publishing: a file is larger than `MAX_UPLOAD_BYTES`.
- `409 version_exists`: versions are immutable. Publish a new version, or pass
  `--skip-existing` (the action's default) to make re-runs succeed.
- `500` "Data migration failed; try again later.": a migration could not finish (usually a
  temporary KV error). The next request retries it; check the logs if it persists.

**Migration 3 on a large registry.** Migration 3 builds the dependency graphs
`_meta/deps/<eco>.json` by reading every version manifest in the bucket within the single
request that runs the migrations. A Worker request may make only a limited number of calls to
R2, so on a registry with more than roughly a thousand versions the migration can fail with
the `500` above on every attempt. Run the upgrade while the bucket holds fewer manifests – for
example deploy it before importing a large backup, or temporarily move the `<eco>/pkg/`
prefixes of rarely used ecosystems aside, let one request migrate, move them back and run
**Reindex** for their packages – or open a support issue in the Worker's repository.
