# Scripted stub-agent scenarios

Each file in this directory describes how a scripted ACP stub (`test/stub-agent`)
should behave for one failure or success mode. The files are data. They are
not a test report, and they do not include results.

`test/stub-agent.ts` does not read these files. The stdio integration suite
executes the hardcoded scenarios, including `no-session-load`, `session-load`,
and `hang`. The JSON files remain protocol documentation. These files are not
a Claude Code, Codex, or Feishu end-to-end run.

TigerCat talks to Workers as an ACP client. These scenarios use ACP v1 method
and field names from the [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview):

- Methods: `initialize`, `session/new`, `session/load`, `session/prompt`,
  `session/update` (notification), `session/request_permission`, `session/cancel`
  (notification).
- `session/update` payloads set `update.sessionUpdate` to a kind such as
  `agent_message_chunk`, `tool_call`, or `tool_call_update`.
- A prompt turn ends when the stub answers the original `session/prompt`
  request with `stopReason`: `end_turn`, `max_tokens`, `max_turn_requests`,
  `refusal`, or `cancelled`.

These fixtures target v1 because that is the shape TESTING.md and acp-tck
exercise today. ACP v2 moves `stopReason` onto an idle `state_update`; do not
mix the two in one scenario.

## File format

One JSON file per scenario, named `<name>.json`. YAML is not used. Top-level
fields:

| Field | Meaning |
|-------|---------|
| `name` | Scenario id, matching the filename. |
| `description` | What the stub exhibits, and what TigerCat should tolerate. |
| `protocolVersion` | Advertised by a well-behaved initialize. `1` unless the scenario is a handshake fault. |
| `initialize` | JSON-RPC result the stub returns to `initialize`, or a `fault` describing a bad handshake. |
| `sessionId` | Default id returned by `session/new`. The stub may also accept the client's id. |
| `onSessionNew` | Result and optional side effects of `session/new`. |
| `onSessionLoad` | How to answer `session/load` (replay and result, or an error). |
| `onPrompt` | Ordered actions for one `session/prompt` turn. Repeats for later prompts unless `onPromptByIndex` is set. |
| `onCancel` | How to react to `session/cancel` during a turn. Default is to stop and complete with `cancelled`. |
| `awaitingInput` | TigerCat-level annotation, **not** an ACP field. When true, `worker.turn_end` should set `awaitingInput`. |

`$sessionId` in any params object is replaced at run time with the live
session id. All `delay` / `ms` / `delayMs` values are **fake milliseconds**
for the test `Clock`. The stub must not sleep in real time.

### Actions (`onPrompt` and similar lists)

| `action` | Fields | Behaviour |
|----------|--------|-----------|
| `delay` | `ms` | Advance the fake clock. |
| `notify` | `method`, `params` | Send a JSON-RPC notification (usually `session/update`). |
| `request` | `method`, `params` | Send a JSON-RPC request and wait for the client response (usually `session/request_permission`). |
| `complete` | `result` | Answer the in-flight `session/prompt` with `{ "stopReason": ... }`. |
| `stream_text` | `totalBytes`, `chunkBytes`, `char`, `delayMs` | Emit `agent_message_chunk` updates totalling `totalBytes`. |
| `write_stdout` | `raw` | Write bytes to stdout that are not JSON-RPC. |
| `exit` | `code` | Exit the process. Do not answer `session/prompt`. |
| `hang` | | Do not send updates, do not answer, do not exit. Used with `worker.stalled`. |
| `spawn_child` | `command`, `args`, `detached`, `newProcessGroup`, `reapOnExit`, `reportPidAs` | Start a child process. If `reapOnExit` is false, it is left running when the stub exits. |

`onCancel` may be `{ "action": "ignore" }` (keep running the current
`onPrompt` list and eventually `complete` with `end_turn`) or
`{ "action": "cancel" }` (finish any pending updates, then `complete` with
`cancelled`).

Permission requests use v1 params: `sessionId`, `toolCall` (a `ToolCallUpdate`),
and `options` with `optionId`, `name`, and `kind` (`allow_once`,
`allow_always`, `reject_once`, `reject_always`). The client replies with
`outcome: { "outcome": "selected", "optionId": ... }` or
`{ "outcome": "cancelled" }`. `onPermissionOutcome` maps those outcomes to
action lists; the `selected` default in these files is `allow-once`.

## Scenarios

| File | Fault or path |
|------|----------------|
| `ok.json` | Happy path: tool call plus a short reply, `stopReason: end_turn`. |
| `ask-input.json` | Asks the user a question and ends the turn with `awaitingInput: true`. |
| `ask-permission.json` | `session/request_permission` before an edit; continues after allow, or stops after reject/cancel. |
| `slow-stream.json` | Many `agent_message_chunk` updates with 500 ms fake delays. |
| `huge-output.json` | 1 MiB of agent text in 4 KiB chunks, to exercise size caps. |
| `crash-mid-turn.json` | Valid chunks, then process exit 1, no `session/prompt` result. |
| `hang.json` | Accepts `session/prompt` and then stays silent. |
| `garbage-stdout.json` | After a valid handshake, writes non-JSON-RPC lines and hangs. |
| `ignore-cancel.json` | Receives `session/cancel` but finishes with `end_turn` instead of `cancelled`. |
| `no-session-load.json` | `agentCapabilities.loadSession` is false; `session/load` returns JSON-RPC `-32601`. |
| `session-load.json` | `loadSession` is true. `session/new` mints a new id. `session/load` accepts only that id. |
| `bad-handshake.json` | `initialize` returns `protocolVersion: 999` (version mismatch). |
| `leak-child-process.json` | On `session/new`, spawns a detached `sleep 3600` and does not reap it. |

The stub implementation is not in this directory. These files only describe
the ACP behaviour a future data-driven stub should exhibit. The hardcoded
stub in `test/stub-agent.ts` covers the same scenario names with its own
behavior, and the two are not the same run.
