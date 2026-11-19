# TigerCat

A Super-agent router for coding agents: one resident ACP router that dispatches work to Claude Code, Codex, or any ACP agent.

TigerCat sits on the [Agent Client Protocol](https://agentclientprotocol.com). Upstream it **is** an ACP agent (`tigercat acp`), so hosts such as cc-connect or Zed can drive it. Downstream it is an ACP client that launches Workers on any registered ACP runtime. Feishu and DingTalk stay in those hosts; TigerCat does not implement IM channels.

It is not a subagent tool. A resident Router only routes and talks to the human. Workers own one task each, subscribe to Threads, and report back to the Router.

This repository is a week-1 feasibility skeleton. It is not a completed M0. Real Claude Code / Codex sessions, a Feishu round-trip, a real model as the Router, and proof that a vendor harness has no native shell or edit tools are all still unverified. CI drives the `claude-code` and `codex` profiles through the stdio stub. The manual commands for a real binary are below. TigerCat's own MCP catalog omitting those tools does not say anything about the tools a downstream agent ships itself. Cross-channel and shared-PR ingress are M1, not this skeleton.

## Quickstart

Requires Node.js 22.13 or newer.

```bash
npm install
npm run build
npm link

tigercat runtime list
tigercat runtime test claude-code
tigercat runtime test codex
```

`claude-code` and `codex` are built in. `runtime test` runs `initialize`, `session/new`, and `session/prompt`.

With no `claude` or `codex` binary, and with `TIGERCAT_RUNTIME_LIVE` unset, that test handshakes a local dry-run agent. The report has `mode: "dry-run"` and `vendorExecuted: false`. Claude Code and Codex are not started, and no API key is read.

A real run, once the binary is installed:

```bash
TIGERCAT_CLAUDE_BIN="$(command -v claude)" tigercat runtime test claude-code
TIGERCAT_CODEX_BIN="$(command -v codex)" tigercat runtime test codex
```

`TIGERCAT_CLAUDE_BIN` is forwarded as `CLAUDE_CODE_EXECUTABLE`. `TIGERCAT_CODEX_BIN` is forwarded as `CODEX_PATH`. Claude Code uses an existing `claude` login or `ANTHROPIC_API_KEY`. Codex uses `CODEX_API_KEY` or `OPENAI_API_KEY`. On a headless machine set `NO_BROWSER=1` so Codex does not open a ChatGPT login.

The adapters also bundle a CLI. `TIGERCAT_RUNTIME_LIVE=1` launches that adapter when the vendor binary is not on `PATH`. That downloads the package and talks to the vendor, so it needs credentials:

```bash
TIGERCAT_RUNTIME_LIVE=1 tigercat runtime test claude-code
TIGERCAT_RUNTIME_LIVE=1 tigercat runtime test codex
```

| Runtime | Package | Version | Bin |
|---|---|---|---|
| `claude-code` | `@agentclientprotocol/claude-agent-acp` | 0.108.0 | `claude-agent-acp` |
| `codex` | `@agentclientprotocol/codex-acp` | 2.7.0 | `codex-acp` |

Versions were pinned from the npm registry on 2026-11-18. `claude-code` is started with `CLAUDE_AGENT_ACP_PROTOCOL=v1` so the session stays on the stable v1 lifecycle this client implements (`session/new`, `session/prompt`, `session/cancel`). An adapter you already installed replaces `npx`:

```bash
TIGERCAT_CLAUDE_CODE_ACP=/usr/local/bin/claude-agent-acp tigercat runtime test claude-code
TIGERCAT_CODEX_ACP=/usr/local/bin/codex-acp tigercat runtime test codex
```

`runtime add` with the same name overrides a built-in. Either name can be `coordinator_runtime`. The Router tool list is still only spawn, list, send, read, interrupt, wait, kill, subscribe, and unsubscribe.

`coordinator_runtime` names an ACP agent you installed yourself. This repository does not ship that program. Leave the field unset to keep the scripted brain; see [docs/operations.md](docs/operations.md). The admission policy is `examples/rules.default.toml`, currently version `2026-11-18.1`. Explicit whole-message chatter (`thanks`, `lol`, `morning`) is `ignore` and makes zero Router calls. Unknown natural language such as `Morning all` or `coffee break` is `candidate` when nobody is subscribed, and a clarification on an already subscribed Thread is `respond` to that Worker. Candidates are not rewritten to `ignore`.

```bash
tigercat acp
```

## DeepSeek as the Router

`router.provider = "deepseek"` replaces the scripted brain with DeepSeek Chat Completions (`POST {base_url}/chat/completions`, `Authorization: Bearer $DEEPSEEK_API_KEY`, model `deepseek-flash`, thinking disabled). The Router may call only `spawn`, `list`, `send`, `read`, `interrupt`, `wait`, `kill`, `subscribe`, and `unsubscribe`. A missing key stops `tigercat acp` before any request. A provider error is returned on the ACP prompt as `Router failed: ...`. There is no dry-run and no scripted fallback.

```toml
default_worker_runtime = "claude-code"

[router]
provider = "deepseek"
base_url = "https://api.deepseek.com"
model = "deepseek-flash"
api_key_env = "DEEPSEEK_API_KEY"
```

Claude Code does not use that Chat Completions key. Point it at DeepSeek's Anthropic endpoint with `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`), and `ANTHROPIC_MODEL=deepseek-flash`. Codex uses the Responses API (`wire_api = "responses"`, `base_url = "https://api.deepseek.com"`, model `deepseek-flash`) with `CODEX_API_KEY` or `OPENAI_API_KEY`, not Chat Completions. `spawn` launches the real adapter command. If the binary or key is missing, the Worker fails in the open and the ACP reply says so.

`TIGERCAT_UPSTREAM_WAIT_MS` (default `0`) is how long the open ACP prompt waits for that Worker before answering cc-connect. `0` returns the Router text plus `Worker <id> has not finished` when a Worker was started. A finished turn's text is included only after it actually finished.

## cc-connect

Register TigerCat as a generic ACP agent. The host owns the Feishu or DingTalk channel.

```toml
type = "acp"
cmd = "tigercat"
args = ["acp"]
```

Pass a Thread id on the prompt `_meta.thread_id` when the host knows the topic or pull request. Without one, the upstream session is its own Thread (`acp:<sessionId>`).

## Operations

Foreground start, stop, and restart, credential separation, and the scripted
demo config are in [docs/operations.md](docs/operations.md).
[examples/config.example.toml](examples/config.example.toml) leaves
`coordinator_runtime` unset. It is not a model Router, and this repository
does not ship one. There is no `start` or `stop` subcommand. `runtime add
--env` writes plaintext into `config.toml`; do not put API keys there.

## What week 1 does

Triggers are admitted by the ordered rule engine, then routed:

- `ignore` is dropped. Zero Router calls.
- A Thread that already has a subscribed Worker gets later Triggers directly. No Router turn.
- Anything else is batched into the Router's next turn. `candidate` is only judged there; `respond` with no subscriber is spawned.
- `spawn` returns `{ "status": "started" }` immediately. Results are pushed when the Router is idle, and queued into one batch when it is busy. `wait` is optional.
- A stop phrase from the rules cancels the current turn (`session/cancel`) and **keeps** subscriptions, so "stop, do X instead" still reaches that Worker.
- `interrupt` cancels the current turn and keeps subscriptions. `kill`, a crash, or a restart that finds no live Worker process drops every subscription and keeps the worktree. The Thread goes back through the Router.

`worker.turn_end.awaitingInput` is a TigerCat annotation, not an ACP field. The agent's `stopReason` is stored as ACP sent it (usually `end_turn`). TigerCat sets `awaitingInput` only when that reason is `end_turn` and the Worker's text looks like a question or a request for clarification.

State lives in `node:sqlite` behind a `Store` interface. The process keeps sockets and timers only. A restart reloads Threads and any undelivered Router queue. Worker processes do not survive it, so their subscriptions are released.

## Tests

```bash
npm test
```

`npm run test:tck` runs [acp-tck](https://github.com/agentclientprotocol/acp-tck) `v0.4.0` against `tigercat acp` (needs [uv](https://docs.astral.sh/uv/)). On Windows that pin calls `os.killpg` in its own teardown. The script prints those requirement ids as **UNVERIFIED** and exits non-zero. A killpg teardown failure fails the gate. Replay fixtures use the test engineer's JSONL schema; the harness is `test/harness/`. Fixture files are owned by QA and are not edited here to erase label diffs.
