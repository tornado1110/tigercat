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
| Downstream contract | `tigercat runtime test <rt>`: built-ins dry-run when `claude` / `codex` are absent; a configured command is launched as given | dry-run in CI | yes |
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
4. **Events** – `worker.spawned/update/permission_request/turn_end/error/lost/stalled`, `coordinator.turn_end`: each reproducible with a stub, in order per worker, no loss, no duplicates; payload to the coordinator is a summary with a size cap. `worker.lost` is the restart event when the ACP session cannot be restored.
5. **Push delivery** – result is pushed when the coordinator is idle, queued while it is busy, re-delivered after daemon restart.
6. **Hooks** – a failing or slow user hook never blocks the bus.
7. **Concurrency** – parallel workers get separate worktrees; overlapping edits are detected; max-concurrency is enforced. `kill` releases subscriptions and leaves no worker process; the worktree is kept for attach. A stop phrase only cancels the current turn and keeps subscriptions.
8. **Recovery** – after restart, a Worker whose runtime advertises `loadSession` and whose `session/load` succeeds resumes that ACP session and keeps its Thread subscription. That success path is the stdio stub only. The built-in `claude-code` and `codex` profiles do not advertise `loadSession`, so a restart marks them `lost`, records `worker.lost`, and releases the subscription back to the Router. A recorded pid whose command line still matches the runtime is reaped. A dead pid is not left in `running`. `interrupted` is reserved for an explicit interrupt; restart does not write it.
9. **Safety** – the coordinator cannot edit code directly (enforced at the tool layer, tested); permission requests follow `--approve auto|ask|deny`, default `ask`, never auto-allow by accident; API keys never appear in logs or events.
10. **CLI & install** – exit codes, stable `--json`, `--help`; fresh-machine `npx tigercat` smoke on Node 22.13+ and current LTS, macOS / Linux / Windows.

## PR gate
Unit + integration + acp-tck (MANDATORY tier) on ubuntu, macos, windows. No coverage percentage target yet; every bug fix ships with a regression test.

## Milestone labels

This tree is a feasibility skeleton. It does not complete M0.

| Item | Milestone | In this skeleton |
|---|---|---|
| Rule filter, subscription routing, `spawn` returns Started, sqlite restart | skeleton | implemented and tested with fakes plus stdio stubs |
| Real Claude Code / Codex dual harness | M0 | ACP client and both profiles are implemented. CI sends one prompt to each profile through the stdio stub (`test/integration/builtin-runtimes.test.ts`). Real binaries were not executed. Manual: `TIGERCAT_CLAUDE_BIN=/path/to/claude tigercat runtime test claude-code` and `TIGERCAT_CODEX_BIN=/path/to/codex tigercat runtime test codex` |
| Feishu via cc-connect | M0 | not run |
| Real model as the Router, native shell/edit isolation inside that harness | M0 | not passed. Codex plugin mode cannot inspect or remove native shell, edit, or write tools, so `tigercat plugin` refuses to start. That refusal is not tool isolation. TigerCat's MCP list is not evidence about the vendor's own tools |
| Cross-channel continuity and a shared PR feeding two Workers | M1 | not implemented. The scripted brain subscribes only the Threads passed to `spawn` |
| GitHub / CI event ingress | M1 | not implemented. `ci.result` rules exist so a future ingress can use them |

acp-tck v0.4.0 on Windows calls `os.killpg` while closing the agent. That API is missing on win32. After the harness finishes, the script exits with its status and does not treat that teardown as a pass. A MANDATORY failure fails the step on every platform. When Windows teardown hits `os.killpg`, the script also prints those requirement ids as UNVERIFIED; that non-zero exit is not a pass. A missing `uvx` exits 2, and a missing `dist/cli.js` exits 1. The `test` job writes the VERDICT, the MANDATORY passed/failed/skipped counts, the total, and any UNVERIFIED line to the GitHub Actions job summary.

## Week 1 acceptance
- [ ] `tigercat acp` passes acp-tck MANDATORY requirements where the harness can run. A Windows `os.killpg` teardown failure fails the TCK step. The ids are listed as UNVERIFIED and are not passes.
- [ ] Hooked into cc-connect as a generic ACP agent; a Feishu message reaches the coordinator. (M0, not this PR.)
- [ ] Coordinator (Claude Code) spawns a Codex worker in its own worktree; worker edits one file. (M0, not this PR.)
- [ ] Worker result is pushed back to the coordinator without a blocking `wait`, and the reply shows up in Feishu. (M0, not this PR.)
- [x] The same control flow is covered in CI with stub agents and no API keys. Real stdio coverage is `test/integration/stub-stdio.test.ts`.
- [x] The same prompt is dispatched to a `claude-code` profile and a `codex` profile, both backed by `test/stub-agent.ts`. `runtime test` for those built-ins dry-runs with no API key when the vendor binary is absent.
- [ ] Real Claude Code and real Codex. Use the manual commands in the README. This tree did not run them.
