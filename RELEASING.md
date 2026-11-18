# Releasing TigerCat

Releases are cut by [Release Please](https://github.com/googleapis/release-please)
from [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) on
`main`. Maintainers do not tag releases or edit `CHANGELOG.md` by hand.

The workflow is `.github/workflows/release.yml`. It does two things:

1. On every push to `main`, Release Please opens or updates a release pull
   request that bumps the version in `package.json`, updates `CHANGELOG.md`,
   and (when that pull request is merged) creates the git tag and GitHub
   Release.
2. In that same workflow run, if a release was just created, the package is
   published with `npm publish --provenance --access public`.

Publishing stays in this workflow on purpose. GitHub does not start a new
workflow from a release that the default `GITHUB_TOKEN` created, so a separate
"on release created" workflow would never run.

## What contributors do

Write Conventional Commits, as described in [CONTRIBUTING.md](CONTRIBUTING.md).

| Commit | Version change while `0.x` | Version change from `1.0.0` |
| --- | --- | --- |
| `fix:` | patch | patch |
| `feat:` | minor | minor |
| `feat!:` or `BREAKING CHANGE:` | minor | major |
| `docs:`, `test:`, `chore:`, `ci:`, `refactor:`, `perf:`, `build:` | none | none |

`docs`, `chore`, and the other non-release types do not bump the version.
The manifest in `.release-please-manifest.json` is the current released
version. The initial value is `0.0.0`, which must match `version` in
`package.json` before the first release. After that, only the release pull
request changes either file.

Merging the release pull request is the release. Its title is
`chore: release <version>`, which does not open another release.

## One-time maintainer setup

Do this once, before the first real release. Nothing in the repository contains
a token.

### 1. Let GitHub Actions open the release pull request

Repository **Settings → Actions → General → Workflow permissions**:

- Select **Read and write permissions**. A repository locked to read-only
  ignores the `contents: write` permission in `release.yml`, and Release Please
  cannot tag a release.
- Enable **Allow GitHub Actions to create and approve pull requests**. Without
  this, Release Please cannot open the release pull request.

The workflow uses the default `GITHUB_TOKEN` only. Do not create a personal
access token for it. One consequence: the release pull request and the GitHub
Release do not themselves start other workflows, including CI. The commits in
the release were already tested on their own pull requests, and the publish
job runs `npm test` on the tagged tree before `npm publish`. If publishing
fails, use **Re-run failed jobs** on that workflow run. Re-running the whole
workflow will not publish again, because the release already exists.

### 2. Publish to npm with trusted publishing

Preferred path: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC). The publish job requests `id-token: write`. It reads `NPM_TOKEN` only
for the fallback in the next section. Trusted publishing needs npm CLI 11.5.1
or newer and Node.js 22.14 or newer. The workflow selects the current Node 22
release on the GitHub-hosted runner, which meets that requirement. Self-hosted
runners cannot use trusted publishing.

Open the `tigercat` package settings on npmjs.com and add a trusted publisher.
If the package does not exist yet, publish it once with the token fallback,
add the publisher, then delete the `NPM_TOKEN` secret.

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `tornado1110` |
| Repository | `tigercat` |
| Workflow filename | `release.yml` |
| Environment name | leave empty |
| Allowed actions | include direct `npm publish` |

Enter the filename only: `release.yml`. It is case-sensitive. Leave the
environment empty. The publish job does not set a GitHub Actions environment,
and a mismatch rejects the OIDC token.

Publishers created after 3 September 2026 default to staged publish
(`npm stage publish`) and do not allow `npm publish` until you select it. This
workflow runs `npm publish`. Staged publishing is stricter, because a
maintainer approves each tarball, but it needs a different command. Do not
turn direct publish off unless you also change `release.yml`.

npm does not check the form when you save it. A new publisher expires if this
workflow does not publish successfully within two days. Create the publisher
when a release is about to be merged.

`package.json` must include a `repository.url` for this repository. The usual
value is `git+https://github.com/tornado1110/tigercat.git`. npm rejects the
publish when that field does not match. The package manifest is owned by the
code skeleton; this change does not edit it.

Provenance is attached automatically when trusted publishing ships a public
package from this public repository. The workflow also passes `--provenance`,
which the token fallback needs in order to attach the same attestation.
`--access public` publishes the unscoped package as public.

### 3. Token fallback, only if trusted publishing cannot be used

If trusted publishing is unavailable, create a granular npm access token that
can publish `tigercat` (and can bypass 2FA, which npm requires for publish
automation). Store it as an Actions secret named `NPM_TOKEN` on
`tornado1110/tigercat`. **Settings → Secrets and variables → Actions → New
repository secret.**

When `NPM_TOKEN` is set, `release.yml` uses it as `NODE_AUTH_TOKEN`. npm tries
OIDC first and falls back to that token if trusted publishing is not
configured. When the secret is unset, nothing is written into the environment
and the job uses OIDC only. Do not set `NPM_TOKEN` once a trusted publisher is
in place. Never commit the token, and never put it in the workflow file.

### 4. Private vulnerability reporting

**Settings → Code security → Private vulnerability reporting → Enable.**
`SECURITY.md` and `CODE_OF_CONDUCT.md` send people to
`https://github.com/tornado1110/tigercat/security/advisories/new`, which stays
unavailable until this switch is on.

### 5. Branch protection on `main`

Use a ruleset or classic branch protection so releases only come from reviewed
pull requests:

- Require a pull request before merging.
- Require the code skeleton's CI checks, and CodeQL once it is uploading
  results.
- Do not require the Release workflow as a pull request check. It only runs on
  pushes to `main`.
- Keep Release Please from bypassing review: a maintainer merges the release
  pull request.

Dependabot also needs pull requests to be allowed from GitHub Actions, which
is the same checkbox as in step 1.

## What the workflow expects from the package

`release.yml` skips Release Please until `package.json` exists. Publishing runs
`npm ci` against `package-lock.json`, then `npm run build` and `npm test` when
those scripts exist, then `npm publish`. The runner uses current Node.js 22,
which must be at least 22.14 for trusted publishing and must satisfy
`engines.node`. The code skeleton owns those files; this document does not.
