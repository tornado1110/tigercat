# TigerCat

A Super-agent router for coding agents: one resident ACP router that dispatches work to Claude Code, Codex, or any ACP agent.

TigerCat sits on the [Agent Client Protocol](https://agentclientprotocol.com). Upstream it **is** an ACP agent (`tigercat acp`), so hosts such as cc-connect or Zed can drive it. Downstream it is an ACP client that launches Workers on any registered ACP runtime. Feishu and DingTalk stay in those hosts; TigerCat does not implement IM channels.

It is not a subagent tool. A resident Router only routes and talks to the human. Workers own one task each, subscribe to Threads, and report back to the Router.

This repository is a week-1 feasibility skeleton. It is not a completed M0. Real Claude Code / Codex sessions, a Feishu round-trip, a real model as the Router, and proof that a vendor harness has no native shell or edit tools are all still unverified. TigerCat's own MCP catalog omitting those tools does not say anything about the tools a downstream agent ships itself. Cross-channel and shared-PR ingress are M1, not this skeleton.

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

Point `coordinator_runtime` in `~/.tigercat/config.toml` at the Router runtime. The admission policy is `examples/rules.default.toml`, currently version `2026-11-18.1`. Explicit whole-message chatter (`thanks`, `lol`, `morning`) is `ignore` and makes zero Router calls. Unknown natural language such as `Morning all` or `coffee break` is `candidate` when nobody is subscribed, and a clarification on an already subscribed Thread is `respond` to that Worker. Candidates are not rewritten to `ignore`.

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
- `interrupt` cancels the current turn and keeps subscriptions. `kill`, a crash, or a restart that finds no live Worker process drops every subscription and keeps the worktree. The Thread goes back through the Router.

`worker.turn_end.awaitingInput` is a TigerCat annotation, not an ACP field. The agent's `stopReason` is stored as ACP sent it (usually `end_turn`). TigerCat sets `awaitingInput` only when that reason is `end_turn` and the Worker's text looks like a question or a request for clarification.

State lives in `node:sqlite` behind a `Store` interface. The process keeps sockets and timers only. A restart reloads Threads and any undelivered Router queue. Worker processes do not survive it, so their subscriptions are released.

## Tests

```bash
npm test
```

`npm run test:tck` runs [acp-tck](https://github.com/agentclientprotocol/acp-tck) `v0.4.0` against `tigercat acp` (needs [uv](https://docs.astral.sh/uv/)). On Windows that pin calls `os.killpg` in its own teardown. If that is the only error, the script prints the affected requirement ids as **UNVERIFIED** and does not count them as passes. Replay fixtures use the test engineer's JSONL schema; the harness is `test/harness/`. Fixture files are owned by QA and are not edited here to erase label diffs.
