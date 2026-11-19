# Trigger stream fixtures

Replay inputs for TigerCat's trigger harness. Each file is JSONL: one Trigger
object per line, UTF-8, no blank lines. These files are annotations and
scripts, not test results.

The synthetic mix (`node generate.mjs --seed 1 --count 300 --work 20`) mirrors
the scale of DeepSeek's Super-agent ablation: about 300 messages, 20 real work
requests, and the rest chatter, follow-ups, stop requests, and CI noise.

## Schema

| Field      | Type                         | Required | Meaning |
|------------|------------------------------|----------|---------|
| `id`       | string                       | yes      | Stable unique id (`trg_…`). |
| `ts`       | string (ISO 8601 UTC)        | yes      | Event time, e.g. `2026-03-02T01:00:00.000Z`. |
| `source`   | `feishu` \| `github`         | yes      | Channel. |
| `kind`     | string                       | yes      | `im.message`, `pr.opened`, `pr.comment`, `ci.result`. |
| `thread_id`| string                       | yes      | Consecutive events that share a thread_id form a Thread. Feishu: `feishu:<group>:<topic>`. GitHub: `github:<owner>/<repo>#<pr>`. |
| `author`   | string                       | yes      | Sender login or display id. |
| `is_bot`   | boolean                      | yes      | True for bots (CI, echoes). |
| `text`     | string                       | yes      | Message body or a short CI summary. |
| `reply_to` | string \| null               | yes      | Parent trigger id, or `null`. |
| `expect`   | object                       | yes      | Assertion labels. Not part of the production Trigger. |

Optional production-shaped fields may appear later; fixtures stay this small
on purpose. Group is derived from `thread_id` (`feishu:eng:cli` → `eng`).

## `expect`

| Field        | Type                         | Meaning |
|--------------|------------------------------|---------|
| `filter`     | `ignore` \| `candidate` \| `respond` | Level-1 deterministic rule outcome. `ignore` is dropped with zero LLM calls. `candidate` is forwarded to the Router to judge. `respond` must be handled. |
| `route`      | `router` \| `worker:<id>` \| `worker:<id>`[] \| `null` | Where a non-ignored event is delivered. `null` on `ignore`. `worker:<id>` names the Worker by the thread it was spawned on (its home thread). An array lists every Worker that must receive the event. |
| `spawns`     | boolean                      | `true` only when this event must start a new Worker. Never true for `ignore` or `candidate` (fixtures do not invent a Router LLM decision). |

Optional `expect` keys, used only when the scenario needs them:

| Field        | Type           | Meaning |
|--------------|----------------|---------|
| `subscribe`  | string[]       | On a spawn: Threads the new Worker subscribes to (always includes the home thread). Later events in those Threads go to the Worker, not the Router. |
| `interrupt`  | boolean        | User asked to stop the Worker's current turn (subscriptions kept). |
| `unsubscribe_all` | string     | On `worker.exited` events: home thread of the Worker that was killed or crashed; it drops every subscription. |
| `batch`      | string         | Events that arrive while the Router is mid-turn and must be merged into the next Router turn. Same id = same batch. Ignored events are not batched. |
| `fanout`     | number         | How many subscribed Workers must receive this event (`route` is then an array). |

## Fixture filter policy

This is a convention for these files so assertions are deterministic. It is
not a substitute for a product spec. Rules run in order and stop at the first
match.

1. **Allowlist.** `thread_id` must start with `feishu:eng:` or
   `github:tornado1110/tigercat#`. Anything else → `ignore`.
2. **Bot chat.** `is_bot` and `kind` is `im.message` or `pr.comment` → `ignore`.
3. **CI.** `kind` is `ci.result`:
   - Failure (`fail` / `failed` / `failure` in `text`, case-insensitive) on an
     allowlisted PR: `respond` if a Worker already subscribes to that Thread,
     otherwise `candidate`.
   - Success, skipped, or cancelled CI → `ignore`.
4. **Stop.** Text matches a stop phrase (`please stop this task`, `cancel this
   worker`, `interrupt this, I will finish it myself`, `stop, do not continue`)
   and a Worker is subscribed to the Thread → `respond`, `route` to that
   Worker, `interrupt: true`. Interrupt only stops the current turn: the Worker keeps
   every subscription, so a follow-up like "stop, do X instead" in the same
   Thread goes straight to the same Worker (product spec, issue #7).
   Only `kill` or an abnormal Worker exit unsubscribes it from all its Threads;
   later events on those Threads go back to the Router (see `kill-worker.jsonl`).
5. **Explicit work.** `@tigercat`, or an imperative task verb (`please add|fix|
   implement|refactor|write|change|update|remove|delete|investigate|document|
   run|create|replace|move|rename|set|keep…`, including those verbs at the
   start of the text) → `respond`. If no Worker is subscribed to this Thread,
   `route` is `router` and `spawns` is `true`. If one already is, this is a
   follow-up: `route` is that Worker and `spawns` is `false`.
6. **Chatter.** Greetings, thanks, acks, emoji, `ok`, `+1`, `lol`, lunch or
   other social talk → `ignore`, even on a subscribed Thread (they must not
   spawn, and they must not cost an LLM call).
7. **Subscribed clarification.** Any other human message on a Thread that
   already has a Worker → `respond`, `route` to that Worker, `spawns` false.
   This covers clarifications that are not imperative ("The typo is in the
   install section, not the title.").
8. **Otherwise** → `candidate`, `route` is `router`, `spawns` is `false`.
   Fixtures do not invent a Router LLM decision for candidates.

`pr.opened` without an explicit task body falls through to `candidate`.

## Routing and cross-channel identity

A Worker is identified by its home `thread_id` (the Thread of the spawn
event). `expect.subscribe` may list additional Threads (a PR mentioned in a
Feishu task, for example). A later PR comment is then routed as
`worker:<home thread_id>`, not as a new Router decision.

When two Workers subscribe to the same Thread, a later event on that Thread
lists both homes in `route` and sets `fanout` to 2.

`spawn` itself is not represented here; the harness asserts that TigerCat
returns "started" immediately and that `expect.spawns` matches Worker
creation.

## Files

| File | What it exercises |
|------|-------------------|
| `chatter-only.jsonl` | Everything is `ignore`. Zero spawns, zero LLM calls. |
| `single-task.jsonl` | One explicit request spawns a Worker; later task follow-ups in that Thread go to the Worker. |
| `cross-channel.jsonl` | Task starts in Feishu and mentions a PR; a later PR comment that changes the decision reaches the same Worker. |
| `burst-batching.jsonl` | Several non-ignored Triggers arrive within ~2s while the Router is mid-turn and must share one `batch` id. |
| `stop-request.jsonl` | User stops a running task in the same Thread; the stop goes to the Worker. |
| `shared-pr-two-workers.jsonl` | Two Workers, started from two Feishu Threads, both subscribe to one PR; a later PR comment fans out to both. |
| `generate.mjs` | Seeded generator. No dependencies. Stdout is JSONL; the count summary goes to stderr. |

Regenerate the default synthetic stream:

```bash
node generate.mjs --seed 1 --count 300 --work 20 > stream-seed1.jsonl
```

`stream-seed1.jsonl` is the checked-in output of that command. Do not edit it
by hand.
