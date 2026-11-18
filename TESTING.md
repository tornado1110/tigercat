# Testing TigerCat

TigerCat sits between ACP clients (cc-connect, Zed, ...) and ACP agents (Claude Code, Codex, Kimi, ...).
It is an **ACP server** upward and an **ACP client + MCP server** downward. Tests follow that shape.

**Not a subagent tool.** Following DeepSeek's [Super-agent design](https://offloop.org/zh-CN/learn/exploring-deepseek-super-agent-design), TigerCat is driven by a
stream of environment events (Triggers: IM messages, PR comments, CI results), not by one user prompt.
The Router coordinates *between* tasks and never executes; Workers own one task each and subscribe to its Thread.
So the main test input is a **trigger stream**, and the main questions are: did the right events get through,
did they reach the right Worker, and did the Router stay responsive while Workers ran.

## Layers

| Layer | What | Real model? | Runs in PR CI |
|---|---|---|---|
| Unit | worker state machine, event dedupe/ordering, tool arg validation, stall timer | no | yes |
| Integration | daemon + scripted stub agents over real stdio ACP | no | yes |
| Upstream conformance | TigerCat as an ACP agent, checked by [acp-tck](https://github.com/agentclientprotocol/acp-tck) (pinned) | no | yes |
| Downstream contract | `tigercat runtime test <rt>`: any registered runtime must pass before it can receive work | depends | stub only |
| Real E2E | Claude Code / Codex, a few fixed tasks, hard spend cap; asserts turn *shape*, not content | yes | no (manual / pre-release) |

Fake runtimes: [`testy`](https://agentclientprotocol.github.io/rust-sdk/testy.html) for well-behaved paths, plus our own scripted stub (`test/stub-agent`) for failure modes testy does not cover.

## Testability hooks (required in the design)
- `RuntimeFactory` injection: tests swap in stub agents.
- Replaceable `Clock`: timeouts, `wait --timeout`, and `worker.stalled` are tested without real sleeps.
- Every event carries a global unique `id` and a per-worker monotonic `seq`.

## Stub agent scenarios
`ok` · `ask-input` · `ask-permission` · `slow-stream` · `huge-output` · `crash-mid-turn` · `hang` (no output) ·
`garbage-stdout` (non JSON-RPC) · `ignore-cancel` · `no-session-load` · `bad-handshake` (version mismatch) · `leak-child-process`

## Trigger replay harness (core test asset)
A recorded or synthetic trigger stream (JSONL: source, thread id, author, text, timestamp) is replayed into TigerCat
with a fake clock. Workers are stub agents whose "work" just takes N fake minutes, so runs are cheap and deterministic.
The same harness drives the M2 benchmark, mirroring DeepSeek's ablation: ~300 messages, ~20 real work requests,
the rest chatter, follow-ups, stop requests and CI noise; 5 runs per setup; report p50/p95 completion time,
Router decisions, and tokens.

The harness in `test/harness/` consumes the fixture JSONL schema (`id`, `ts`, `source`, `kind`, `thread_id`, `author`, `is_bot`, `text`, `reply_to`, `expect`). Fixture files themselves land separately under `test/fixtures/`.

## Super-agent behaviour that must hold
- **Two-level filter** – deterministic rules (source, group, allowlist) drop noise before any LLM call; tested as pure unit tests. Chatter must not spawn Workers; explicit requests must.
- **Thread subscription** – the first event of a Thread goes through the Router and creates a Worker; later events in that Thread go straight to the subscribed Worker without a Router decision. Many-to-many: one Worker can hold several Threads, one Thread can feed several Workers. Unsubscribe / hand back to Router works.
- **Full duplex** – starting a Worker returns "started" immediately; the Router answers a new message while Workers are busy; results arrive later as events.
- **Batching** – triggers that arrive while the Router is mid-turn are merged into its next turn, none dropped.
- **Context budget (Inline & Spill)** – injected events carry ids plus a capped summary; anything longer is truncated with a readable reference that resolves via a tool.
- **Cross-channel continuity** – a decision changed in a PR comment after being made in IM reaches the same Worker.
- **Watchdog (v0.2)** – detects no-progress loops, not just dead processes.

## Mechanics that must hold
1. **Registration** – add/list/remove runtimes; bad command or path gives a clear error; version mismatch or missing capability is rejected or degraded explicitly, never hangs.
2. **Tools** (`spawn` `list` `send` `read` `interrupt` `wait` `kill`) – unknown id, sending to a finished worker, double interrupt all return typed errors; operations are idempotent; `read(since)` never skips or repeats.
3. **State machine** – only legal transitions; `interrupt` ends the turn with stopReason `cancelled`; crash becomes `worker.error`; `hang` becomes `worker.stalled` after the configured idle timeout.
4. **Events** – `worker.spawned/update/permission_request/turn_end/error/stalled`, `coordinator.turn_end`: each reproducible with a stub, in order per worker, no loss, no duplicates; payload to the coordinator is a summary with a size cap.
5. **Push delivery** – result is pushed when the coordinator is idle, queued while it is busy, re-delivered after daemon restart.
6. **Hooks** – a failing or slow user hook never blocks the bus.
7. **Concurrency** – parallel workers get separate worktrees; overlapping edits are detected; max-concurrency is enforced. `kill` releases subscriptions and leaves no worker process; the worktree is kept for attach. A stop phrase only cancels the current turn and keeps subscriptions.
8. **Recovery** – after restart, sessions resume via `session/load` or are marked interrupted and reported; orphan processes are reaped.
9. **Safety** – the coordinator cannot edit code directly (enforced at the tool layer, tested); permission requests follow `--approve auto|ask|deny`, default `ask`, never auto-allow by accident; API keys never appear in logs or events.
10. **CLI & install** – exit codes, stable `--json`, `--help`; fresh-machine `npx tigercat` smoke on Node 22.13+ and current LTS, macOS / Linux / Windows.

## PR gate
Unit + integration + acp-tck (MANDATORY tier) on ubuntu, macos, windows. No coverage percentage target yet; every bug fix ships with a regression test.

## Week 1 acceptance
- [ ] `tigercat acp` passes acp-tck MANDATORY requirements.
- [ ] Hooked into cc-connect as a generic ACP agent; a Feishu message reaches the coordinator.
- [ ] Coordinator (Claude Code) spawns a Codex worker in its own worktree; worker edits one file.
- [ ] Worker result is pushed back to the coordinator without a blocking `wait`, and the reply shows up in Feishu.
- [ ] Same flow passes in CI with stub agents only, no API keys.
