# Contributing to TigerCat

Thanks for helping with TigerCat. This document covers how to set up a
checkout, how commit messages must be written, and how to open a pull request.

## Development setup

TigerCat runs on Node.js 22.13 or newer (see `engines` in `package.json`).
If the repository contains an `.nvmrc` file, use it to select that Node version.

```bash
git clone https://github.com/tornado1110/tigercat.git
cd tigercat
npm ci
```

Before you open a pull request, run:

```bash
npm run lint
npm run typecheck
npm test
```

Run `npm run build` as well when you change code that the build compiles.

What those commands cover is documented in [TESTING.md](TESTING.md). Real-agent
end-to-end tests are not run in CI, because they need paid API keys. That
document describes what CI runs instead. Do not put API keys in the repository
or in a pull request.

## Commit messages

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
[Release Please](RELEASING.md) reads them to maintain `CHANGELOG.md` and to open
the release pull request. A commit that does not follow the convention is left
out of the changelog and does not bump the version.

Use this shape:

```text
<type>[optional scope][!]: <short summary>

[optional body]

[optional footer]
```

The summary is imperative, lowercase, and has no trailing period.

| Type | When to use it | Version bump |
| --- | --- | --- |
| `feat` | A user-visible capability | minor (`0.1.0` to `0.2.0`) |
| `fix` | A bug fix | patch (`0.1.0` to `0.1.1`) |
| `feat!` or a `BREAKING CHANGE:` footer | A breaking change | minor while the version is `0.x`; major from `1.0.0` |
| `docs`, `test`, `chore`, `ci`, `refactor`, `perf`, `build` | Everything else | none, unless the commit is marked breaking |

Examples:

```text
feat: route a stalled task to another ACP runtime

fix(client): retry a worker session that closed before the first event

docs: describe the permission ask default
```

While the package is still `0.x`, a breaking change bumps the minor version
rather than jumping to `1.0.0`. Say so in the footer anyway:

```text
feat!: drop the legacy session id field

BREAKING CHANGE: session ids from 0.1 are not accepted.
```

## Pull requests

1. Branch from the latest `main`.
2. Keep the change focused. One pull request, one purpose.
3. Use Conventional Commits for every commit. If the pull request is squash
   merged, the title has to be a Conventional Commit, because that title
   becomes the commit on `main`.
4. Run `npm run lint`, `npm run typecheck`, and `npm test`. Fill in the pull
   request template, including how you tested.
5. Do not commit secrets, tokens, `.env` files, or logs that contain them.
6. Wait for review. Do not merge your own pull request unless you are a
   maintainer and the repository rules allow it.

Maintainers merge release pull requests opened by Release Please. Contributors
do not publish to npm. See [RELEASING.md](RELEASING.md).

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).
Do not file a public issue for a security report, and never paste a secret into
an issue, pull request, or discussion.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you agree to it.
