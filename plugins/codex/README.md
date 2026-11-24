# TigerCat for Codex

The current Codex conversation coordinates TigerCat workers through a bundled local MCP server. The plugin starts no separate Router model and needs no Feishu account.

Codex controls the native shell, editing, and file-writing tools in the host conversation. TigerCat's MCP server registers its own tools and cannot inspect or remove Codex's native tools. `node server/cli.js plugin` therefore refuses to start while shell, edit, or write remains in the Router's effective tool set. It does not fall back to a looser permission mode. This is not tool isolation, and M0 is not passed. The plugin Skill asks the main conversation to delegate implementation to Workers, while Codex host settings govern any direct tool use. Worker permission policies apply to Workers launched by TigerCat.

Build from the TigerCat repository with Node.js 22.13 or later:

```sh
npm ci
npm run build
node scripts/build-plugin.mjs
```

The build copies compiled TigerCat code, default rules, and installed production dependencies into `server/`. It does not download packages, run dependency scripts, or copy your TigerCat config, credentials, task database, or worktrees. Re-run it after code or dependency changes. Build on the target platform if any dependency contains native binaries.

The resulting `plugins/codex/` is the complete plugin root. Copy the whole directory when distributing it; the authored manifest and Skill alone are insufficient. The MCP entry point is `node server/cli.js plugin`, with the working directory set to this plugin root. Node.js must be on the host's PATH. Configure a local plugin source using the [official plugin packaging instructions](https://developers.openai.com/plugins/build/plugins), then install TigerCat through Codex. This repository does not modify your global Codex settings or install itself.

The repo includes `.agents/plugins/marketplace.json`, which makes this built plugin available through the `tigercat-local` repo marketplace in supported Codex clients. Build first, then open the Plugins Directory and select the TigerCat source. Installation and activation remain explicit user actions.

The bundled MCP entry point is also usable from another MCP host, including a
Claude Code session: configure that host to run `node server/cli.js plugin`
with the plugin root as its working directory. Use an absolute plugin path (or
an absolute `node` path on Windows) when the host does not resolve relative
commands from the installed plugin directory. The `.codex-plugin` manifest is
Codex-specific; the MCP server and Skill remain the portable pieces.

Worker runtimes still need their actual Claude Code/Codex binaries or ACP adapters and credentials. Configuration uses the ordinary TigerCat `~/.tigercat/config.toml` or `TIGERCAT_CONFIG`. `runtimes` reports available profiles; `spawn` requires an absolute repository `cwd`. Permission prompts from `permission = "ask"` are bridged to the connected Codex host's MCP elicitation UI. A host that does not provide that UI cancels the request; the plugin never auto-approves it.

An optional host-owned `lark-cli` capability appears when `TIGERCAT_LARK_ACCOUNT_REF`, `TIGERCAT_LARK_PROFILE_REF`, `TIGERCAT_LARK_CREDENTIAL_HOME` (absolute), and `TIGERCAT_LARK_CREDENTIAL_REVISION` are set. It provides `lark_status`, `lark_discover`, `lark_execute`, and structured `lark_api`; each invocation fixes the profile, HOME, user identity and credential revision. `GET` API calls are read-only, while API writes and `lark_execute` writes require the connected host's elicitation UI. It never logs in or retries an unknown write outcome. For MCP contract tests, `TIGERCAT_LARK_MOCK=1` enables deterministic in-process status/discovery/read/write fixtures and starts no binary. Keep real binding values in host configuration, never in prompts or repository files.

The current Codex conversation is the main assistant. For repository inspection, coding, testing, investigation, monitoring, or other sustained work, it should proactively dispatch a Worker through TigerCat and summarize the result back in the same conversation. Simple explanations and clarification stay in the main conversation. External side effects still require user confirmation. The local MCP process owns its workers; this package provides no automatic conversation wakeups or durable execution after the plugin session closes.

Each MCP process uses its own temporary database by default. Set `TIGERCAT_PLUGIN_DB` to a dedicated path to retain event history across reconnects; this does not keep Workers running when the connection closes or automatically replay their work. Concurrent processes cannot share that database. After a crash, confirm the previous process has exited before removing the adjacent `.plugin-lock` file. `TIGERCAT_CONFIG` and `TIGERCAT_PLUGIN_DB` must be visible to the MCP server environment, which may differ from a terminal's environment.
