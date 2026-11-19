# Operating TigerCat

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
| Worker ACP sessions survive a restart | not implemented; `loadSession` is advertised as false |
| Orphan worker processes reaped on the next start | not implemented |
| Feishu or DingTalk inside TigerCat | not implemented; those channels stay in the host |
| A built-in DeepSeek runtime or `DEEPSEEK_API_KEY` reader | not implemented |

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

[`examples/config.example.toml`](../examples/config.example.toml) is a scripted
demo. It does not name a Router executable. Copying it does not give you a
model. See [Scripted demo and real Router](#scripted-demo-and-a-real-router)
below.

`runtime list` prints name, command, args, permission, and whether the row is
a built-in. It does not print environment values.

## Credentials

TigerCat does not log in to a provider and does not read a DeepSeek variable.
Keys are whatever the child process already has.

The child environment is the parent environment plus that runtime's `env`
table. A variable exported in the shell that starts `tigercat acp` is visible
to the Router process and to every Worker. An `env` entry adds a variable for
that runtime; it does not remove variables inherited from the parent. There is
no per-runtime secret sandbox. That isolation has not been verified with live
processes.

Keep the three credential sets apart:

1. **Router (DeepSeek or any other model).** There is no built-in DeepSeek
   runtime and no `DEEPSEEK_API_KEY` reader. A real Router is an ACP agent you
   already installed outside this repository. This page has no install command
   for that agent. Register the command you already have with `runtime add`,
   then set `coordinator_runtime` to that runtime's name. Give that agent its
   own credential in its own login or in an environment that is not the Worker
   environment. Do not put the key in `config.toml`. Omitting
   `coordinator_runtime` keeps the scripted brain, which makes no model call.
2. **Workers (`claude-code`, `codex`).** Both are built in with permission
   `ask`. Claude Code uses an existing `claude` login or `ANTHROPIC_API_KEY`.
   Codex uses `CODEX_API_KEY` or `OPENAI_API_KEY`. Those are the vendor
   programs' variables; TigerCat does not parse them. `TIGERCAT_CLAUDE_BIN` is
   forwarded as `CLAUDE_CODE_EXECUTABLE`. `TIGERCAT_CODEX_BIN` is forwarded as
   `CODEX_PATH`. To keep a Router key out of a Worker, do not export it in the
   parent environment. Prefer each product's own login files over putting keys
   in `runtime add --env`.
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
leave them behind. The next start does not look at saved pids and does not
kill them.

## Restart and recovery

Restart means: stop the foreground process, then run `tigercat acp` again on
the same config and database.

`Engine.start` then:

- leaves an existing Router session row in place, or inserts one
- returns in-flight Router queue rows to pending and sets `router_busy` to `0`
- marks every non-terminal Worker `interrupted`, drops its subscriptions, and
  records `worker.error` with `worker process was not alive after restart`

Threads and the event log remain. The worktree directory is left on disk.
`removeWorkspace` exists and is not called on this path.

What does not happen:

- `session/load` is not called. The upstream agent advertises `loadSession: false`.
  `runtime test` reports `degraded: ["loadSession"]`. A Worker cannot resume
  the previous ACP session.
- Saved pids are not reaped.
- A Worker that was mid-turn is not resumed. Its Thread goes back through the
  Router because the subscription was released.

The one-shot commands `list`, `send`, `read`, `interrupt`, `wait`, `kill`,
`subscribe`, `unsubscribe`, and `spawn` open the same database and call
`Engine.start` themselves. Running `tigercat list` against a database that
still has non-terminal Workers marks those Workers interrupted, even if
another `tigercat acp` still has them. Do not point those commands at the
database of a running process. There is no read-only status command.

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

After a crash, `tigercat list --json` will itself run recovery and the Workers
will show `interrupted`. Start `tigercat acp` only after that, or start `acp`
directly and let it do the same recovery. Do not expect the old ACP session
ids to work.

If two `tigercat acp` processes were pointed at one sqlite file, stop both.
The code does not repair a database that two writers used.

Permission prompts stay on the Worker until something answers them. Nothing in
`tigercat acp` auto-answers a Worker `ask` policy. A stuck permission looks
like a Worker that never reaches `worker.turn_end`.

## Gaps in this tree

- No Router executable, and no install steps for one. The only Router that
  runs with nothing else installed is the in-process scripted brain.
- No DeepSeek client and no `DEEPSEEK_API_KEY` handling.
- The default worker runtime name `worker` is not a built-in.
- `session/load` is off. A restart does not resume a Worker ACP session and
  does not reap saved pids. SIGINT and SIGTERM have no handler.
- `session.pid` is written after the worker handshake returns. This pull
  request does not change that, and it does not add a wait. A Windows test
  that reads the pid too early is a process-startup race for development.
- One `node:sqlite` handle per database. A second writer is not coordinated.
- Prompt text is stored as submitted.
- Live DeepSeek, Claude Code, Codex, cc-connect, and Feishu have not been run.
