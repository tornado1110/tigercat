<!-- i18n-source: docs/operations.md @ 96cd4319b7c7d2ddfbad8368770a3c95a94ce5cc -->
> The Simplified Chinese version is authoritative. This translation may lag behind it. Machine-assisted translation; corrections are welcome.

# Operating TigerCat

[简体中文](../../operations.md) | [English](../en/operations.md) | [日本語](../ja/operations.md) | [한국어](../ko/operations.md) | [Español](../es/operations.md)

This page is the operator guide for the process that is in this repository
today. It does not add commands. If a command is not listed in `tigercat --help`,
it does not exist.

Nothing here has been run against a live DeepSeek account, Claude Code, Codex,
cc-connect, or Feishu. Those rows are marked unverified. Checks that CI runs
are marked tested.

## What is implemented

| Behavior | Status |
| --- | --- |
| `tigercat acp` speaks ACP on stdin/stdout | implemented; upstream conformance is `npm run test:tck` where that harness can run |
| Built-in `claude-code` and `codex` profiles | implemented; CI handshakes them with `test/stub-agent.ts`, not the vendor binaries |
| `runtime test` with no vendor binary | tested; dry-run agent, `vendorExecuted: false`, no API key read |
| `runtime test` with `TIGERCAT_CLAUDE_BIN` / `TIGERCAT_CODEX_BIN` or `TIGERCAT_RUNTIME_LIVE=1` | implemented; not run in CI and not run for this document |
| Scripted Router when `coordinator_runtime` is unset | tested with the in-process scripted brain |
| ACP Router process named by `coordinator_runtime` | implemented (`launchCoordinator`); not run against a real model |
| sqlite Threads, event log, and pending Router queue survive a new process | implemented in `Engine.start` |
| Worker ACP sessions survive a restart | when the downstream runtime advertises `loadSession` during `initialize` and `session/load` succeeds, the original ACP session id is restored and the Thread subscription stays. Otherwise the Worker is marked `lost` and a `worker.lost` event is recorded. Tested with the stdio stub, not against Claude Code or Codex |
| Orphan worker processes reaped on the next start | implemented. A recorded pid whose command line still matches that runtime is killed before recovery. Tested with the stdio stub. On Windows a process is killed only when its command line can be read and matches |
| Feishu or DingTalk inside TigerCat | not implemented; those channels stay in the host |
| DeepSeek Chat Completions Router (`router.provider = "deepseek"`) | implemented; reads `DEEPSEEK_API_KEY`; not live-tested |

## Layout

TigerCat is one foreground process. There is no `start`, `stop`, `restart`,
or service unit in this repository.

```bash
tigercat --help
tigercat --version
tigercat acp
tigercat acp --config /path/to/config.toml
```

`TIGERCAT_CONFIG` is the same override as `--config` when the flag is omitted.
The default file is `~/.tigercat/config.toml`. If that file is missing, built-in
defaults are used and nothing is written until `runtime add` or `runtime remove`.

The database is `TIGERCAT_DB`, or `tigercat.sqlite` in the same directory as the
config path. The default is `~/.tigercat/tigercat.sqlite`. Use one process per
database. This code opens `node:sqlite` directly and does not coordinate a
second writer.

[`examples/config.example.toml`](../../../examples/config.example.toml) is a scripted
demo. It does not name a Router executable. Copying it does not give you a
model. See [Scripted demo and real Router](#scripted-demo-and-a-real-router)
below.

`runtime list` prints name, command, args, permission, and whether the row is
a built-in. It does not print environment values.

`runtime discover` probes the current host's `PATH` and explicit
`TIGERCAT_CLAUDE_BIN`, `TIGERCAT_CODEX_BIN`, or `CODEX_PATH` overrides. It marks
only existing executable files as found and prints their absolute paths; it
does not run a vendor binary, access the network, or read an API key.
`runtime test` remains the command that performs a handshake.

## Credentials

With `router.provider = "deepseek"`, `tigercat acp` reads `DEEPSEEK_API_KEY` (or the configured env name) and exits before any request when that variable is missing. That call has not been live-tested. Worker credentials come from the documented vendor variables or the runtime's explicit `env` table.

Workers do not receive the host environment unchanged. TigerCat removes
inherited Router, plugin, Feishu, and cc-connect paths and tokens, as well as
secret-shaped variables; the documented vendor credentials (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CODEX_API_KEY`, `OPENAI_API_KEY`, and the corresponding
binary paths) remain available to built-in Workers. A runtime's own `env` table
is merged after this filter, so put only values that runtime really needs there;
they are written to `config.toml` in plaintext. A Worker cannot read the
Router's inherited `DEEPSEEK_API_KEY` or cc-connect's `CC_SESSION_KEY`.

Keep the three credential sets apart:

1. **Router.** `router.provider = "deepseek"` calls DeepSeek Chat Completions
   with the key from `DEEPSEEK_API_KEY`. That path has not been live-tested.
   Do not put the key in `config.toml`. Omitting `router.provider` keeps the
   scripted brain, which makes no model call. An ACP coordinator is still a
   separate program you install and name with `coordinator_runtime`. Do not
   set `router.provider` and `coordinator_runtime` together.
2. **Workers (`claude-code`, `codex`).** Both are built in with permission
   `ask`. Claude Code uses an existing `claude` login or `ANTHROPIC_API_KEY`.
   Codex uses `CODEX_API_KEY` or `OPENAI_API_KEY`. Those are the vendor
   programs' variables; TigerCat does not parse them. `TIGERCAT_CLAUDE_BIN` is
   forwarded as `CLAUDE_CODE_EXECUTABLE`. `TIGERCAT_CODEX_BIN` is forwarded as
   `CODEX_PATH`. To keep a Router key out of a Worker, do not export it in the
   inherited environment is filtered; pass any other credential explicitly in
   that runtime's `env` table and remember that it is written to the config in
   plaintext. Prefer each product's own login files.
3. **cc-connect and Feishu.** The host owns the channel. TigerCat's registration
   is only:

   ```toml
   type = "acp"
   cmd = "tigercat"
   args = ["acp"]
   ```

   Do not copy Feishu tokens into TigerCat config or into `runtime env`.
   `tigercat acp` records every upstream prompt with `source` `acp`. The first
   default rule admits `source = "acp"` as `respond`. A Feishu thread id is
   used only when the host sets `_meta.thread_id`; the source is still `acp`.
   A Feishu round-trip has not been run.

`runtime add --env K=V` writes the value into `config.toml` in plaintext.
That file is not a secret store. Leave `env` empty unless the value is a
non-secret path such as a vendor binary.

Built-in workers are `ask` in code. The sample adds no runtime row, so it
does not set `permission`. `runtime add --permission` accepts `ask`, `auto`,
or `deny`.

## Scripted demo and a real Router

These are different. The sample file is only the first one.

### Scripted demo

`coordinator_runtime` stays unset. `cmdAcp` then does not call
`launchCoordinator`. The Router is `ScriptedRouter` in this process. It spawns
the runtime named by `default_worker_runtime` and does not call a model.

The code default for that name is the string `worker`. That name is not a
built-in. With no config file, a trigger the scripted brain decides to spawn
fails with `unknown runtime worker`. The sample sets `default_worker_runtime`
to `claude-code`, which is a built-in.

The README checkout steps are:

```bash
npm install
npm run build
npm link
```

`bin/tigercat.js` loads `dist/cli.js`, so `npm run build` is required before
the command can start. `npm link` is what the README uses to put `tigercat` on
`PATH`. From the checkout, without linking:

```bash
node bin/tigercat.js --help
node bin/tigercat.js runtime list
node bin/tigercat.js acp
```

Copying the sample is optional. It still does not start a model:

```bash
mkdir -p ~/.tigercat
cp examples/config.example.toml ~/.tigercat/config.toml
tigercat runtime list
tigercat acp
```

`runtime list` then shows the built-ins `claude-code` and `codex`. It does not
show a Router command, because the sample does not add one. `tigercat acp`
stays in the foreground and speaks newline-delimited JSON-RPC on stdin and
stdout. With no `claude` binary and `TIGERCAT_RUNTIME_LIVE` unset, a worker
the scripted brain spawns as `claude-code` uses the dry-run agent. That path
reads no API key. It is still not a model.

### Real ACP Router

Prerequisite, not provided here: an ACP agent executable you installed and
configured yourself. This repository does not ship one, does not contain a
program named `router-acp`, and does not document how to install DeepSeek or
any other model.

When that program is already on the machine, register it with the command
`tigercat --help` already lists. The angle brackets are placeholders, not a
command to copy:

```bash
tigercat runtime add <name> --command <existing-acp-agent> --permission ask
```

Then set `coordinator_runtime` to `<name>` in the config file you actually
load. `tigercat acp` spawns that command. If the command is not found, startup
fails with `bad_runtime`. Do not write a placeholder into `config.toml` and
treat it as a working Router.

cc-connect, or any other ACP client, is the parent of `tigercat acp`. Logs and
ACP traffic share stdin and stdout. Do not pipe a secret into the prompt. The
host snippet in the README (`type = "acp"`, `cmd = "tigercat"`, `args =
["acp"]`) is not a file this repository loads, and a Feishu round-trip has not
been run. This page does not add cc-connect install steps.

## Start

`tigercat acp` is the foreground process. There is no daemon command.

`tigercat acp` uses `process.cwd()` as the workspace root. Worker directories
are created under that tree: `.tigercat/worktrees/<workerId>` inside a git
checkout, otherwise `.tigercat/workers/<workerId>`.

Check the built-ins before involving a model. With no `claude` or `codex` on
`PATH` and `TIGERCAT_RUNTIME_LIVE` unset, this does not read an API key:

```bash
tigercat runtime test claude-code
tigercat runtime test codex
```

The JSON report has `mode` `dry-run` and `vendorExecuted` false. A real adapter
launch is the manual command in `tigercat --help`. This document's tests did
not execute it.

## Stop

There is no stop subcommand.

A clean path is the ACP client closing stdin. `serveUpstream` then returns,
`engine.close()` asks each live worker handle to exit, and the IPC listener
and sqlite handle are closed.

That path also schedules `process.exit(0)` after 500ms, and again when the
upstream MCP clients have closed. Worker teardown is best-effort inside that
window. It is not a guaranteed drain.

SIGINT and SIGTERM have no handler in this code. On POSIX, worker processes
are spawned detached, so a signal that kills only the TigerCat process can
leave them behind. The next start looks at saved pids. An orphan whose
command line still matches that runtime is killed before recovery.

## Restart and recovery

Restart means: stop the foreground process, then run `tigercat acp` again on
the same config and database.

`Engine.start` then:

- leaves an existing Router session row in place, or inserts one
- returns in-flight Router queue rows to pending and sets `router_busy` to `0`
- for each non-terminal Worker, handles the recorded pid first. A live
  process whose command line still matches the runtime is killed. Then, if
  that runtime advertises `loadSession` and `session/load` succeeds, the
  original ACP session id is loaded in a new process, the Worker returns to
  `idle`, the Thread subscription stays, and the next event goes straight to
  that Worker. If there is no session id, the runtime does not advertise
  `loadSession`, or `session/load` fails, the Worker is marked `lost`, its
  subscriptions are dropped, and a `worker.lost` event is recorded. `code` is
  `lost`, `message` is `worker session could not be restored after restart`,
  and `reason` is `no_session`, `load_unsupported`, `load_failed`, or
  `session_mismatch`

Threads and the event log remain. The worktree directory is left on disk.
`removeWorkspace` exists and is not called on this path.

`interrupted` is still a legal state. Automatic recovery does not write it.
`resume` accepts `lost` and `interrupted`: it opens a new ACP session on the
existing worktree with the caller's new input. That is not `session/load`.

What does not happen:

- The upstream TigerCat agent still advertises `loadSession: false`.
  `runtime test` still reports `degraded: ["loadSession"]`, because that probe
  only does `session/new` and does not call `session/load`.
- A dead process is not left as `running` or `starting`. When the state is one
  of those two, the recorded pid has to be alive.
- A failed load does not quietly open a new ACP session. That is what
  `resume` does.

The one-shot commands `list`, `send`, `read`, `interrupt`, `wait`, `kill`,
`subscribe`, `unsubscribe`, and `spawn` open the same database and call
`Engine.start` themselves. Running `tigercat list` against a database that
still has non-terminal Workers restores the ones `session/load` can restore
and marks the rest `lost`, even if another `tigercat acp` still has them. Do
not point those commands at the database of a running process. There is no
read-only status command.

## Logging

Event payloads and CLI error text go through redaction before they are stored
or printed:

- exact values from runtime `env` whose names contain `key`, `token`,
  `secret`, `password`, or `credential`
- the same kind of variable from the parent environment, when the value is at
  least 8 characters and has no quote or brace
- the localhost IPC token passed to `tigercat mcp --token`
- `Authorization` bearer/basic/digest headers, `x-api-key` / `api_key`
  assignments, `NAME=value` for secret-like names, matching JSON fields, and
  `sk-` / `sk-ant-` / `sk-proj-` tokens

Provider stderr from a failed handshake is included in the `bad_runtime`
error only after that scrub. The unit tests use fixed fake strings such as
`fake-bearer-token-0001`. They do not call a provider.

Prompt text is stored as it was submitted. `trigger.ingested` does not copy
that text, but the trigger row and the Router queue do. Redaction does not
rewrite a prompt. A key pasted into a message is still in sqlite and can be
handed to the Router. Do not paste keys into prompts.

Limits, unverified against a live provider: a secret printed in a shape that
matches none of the above, a value shorter than 4 characters (8 for the parent
environment), or a value that contains a quote or brace can still appear. Do
not rely on redaction as the only control. Do not put keys in prompts, rule
text, or `config.toml`.

`runtime list` does not print `env`. The config file still contains it if you
wrote it.

## Troubleshooting

`runtime test` JSON `ok: false` with `mode: "dry-run"` means the dry-run
process failed, not that Claude Code or Codex rejected a key. `mode:
"adapter"` means this process launched the adapter. `vendorExecuted: false`
means the vendor binary was not run.

`unknown runtime <name>` means the name is neither a built-in nor a `command`
in the config file that was loaded. Check `--config` and `TIGERCAT_CONFIG`.

`max concurrency <n> reached` is `max_concurrency` in the config (default 4).
It counts Workers in `starting` or `running`.

After a crash, `tigercat list --json` will itself run recovery. A Worker that
can be loaded returns to `idle`; one that cannot is shown as `lost`. Start
`tigercat acp` only after that, or start `acp` directly and let it do the same
recovery. When `session/load` succeeds, the original ACP session id is still
there. When it fails, do not expect the old id to work.

If two `tigercat acp` processes were pointed at one sqlite file, stop both.
The code does not repair a database that two writers used.

Permission prompts stay on the Worker until something answers them. Nothing in
`tigercat acp` auto-answers a Worker `ask` policy. A stuck permission looks
like a Worker that never reaches `worker.turn_end`.

## Gaps in this tree

- No Router executable, and no install steps for one. The only Router that
  runs with nothing else installed is the in-process scripted brain.
- A DeepSeek Chat Completions Router is implemented (`router.provider = "deepseek"`, key from `DEEPSEEK_API_KEY`). It has not been live-tested. The scripted brain remains the default.
- The default worker runtime name `worker` is not a built-in.
- A restart tries downstream `session/load`. The stdio stub covers a
  successful load, a runtime that does not advertise `loadSession`, and a
  failed `session/load`. This has not been run against real Claude Code or
  Codex. SIGINT and SIGTERM still have no handler.
- `session.pid` is written after the worker handshake returns. This pull
  request does not change that, and it does not add a wait. A Windows test
  that reads the pid too early is a process-startup race for development.
- One `node:sqlite` handle per database. A second writer is not coordinated.
- Prompt text is stored as submitted.
- Live DeepSeek, Claude Code, Codex, cc-connect, and Feishu have not been run.
