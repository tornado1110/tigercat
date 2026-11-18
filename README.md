# TigerCat

A Super-agent router for coding agents: one resident ACP router that dispatches work to Claude Code, Codex, or any ACP agent.

TigerCat sits on the [Agent Client Protocol](https://agentclientprotocol.com). Upstream it **is** an ACP agent (`tigercat acp`), so hosts such as cc-connect or Zed can drive it. Downstream it is an ACP client that launches Workers on any registered ACP runtime. Feishu and DingTalk stay in those hosts; TigerCat does not implement IM channels.

It is not a subagent tool. A resident Router only routes and talks to the human. Workers own one task each, subscribe to Threads, and report back to the Router. The Router's MCP tool list has no shell and no edit tools.

## Quickstart

Requires Node.js 22.13 or newer.

```bash
npm install
npm run build
npm link

tigercat runtime add claude \
  --command npx \
  --arg -y \
  --arg @agentclientprotocol/claude-agent-acp \
  --tag router \
  --permission ask

tigercat runtime add codex \
  --command npx \
  --arg -y \
  --arg @agentclientprotocol/codex-acp \
  --tag worker \
  --permission ask
```

Point `coordinator_runtime` in `~/.tigercat/config.toml` at the Router runtime. Admission rules default to `examples/rules.default.toml` (allowlist, bots, CI, stop, explicit work, chatter). `ignore` never calls the Router.

```bash
tigercat acp
```

## cc-connect

Register TigerCat as a generic ACP agent. The host owns the Feishu or DingTalk channel.

```toml
type = "acp"
cmd = "tigercat"
args = ["acp"]
```

Pass a Thread id on the prompt `_meta.thread_id` when the host knows the topic or pull request. Without one, the upstream session is its own Thread (`acp:<sessionId>`).

## What week 1 does

Triggers are admitted by the ordered rule engine, then routed:

- `ignore` is dropped. Zero Router calls.
- A Thread that already has a subscribed Worker gets later Triggers directly. No Router turn.
- Anything else is batched into the Router's next turn. `candidate` is only judged there; `respond` with no subscriber is spawned.
- `spawn` returns `{ "status": "started" }` immediately. Results are pushed when the Router is idle, and queued into one batch when it is busy. `wait` is optional.
- A stop phrase from the rules cancels the current turn (`session/cancel`) and **keeps** subscriptions, so "stop, do X instead" still reaches that Worker.
- `kill`, or an abnormal Worker exit, drops every subscription and keeps the worktree for a later attach. The Thread goes back through the Router.

`worker.turn_end.awaitingInput` is a TigerCat annotation, not an ACP field. The agent's `stopReason` is stored as ACP sent it (usually `end_turn`). TigerCat sets `awaitingInput` only when that reason is `end_turn` and the Worker's text looks like a question or a request for clarification.

State lives in `node:sqlite` behind a `Store` interface. The process keeps sockets and timers only. A restart resumes Threads, subscriptions, and undelivered Router events from the database.

## Tests

```bash
npm test
```

`npm run test:tck` runs [acp-tck](https://github.com/agentclientprotocol/acp-tck) `v0.4.0` against `tigercat acp` (needs [uv](https://docs.astral.sh/uv/)). Replay fixtures use the JSONL schema documented by the test engineer; the harness is `test/harness/`. The fixture files themselves are not in this repo.
