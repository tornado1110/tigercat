# Security policy

## Reporting a vulnerability

Report security vulnerabilities privately with
[GitHub Private Vulnerability Reporting](https://github.com/tornado1110/tigercat/security/advisories/new).

Please do not open a public issue, discussion, or pull request for a suspected
vulnerability. Give the maintainers time to confirm and fix it before any
public write-up.

Never post secrets in issues, pull requests, commits, logs, or discussions.
That includes API keys, tokens, passwords, session cookies, and private
endpoints. If a secret has already leaked, revoke it first, then report the
exposure through the private channel above.

## Supported versions

TigerCat is pre-1.0. Security fixes go into the latest release only.

## Security model

TigerCat coordinates worker agents. It is not a store for credentials, and it
does not edit a checkout itself.

1. API keys and tokens are supplied via environment variables or the runtime's
   own auth. They are never committed. Error text and event payloads are
   redacted before they are printed or stored; the patterns and the cases
   they do not cover are in [docs/operations.md](docs/operations.md).
   `config.toml` is not a secret store.
2. Credentials must never enter a model's context: not in coordinator prompts,
   worker prompts, tool results, or event summaries.
3. Worker permission requests default to `ask`. TigerCat does not auto-approve
   them by default.
4. The coordinator cannot modify code directly. It only dispatches work to
   worker agents.
