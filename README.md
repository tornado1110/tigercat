# TigerCat

[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

面向编程代理的任务与 Worker 编排工具，可独立运行、接入飞书机器人，也可作为 Codex 插件提供。

TigerCat 的入口复用同一个 Engine 和 Worker 协议：独立运行时用 `tigercat acp`；作为 Codex 插件时，由当前 Codex 会话使用 TigerCat 的 MCP 工具调度 Worker，无需另外启动 Router 模型。插件目录为 [`plugins/codex`](plugins/codex/README.md)。飞书机器人可以用 [`tigercat feishu`](#飞书机器人) 直接收发消息。

TigerCat 基于 [Agent Client Protocol](https://agentclientprotocol.com)。独立模式对上游提供 ACP agent（`tigercat acp`），供 cc-connect 或 Zed 这样的宿主驱动；插件模式对当前 Codex 会话提供 Skill 和 MCP 工具。两种模式对下游都是 ACP 客户端，在已注册的 runtime 上启动 Worker。飞书和钉钉由可选宿主接入。

调度者负责路由和对话，每个 Worker 负责一个任务，订阅 Thread，再回报执行结果。独立模式由 TigerCat Router 调度，插件模式由当前 Codex 会话调度。

本仓库是第 1 周的可行性骨架，还不是完成的 M0。真实的 Claude Code / Codex 会话、一次飞书往返、用真实模型担任 Router，以及「某个厂商的 harness 没有原生 shell 或编辑工具」这一证明，都尚未验证。CI 通过 stdio stub 驱动 `claude-code` 和 `codex` 这两个 profile。真实二进制的手动命令见下文。TigerCat 自己的 MCP 目录不收录那些工具，这并不能说明下游 agent 自己带了哪些工具。跨频道进入和共享 PR 进入属于 M1，不是这个骨架的范围。

## 快速开始

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run build
npm link

tigercat runtime list
tigercat runtime discover
tigercat runtime test claude-code
tigercat runtime test codex
```

## Codex 插件

运行 `npm ci`，再运行 `npm run build:plugin`。

生成的 `plugins/codex/` 包含插件清单、Skill、本地 MCP 服务和生产依赖，可整体复制分发。按 [Codex 插件文档](https://developers.openai.com/plugins/build/plugins) 将它添加为本地插件源；本仓库不修改全局 Codex 配置，也不自动安装插件。

同一目录里的 `server/cli.js plugin` 是普通 MCP 入口，也可由 Claude Code 或其他 MCP 宿主启动；将其工作目录设为插件根目录，跨机器时用绝对路径。`.codex-plugin` 清单只负责 Codex 的安装发现，Worker/ACP 核心不依赖特定宿主。

当前 Codex 会话可以调用 `runtimes`、`spawn`、`resume`、`list`、`send`、`read`、`interrupt`、`wait`、`kill`、`subscribe` 和 `unsubscribe`；配置 Lark 绑定后还会出现 `lark_status`、`lark_discover` 和 `lark_execute`。对仓库检查、编码、测试、调查和持续任务，主会话应主动调度 Worker，不需要用户额外说“使用 TigerCat”。解释、澄清和闲聊由主会话直接处理，外部副作用仍需用户确认。`spawn` 必须带用户项目的绝对 `cwd`；`wait` 每次最多 30 秒。插件启动目录是安装目录，不能据此推断项目路径。Worker 的实际编程能力仍来自所选 ACP runtime。

Worker 的 `permission = "ask"` 会通过 MCP elicitation 交给当前 Codex 宿主审批；宿主不支持审批 UI 或用户拒绝时，Worker 只会取消，TigerCat 不会自动放行。插件还提供可选的本地 `lark-cli` capability（需宿主显式配置绑定），用于按 profile 读取授权状态、按需发现能力和执行用户明确授权的业务命令；未知写入结果不会盲重试。

MCP 连接关闭时会清理 Worker。默认每个插件进程有隔离的临时状态；设置 `TIGERCAT_PLUGIN_DB` 可保留历史，同一个数据库只允许一个插件进程占用。重启后旧 Worker 标为中断，不自动重放任务；异常退出遗留的 `.plugin-lock` 需要确认旧进程退出后再移除。当前版本没有自动唤醒 Codex 会话、断线继续执行或持久结果投递的承诺。

`lark-cli` 用于插件中的可选飞书业务操作。原生飞书机器人有独立的进程入口和机器人身份。

## 飞书机器人

在项目目录运行 `tigercat feishu connect`，打开命令输出的飞书官方链接，确认创建 TigerCat 机器人。连接成功后即可私聊，下次运行同一命令会复用绑定。每个进程绑定一个仓库。授权用户可以私聊机器人，也可以在明确授权的群里 @ 机器人。每个私聊或群共享一个 Worker。Worker 执行期间，支持 ACP steering 的运行时会将补充消息并入当前轮，结果统一回复发起消息。

[飞书配置与新增 IM 渠道](docs/im-channels.md)

## 独立运行时

`claude-code` 和 `codex` 是内置的。`runtime discover`（`runtime list --json` 也会显示同样的字段）会从当前进程的 `PATH` 自动找到本机 `claude`、`codex`，并报告绝对路径；显式的 `TIGERCAT_CLAUDE_BIN`、`TIGERCAT_CODEX_BIN` 优先。`runtime test` 会执行 `initialize`、`session/new` 和 `session/prompt`。

如果没有 `claude` 或 `codex` 二进制，并且没有设置 `TIGERCAT_RUNTIME_LIVE`，这次测试会与本地的 dry-run agent 完成握手。报告中为 `mode: "dry-run"` 和 `vendorExecuted: false`。Claude Code 和 Codex 不会启动，也不会读取 API key。

发现本地二进制后，真实跑法如下；不需要再手工填路径：

```bash
tigercat runtime discover --json
tigercat runtime test claude-code
tigercat runtime test codex
```

`TIGERCAT_CLAUDE_BIN` 会作为 `CLAUDE_CODE_EXECUTABLE` 往下传。`TIGERCAT_CODEX_BIN` 会作为 `CODEX_PATH` 往下传。Claude Code 使用已有的 `claude` 登录，或 `ANTHROPIC_API_KEY`。Codex 使用 `CODEX_API_KEY` 或 `OPENAI_API_KEY`。在没有图形界面的机器上设置 `NO_BROWSER=1`，避免 Codex 打开 ChatGPT 登录页。

Worker 不会继承 Router、插件或频道令牌；宿主环境里的其他密钥形状变量也会被过滤。自定义 runtime 需要的凭据请放在它自己的 `env` 中（配置文件会明文保存），内置 Worker 的文档变量会自动保留。

这些 adapter 已随项目依赖和 Codex 插件 bundle 固定。厂商二进制不在 `PATH` 上时，`TIGERCAT_RUNTIME_LIVE=1` 会启动本地 adapter。这会与厂商通信，因此需要凭据：

```bash
TIGERCAT_RUNTIME_LIVE=1 tigercat runtime test claude-code
TIGERCAT_RUNTIME_LIVE=1 tigercat runtime test codex
```

| 运行时 | 包 | 版本 | 可执行文件 |
|---|---|---|---|
| `claude-code` | `@agentclientprotocol/claude-agent-acp` | 0.108.0 | `claude-agent-acp` |
| `codex` | `@agentclientprotocol/codex-acp` | 2.7.0 | `codex-acp` |

这些版本号是 2026-11-18 从 npm registry 钉住的。`claude-code` 启动时带上 `CLAUDE_AGENT_ACP_PROTOCOL=v1`，让会话留在本客户端所实现的稳定 v1 生命周期上（`session/new`、`session/prompt`、`session/cancel`）。如果你已经装好 adapter，它会代替 `npx`：

```bash
TIGERCAT_CLAUDE_CODE_ACP=/usr/local/bin/claude-agent-acp tigercat runtime test claude-code
TIGERCAT_CODEX_ACP=/usr/local/bin/codex-acp tigercat runtime test codex
```

同名的 `runtime add` 会覆盖内置项。这两个名字都可以当作 `coordinator_runtime`。Router 的工具列表仍然只有 spawn、list、send、read、interrupt、wait、kill、subscribe 和 unsubscribe。

`coordinator_runtime` 指的是你自己安装的 ACP agent。本仓库不附带那个程序。这个字段留空，才会继续用脚本化 brain；见 [docs/operations.md](docs/operations.md)。准入策略文件是 `examples/rules.default.toml`，当前版本为 `2026-11-19.1`。整句都是明确的闲聊（`thanks`、`lol`、`morning`，以及该文件里的日语、韩语、西班牙语确认语）时，结果为 `ignore`，Router 调用次数为零。当没有人订阅时，`Morning all` 或 `coffee break` 这类未知自然语言是 `candidate`；在已经订阅的 Thread 上做澄清，则是对该 Worker 的 `respond`。`candidate` 不会被改写成 `ignore`。触发文本做 NFKC。规则里的字面量同样折叠，折叠产生的正则元字符会转义，因此全角标点仍是字面量；反斜杠后面的非 ASCII 字符也并入这段字面量，所以 `\＊` 命中 `*`。匹配始终不区分大小写，重音保留：未列出的 `adios` 不会命中 `adiós`。字符类里的单个码位不能折叠成多个码位，否则 `loadConfig` 报出带规则名的错误，服务在规则改好之前不会启动。日文和韩文按子串匹配，拉丁文用 Unicode 字母边界 `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`（规则自己带 `u` 标志，不用 `\b`）。句子里还夹着任务时，这条规则不忽略。

```bash
tigercat acp
```

## 把 DeepSeek 用作 Router

`router.provider = "deepseek"` 会用 DeepSeek Chat Completions 替换脚本化 brain（`POST {base_url}/chat/completions`，`Authorization: Bearer $DEEPSEEK_API_KEY`，模型 `deepseek-flash`，关闭 thinking）。Router 只能调用 `spawn`、`list`、`send`、`read`、`interrupt`、`wait`、`kill`、`subscribe` 和 `unsubscribe`。缺少密钥时，`tigercat acp` 在发出任何请求之前就停下来。提供者出错时，ACP prompt 上返回 `Router failed: ...`。这条路径没有 dry-run，也没有脚本化回退。

```toml
default_worker_runtime = "claude-code"

[router]
provider = "deepseek"
base_url = "https://api.deepseek.com"
model = "deepseek-flash"
api_key_env = "DEEPSEEK_API_KEY"
```

这些调用有文档依据，但还没有从本仓库做过实机测试。提供者的 HTTP 错误只报告状态码。响应体会被丢掉。

Claude Code，依据 [Integrate with Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)：`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`，`ANTHROPIC_AUTH_TOKEN` 设为 DeepSeek 的密钥，以及 `ANTHROPIC_MODEL=deepseek-flash[1m]`（再加上那一页上默认的 opus/sonnet/haiku 和 subagent 变量）。[Messages API](https://api-docs.deepseek.com/api/create-message) 接受 `x-api-key` 或 `Authorization: Bearer`，模型是 `deepseek-flash`。那不是 Chat Completions。

Codex，依据 [Integrate with Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex) 和 [Using the Responses API](https://api-docs.deepseek.com/guides/responses_api)：Codex 说的是 Responses API。文档里的提供者配置是 `base_url = "https://api.deepseek.com/"`、`wire_api = "responses"`、`model = "deepseek-flash"`、一份 `~/.codex/models.json` 目录，以及把 `experimental_bearer_token` 设为 DeepSeek 的密钥。本仓库不把 `CODEX_API_KEY` 或 `OPENAI_API_KEY` 当成选择了那个提供者。

`deepseek-flash` 是 [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) 上的模型 id。工具调用使用 `POST /chat/completions`（[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)、[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)）。Thinking 默认开启；这个 Router 发送 `{"thinking": {"type": "disabled"}}`，让 `tool_choice` 留在非 thinking 路径上（[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)）。

`spawn` 启动真实的 adapter 命令。缺少二进制或密钥时，失败是敞着的。ACP prompt 不会等 Worker：把 `session/prompt` 一直开着会让 cc-connect 占线，并把下一条飞书消息排进队列。Worker 稍后结束时，如果设置了 `CC_SESSION_KEY`，TigerCat 会运行 `cc-connect send --stdin`（cc-connect 在启动 ACP agent 时注入这个变量）。那会发到 daemon 的套接字，再由它在平台会话上发送。prompt 返回之后的 `session/update` 不是那次发送。没有 `CC_SESSION_KEY` 时，prompt 会说明结果到不了飞书。

## cc-connect

把 TigerCat 注册为一个通用 ACP agent。飞书或钉钉频道归宿主所有。

```toml
type = "acp"
cmd = "tigercat"
args = ["acp"]
```

宿主知道话题或 pull request 时，把 Thread id 放在 prompt 的 `_meta.thread_id` 上。如果没有，上游会话自己就是一个 Thread（`acp:<sessionId>`）。

宿主重投同一条事件时，应复用 `_meta.event_id`（非空字符串）；可同时传 `_meta.timestamp`（非负毫秒时间戳）。同一身份只接纳一次，内容变更返回冲突；有事件 ID 但省略时间时使用稳定的 `0`。不传事件 ID 的普通 prompt 仍是独立提交。认领后未完成的提交返回 `ingest_incomplete`，需要核对已有执行，不能盲目重放。

## 运维

前台的启动、停止和重启，凭据如何分开，以及脚本化演示的配置，写在 [docs/operations.md](docs/operations.md)。[examples/config.example.toml](examples/config.example.toml) 没有设置 `coordinator_runtime`。它不是模型 Router，本仓库也不附带这样一个程序。没有 `start` 或 `stop` 子命令。`runtime add --env` 会把明文写进 `config.toml`；不要把 API key 放在那里。

## 第 1 周做什么

Trigger 先经有序规则引擎准入，再按下面的方式路由：

- `ignore` 会被丢弃。Router 调用次数为零。
- 已经有 Worker 订阅的 Thread，之后的 Trigger 直接送给它。不产生 Router 回合。
- 其余内容并入 Router 的下一回合。`candidate` 只在那里判定；没有订阅者的 `respond` 会被 spawn。
- `spawn` 立即返回 `{ "status": "started" }`。Router 空闲时推送结果，忙碌时排进同一批。`wait` 是可选的。
- 规则中的停止短语会取消当前回合（`session/cancel`），并**保留**订阅。因此「停，改为做 X」仍然能到达那个 Worker。
- `interrupt` 取消当前回合，并保留订阅。`kill`、崩溃，或者重启时找不到仍在运行的 Worker 进程，会丢掉全部订阅，并保留 worktree。该 Thread 重新走 Router。

`worker.turn_end.awaitingInput` 是 TigerCat 加上的注解，不是 ACP 字段。agent 的 `stopReason` 按 ACP 送来的原样保存（通常是 `end_turn`）。只有当这个原因是 `end_turn`，并且 Worker 的文本看起来像提问或请求澄清时，TigerCat 才设置 `awaitingInput`。

状态放在 `Store` 接口背后的 `node:sqlite` 里。进程只保留 socket 和 timer。重启会重新加载 Thread，以及尚未送达的 Router 队列。Worker 进程不会在重启后留下来，因此它们的订阅会被释放。

## 测试

```bash
npm test
```

`npm run test:tck` 会对 `tigercat acp` 运行 [acp-tck](https://github.com/agentclientprotocol/acp-tck) `v0.4.0`（需要 [uv](https://docs.astral.sh/uv/)）。harness 跑完之后，脚本按它的状态码退出，不对 `os.killpg` 做豁免。任何平台上的 MANDATORY 失败都是非零退出。找不到 `uvx` 时退出码是 2，缺少 `dist/cli.js` 时是 1。在 Windows 上，这个钉住的版本会在自己的 teardown 里调用 `os.killpg`；碰到时，脚本额外把那些 requirement id 打印为 **UNVERIFIED**，这一步非零退出，不算通过。CI 把 VERDICT、MANDATORY 的 passed/failed/skipped 计数、总数，以及任何 UNVERIFIED 行写进 job summary。回放 fixture 使用测试工程师的 JSONL schema；harness 位于 `test/harness/`。Fixture 文件归 QA 所有，这里不会为了抹平标签差异而去改它们。
