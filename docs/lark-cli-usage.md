# Local `lark-cli` capability

TigerCat can expose a narrowly scoped local `lark-cli` capability to a router or plugin. The capability is optional: coding tasks do not need a Feishu account, and this adapter never performs login or sends a message by itself.

```ts
import { LocalLarkCli } from "tigercat";

const lark = new LocalLarkCli({
  accountRef: "cli_aae2978b01385be4",
  profileRef: "work-feishu",
  credentialHome: "/var/lib/tigercat/lark/work-feishu",
  credentialRevision: "app-secret-revision-2026-11-20",
});

const auth = await lark.status();
if (auth.status === "ready" || auth.status === "refreshable") {
  const skills = await lark.discover("lark-im");
  // Build a command from trusted application code and the discovered contract.
  const result = await lark.execute({
    args: ["im", "messages", "list", "--chat-id", "oc_example"],
    effect: "read",
    expectedRevision: "app-secret-revision-2026-11-20",
  });
}
```

`LocalLarkCli` uses the installed binary (default: `lark-cli`), probes against the DeerFlow-compatible `1.0.82` baseline, and allows newer patch releases in the same `1.0` minor by default. Pass `versionPolicy: "exact"` when the host must pin exactly `1.0.82`.

Every invocation receives the constructor's fixed `--profile`, a private `HOME` and XDG directory set, and an argv array with shell execution disabled. Callers cannot replace the profile, identity, credential path or revision through business arguments. The adapter reads no credential files and never returns token material; diagnostics are redacted before they are returned.

Authentication status is based only on the user identity: `ready`, `refreshable` (the CLI reports `needs_refresh`), `missing`, or `unavailable`. A missing user authorization is distinct from an app-level scope problem, a missing user scope, and an ACL denial. The host decides how to request authorization; this layer does not run `login`.

Writes are one-shot. A timeout, output truncation, or unparseable response returns `outcome_unknown` and is never retried automatically. Read failures are classified as `ambiguous_failure` when the CLI cannot provide an explicit error. Callers should surface that state instead of guessing whether a mutation happened.

For a Codex plugin, keep the binding in host-owned configuration and pass only business arguments to the tool. A profile or credential home is not an account-discovery mechanism: each account/profile should have its own credential home and a revision that changes whenever its app credentials or identity binding changes.

The plugin also exposes a structured `lark_api` capability for Open API calls. It accepts `GET`, `POST`, `PUT`, `PATCH` or `DELETE` and an absolute `/open-apis/...` path, then converts the request to argv internally. Query strings, shell syntax, profile flags and credential-like fields in `params`/`data` are rejected before the CLI starts. `GET` is read-only; every other method goes through the same host elicitation gate as `lark_execute`.

For local contract tests, set `TIGERCAT_LARK_MOCK=1`. The plugin then uses deterministic in-process fixtures for status, skill discovery, read operations and approved writes. It ignores `TIGERCAT_LARK_BIN`, never starts a process, and still requires the host's elicitation response before a write. This mode is intended for MCP integration tests and demos, not for authorization or production data.

