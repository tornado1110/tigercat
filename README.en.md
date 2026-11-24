<!-- i18n-source: README.md @ ca166493f762bc62bec8da9b25ce900f6b885fba -->
> The Simplified Chinese version is authoritative. This translation may lag behind it. Machine-assisted translation; corrections are welcome.

# TigerCat

[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

A Super-agent router for coding agents: one resident ACP router that dispatches work to Claude Code, Codex, or any ACP agent.

TigerCat sits on the [Agent Client Protocol](https://agentclientprotocol.com). Upstream it **is** an ACP agent (`tigercat acp`), so hosts such as cc-connect or Zed can drive it. Downstream it is an ACP client that launches Workers on any registered ACP runtime. Feishu and DingTalk stay in those hosts; TigerCat does not implement IM channels.

It is not a subagent tool. A resident Router only routes and talks to the human. Workers own one task each, subscribe to Threads, and report back to the Router.

In plugin mode, Codex controls the native shell, editing, and file-writing tools in the current Codex session. TigerCat's MCP server registers its own tools and cannot inspect or remove Codex's native tools. While shell, edit, or write remains in the Router's effective tool set, the plugin process refuses to start and does not fall back to a looser permission mode. This is not tool isolation, and M0 is not passed. TigerCat's Skill asks the main session to delegate implementation to Workers. Worker permission policies constrain Workers launched by TigerCat, and direct tool use in the main session follows Codex host settings.

This repository is a week-1 feasibility skeleton. It is not a completed M0. Real Claude Code / Codex sessions, a Feishu round-trip, a real model as the Router, and proof that a vendor harness has no native shell or edit tools are all still unverified. CI drives the `claude-code` and `codex` profiles through the stdio stub. The manual commands for a real binary are below. TigerCat's own MCP catalog omitting those tools does not say anything about the tools a downstream agent ships itself. Cross-channel and shared-PR ingress are M1, not this skeleton.

## Quickstart

Requires Node.js 22.13 or newer.

```bash
npm install
npm run build
npm link

tigercat runtime list
tigercat runtime discover
tigercat runtime test claude-code
tigercat runtime test codex
```

`claude-code` and `codex` are built in. `runtime test` runs `initialize`, `session/new`, and `session/prompt`.

With no `claude` or `codex` binary, and with `TIGERCAT_RUNTIME_LIVE` unset, that test handshakes a local dry-run agent. The report has `mode: "dry-run"` and `vendorExecuted: false`. Claude Code and Codex are not started, and no API key is read.

A real run, once the binary is installed:

```bash
tigercat runtime discover --json
tigercat runtime test claude-code
tigercat runtime test codex
```

`TIGERCAT_CLAUDE_BIN` is forwarded as `CLAUDE_CODE_EXECUTABLE`. `TIGERCAT_CODEX_BIN` is forwarded as `CODEX_PATH`. Claude Code uses an existing `claude` login or `ANTHROPIC_API_KEY`. Codex uses `CODEX_API_KEY` or `OPENAI_API_KEY`. On a headless machine set `NO_BROWSER=1` so Codex does not open a ChatGPT login.

Workers do not inherit Router, plugin, or channel tokens. Other secret-shaped
host variables are filtered; custom runtime credentials must be listed in that
runtime's own `env` table (which is stored in plaintext), while the documented
built-in vendor variables are retained.

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

`coordinator_runtime` names an ACP agent you installed yourself. This repository does not ship that program. Leave the field unset to keep the scripted brain; see [docs/operations.md](docs/i18n/en/operations.md). The admission policy is `examples/rules.default.toml`, currently version `2026-11-19.1`. Explicit whole-message chatter (`thanks`, `lol`, `morning`, and the Japanese, Korean, and Spanish acknowledgements in that file) is `ignore` and makes zero Router calls. Unknown natural language such as `Morning all` or `coffee break` is `candidate` when nobody is subscribed, and a clarification on an already subscribed Thread is `respond` to that Worker. Candidates are not rewritten to `ignore`. Trigger text is NFKC-normalized. Pattern literals are folded the same way, and regex syntax produced by that fold is escaped, so fullwidth punctuation stays a literal. A backslash before a non-ASCII character joins that literal run, so `\＊` matches `*`. Matching is always case-insensitive, and accents are kept: an unlisted `adios` does not match `adiós`. A code point inside a character class must not fold to more than one code point; otherwise `loadConfig` fails with the rule name and the service does not start until the rule is fixed. Japanese and Korean match as substrings. Latin uses a Unicode letter boundary `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])` (the rule carries the `u` flag; not `\b`). A sentence that also contains a task is not ignored.

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

These calls are documentation-backed and have not been live-tested from this repo. A provider HTTP error reports the status only. The response body is discarded.

Claude Code, from [Integrate with Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code): `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN` set to the DeepSeek key, and `ANTHROPIC_MODEL=deepseek-flash[1m]` (plus the default opus/sonnet/haiku and subagent variables on that page). The [Messages API](https://api-docs.deepseek.com/api/create-message) accepts `x-api-key` or `Authorization: Bearer` and model `deepseek-flash`. That is not Chat Completions.

Codex, from [Integrate with Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex) and [Using the Responses API](https://api-docs.deepseek.com/guides/responses_api): Codex speaks the Responses API. The documented provider block is `base_url = "https://api.deepseek.com/"`, `wire_api = "responses"`, `model = "deepseek-flash"`, a `~/.codex/models.json` catalog, and `experimental_bearer_token` set to the DeepSeek key. This repo does not assume `CODEX_API_KEY` or `OPENAI_API_KEY` selects that provider.

`deepseek-flash` is the model id on [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing). Tool calls use `POST /chat/completions` ([Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion), [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)). Thinking defaults on; this Router sends `{"thinking": {"type": "disabled"}}` so `tool_choice` stays on the non-thinking path ([Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)).

`spawn` launches the real adapter command. A missing binary or key fails in the open. The ACP prompt does not wait for the Worker: holding `session/prompt` open would leave cc-connect busy and queue the next Feishu message. When the Worker finishes later, TigerCat runs `cc-connect send --stdin` if `CC_SESSION_KEY` is set (cc-connect injects that when it starts an ACP agent). That posts to the daemon socket, which sends on the platform session. A `session/update` after the prompt returns is not that send. Without `CC_SESSION_KEY` the prompt says the result will not reach Feishu.

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
demo config are in [docs/operations.md](docs/i18n/en/operations.md).
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

`npm run test:tck` runs [acp-tck](https://github.com/agentclientprotocol/acp-tck) `v0.4.0` against `tigercat acp` (needs [uv](https://docs.astral.sh/uv/)). After the harness finishes, the script exits with its status and does not treat `os.killpg` as a pass. A MANDATORY failure is a non-zero exit on every platform. A missing `uvx` exits 2, and a missing `dist/cli.js` exits 1. On Windows that pin calls `os.killpg` in its own teardown; when that happens, the script also prints those requirement ids as **UNVERIFIED**, the step exits non-zero, and that is not a pass. CI copies the VERDICT, the MANDATORY passed/failed/skipped counts, the total, and any UNVERIFIED line into the job summary. Replay fixtures use the test engineer's JSONL schema; the harness is `test/harness/`. Fixture files are owned by QA and are not edited here to erase label diffs.
