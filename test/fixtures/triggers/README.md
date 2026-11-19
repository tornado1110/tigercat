# Trigger stream fixtures

JSONL scripts for the trigger harness. One Trigger per line, UTF-8, no blank
lines. These files are data, not a test report. `npm test` replays `m0/` and
checks the golden generator output. It does not replay `specs/`.

Admission labels come from `examples/rules.default.toml` version
`2026-11-18.1`. That file is the ignore policy. Fixture text and `expect`
are adjusted to match it. The rules file is not widened so a fixture can pass.

## Layout

| Path | Role |
|------|------|
| `m0/` | Current behavior. Replay with the harness settings below must produce zero `mismatches()`. |
| `specs/m1/` | M1 specifications. The scripted brain subscribes only the home thread passed to `spawn`. These files describe cross-thread subscriptions that current replay does not perform. |
| `specs/lifecycle/` | Lifecycle specification. Abnormal exit and `kill` unsubscribe every Thread. Current replay cannot execute that exit. |
| `specs/batching/` | Batching specification. `mismatches()` does not read `batch`, and `replayTriggers` settles after every event. |

## M0 replay settings

`npm test` (`test/integration/m0-replay.test.ts`) replays every `m0/*.jsonl`
with:

```js
const harness = await startHarness({ durationMs: 0 });
const observations = await replayTriggers(harness.engine, harness.clock, triggers);
// mismatches(observation) is empty for every row
```

`durationMs: 0` finishes the fake Worker turn on the next clock advance. The
Worker becomes `idle` and stays subscribed. The harness does not set
`coordinatorRuntime`, so the Router is the scripted brain and an ignore-only
file records 0 Router turns.

The same five files also have 0 `mismatches()` at the harness default,
`durationMs` of 30 minutes. M0 labels do not depend on that choice. What does
change is how many Router turns get recorded: a finished turn posts
`worker.turn_end` back to the Router. On `stream-seed1.jsonl` that total is
161 at `durationMs: 0` and 107 at 30 minutes. `chatter-only.jsonl` stays at 0
either way.

`specs/batching/burst-batching.jsonl` is the duration-sensitive file.
`trg_burst_12` is a fifth spawn about 15 seconds after four other spawns.
At 30 minutes those four Workers are still running, `maxConcurrency` is 4,
and the row fails with two mismatches (`spawns false != true`, and an empty
subscribe list against `feishu:eng:task-e`). At `durationMs: 0` the earlier
turns have already finished, that spawn succeeds, and `mismatches()` is 0.
`batch` is still not asserted. The file stays under `specs/`.

## What `mismatches()` checks

From `test/harness/replay.ts`, for each row:

| `expect` field | Checked? |
|----------------|----------|
| `filter` | yes |
| `route` | yes |
| `spawns` | yes |
| `subscribe` | yes, on a spawn, against the threads actually stored |
| `interrupt` | only when the key is present |
| `fanout` | only when the key is present |
| `batch` | no |
| `unsubscribe_all` | no. Not part of `FixtureExpect`. The parser keeps the key and the harness ignores it. |

M0 files set `interrupt` on every row the stop rule matches, including
`trg_stop_05` (`stop, do .+ instead`). They do not use `batch` or
`unsubscribe_all`. Spawn `subscribe` lists only the home thread.

## Policy used for labels

Same order as the versioned rules. First match wins.

1. Allowlist. `thread_id` must start with `feishu:eng:` or `github:tornado1110/tigercat#`. Anything else is `ignore`.
2. Bot chat. `is_bot` and kind `im.message` or `pr.comment` is `ignore`.
3. CI. Kind `ci.result`: failure text (`fail`, `failed`, or `failure`) is `respond` when a Worker is subscribed, otherwise `candidate`. Other CI is `ignore`.
4. Stop. The versioned pattern, and a subscribed Worker: `respond`, route to that Worker, `interrupt: true`. The pattern includes `please stop this task`, `cancel this worker`, `interrupt this, I will finish it myself`, `stop, do not continue`, and `stop, do .+ instead`. Interrupt cancels the turn and keeps every subscription.
5. Explicit work. `@tigercat`, or `please` followed directly by a task verb, or that verb at the start of the text. `please also <verb>` does not match. Unsubscribed: `route` `router`, `spawns` true. Subscribed: route to that Worker, `spawns` false.
6. Chatter. Whole message only, anchored, from the versioned regex (`morning`, `thanks`, `ok`, `lol`, `+1`, and the other listed words, plus a few emoji). `Morning all`, `coffee break`, `OK thanks`, `sg`, `got it`, `sounds good`, and similar lines do not match. On an allowlisted thread with no subscriber they are `candidate`.
7. Subscribed clarification. Any other message on a thread that already has a Worker: `respond`, route to that Worker, `spawns` false.
8. Otherwise `candidate`, `route` `router`, `spawns` false.

`kill` or an abnormal Worker exit is what drops subscriptions. A trigger row does not. See `specs/lifecycle/`.

## M0 files

| File | What zero `mismatches()` means |
|------|--------------------------------|
| `chatter-only.jsonl` | Every row is `ignore` under `2026-11-18.1` (allowlist, bot chat, non-failure CI, or whole-message chatter). Zero spawns. |
| `single-task.jsonl` | One home-thread spawn. Later messages on that thread reach the Worker. |
| `stop-request.jsonl` | Both stop lines set `interrupt: true` and keep the subscription. `trg_stop_05` matches `stop, do .+ instead`. |
| `four-tasks.jsonl` | Four home-thread spawns, plus ignore and candidate rows. No `batch` key. This does not claim the router merged a turn. |
| `generate.mjs` | Seeded generator. Stdout is JSONL. The count summary goes to stderr. |
| `stream-seed1.jsonl` | Checked-in output of the command below. Do not edit it by hand. |

```bash
node test/fixtures/triggers/m0/generate.mjs --seed 1 --count 300 --work 20 > test/fixtures/triggers/m0/stream-seed1.jsonl
```

Counts for `--count 300 --work 20` are exact roles, not filter outcomes:

- 20 work requests, each spawning one Worker on its home thread only
- stops = min(work, max(1, round(work * 0.25))) = 5, each with `interrupt: true`
- follow-ups = 40, all on the home thread of their work item
- CI rows = round(count * 0.12) = 36
- social-noise rows = the remaining 199

The social-noise role is not the ignore outcome. A line is `ignore` only when `2026-11-18.1` says so. `Morning all` and `coffee break` on an allowlisted thread are `candidate`.

## Specs that are not M0

Replaying these with `mismatches()` fails. That failure is the current product boundary. Their labels were not rewritten to match the failing path.

`specs/m1/cross-channel.jsonl`. A Feishu task also subscribes `github:tornado1110/tigercat#87`. A later PR comment is specified to reach that same Worker. The scripted brain does not subscribe the PR thread.

`specs/m1/shared-pr-two-workers.jsonl`. Two Feishu Workers both subscribe one PR. A later PR comment and a CI failure are specified to fan out to both. The scripted brain subscribes only each home thread, and `fanout` is not produced.

`specs/lifecycle/kill-worker.jsonl`. After an abnormal exit the Worker drops every subscription, and the next explicit request spawns again. The row `trg_kill_03` is `kind: worker.exited` with `unsubscribe_all`. Replay ingests that row as an ordinary trigger. It does not exit the process, and `mismatches()` does not read `unsubscribe_all`. The file keeps the unsubscribe semantics. It does not relabel the exit as `respond` just because that is what a normal ingest does today.

`specs/batching/burst-batching.jsonl`. Several non-ignored triggers share a `batch` id. `mismatches()` does not read `batch`, and `replayTriggers` settles after every event, so this file does not show a merged Router turn. `trg_burst_12` is the duration-sensitive row described above: at the default 30-minute fake turn it does not spawn.
