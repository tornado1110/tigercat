# TigerCat · 把你的飞书变成 GrokBot

[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

**在飞书里 @ 一下，让 Claude Code、Codex、DeepSeek Harness、Pi、ZCode、Kimi Code 或 TRAE 接手代码任务。**

把“这个报错谁看一下”发进群，把“帮我改一下”发给机器人。TigerCat 把飞书消息交给你本机的编程 Agent，在指定仓库里处理任务，再把结果回到聊天里。

你可以私聊它，也可以把它拉进工作群。代码问题在群里提出，Agent 在仓库里跟进，大家在同一个话题里继续讨论。

## 在飞书里，你可以这样用

下面是可以交给 Agent 的任务示例，执行范围取决于所选运行时、凭据和权限配置。

> **排查报错**
>
> @TigerCat 看一下登录接口为什么返回 500，先定位原因。

> **修改代码**
>
> @TigerCat 给这个接口补上分页，沿用项目现有的写法，跑一下相关测试。

> **执行中补充要求**
>
> @TigerCat 补充一下，分页参数需要兼容旧客户端。

> **熟悉项目**
>
> 这个仓库的鉴权逻辑在哪？帮我梳理一下请求链路。

- **私聊交办，群里协作**。授权用户可私聊机器人，在已授权的群里 @ 它发起任务。
- **边做边补充**。支持 ACP steering 的运行时会把后续消息并入当前轮。
- **结果回到飞书**。消息表情显示处理状态，Markdown 卡片回复执行结果，并标注工作区和运行时。
- **接上你已有的 Agent**。内置七种运行时，支持 DeepSeek Harness、Pi、ZCode、Kimi Code、TRAE、Claude Code 和 Codex，也支持注册其他 ACP Worker。

## 快速开始

准备 Node.js 22.13 或更高版本，以及已安装、已配置凭据的任一种内置编程 Agent，安装与凭据说明见下方「独立运行时」。

### 1. 安装 TigerCat

在本仓库目录执行。

```bash
npm ci
npm run build
npm link
```

### 2. 连接你的项目与飞书

切换到希望 Agent 处理的项目目录，启动机器人。

```bash
cd /absolute/path/to/your-project
tigercat feishu connect
```

打开终端输出的飞书官方授权链接，确认创建 TigerCat 机器人。看到 `Feishu WebSocket connected.` 后，打开终端里的机器人私聊链接，发出第一条任务。

保持这个终端进程运行。下次执行同一命令会复用绑定，每个进程绑定一个项目目录。首次接入优先使用已配置的默认 Worker，否则自动发现本机已安装的内置 Agent，优先选择 Codex。

也可以显式指定项目与运行时。

```bash
tigercat feishu connect --cwd /absolute/path/to/your-project --runtime codex
```

### 3. 拉进工作群

把机器人加入群，将群 Chat ID 加入 `TIGERCAT_FEISHU_ALLOWED_CHATS`，再重启渠道进程。创建者默认获得使用权限，其他用户通过 `TIGERCAT_FEISHU_ALLOWED_USERS` 授权。

```bash
TIGERCAT_FEISHU_ALLOWED_CHATS=oc_your_chat_id tigercat feishu connect
```

在群里 @TigerCat，交给它一个具体任务。

飞书文本渠道对需要交互确认的权限请求采用 `deny`，已显式配置的 `auto` 策略继续生效。权限配置、已有飞书应用接入和会话行为见配置文档。[飞书配置与新增 IM 渠道](docs/im-channels.md)

## 架构与接入方式

TigerCat 基于 Agent Client Protocol（ACP），负责连接聊天入口与编程 Agent，管理任务、Worker 和结果回传。飞书机器人之外，还提供独立 ACP 入口和 Codex 插件。[Agent Client Protocol](https://agentclientprotocol.com)

<details>
<summary>展开查看 Engine、Router 与 Worker 的工作方式</summary>

TigerCat 的入口复用同一个 Engine 和 Worker 协议：独立运行时用 `tigercat acp`；作为 Codex 插件时，由当前 Codex 会话使用 TigerCat 的 MCP 工具调度 Worker，无需另外启动 Router 模型。插件目录为 [`plugins/codex`](plugins/codex/README.md)。飞书机器人可以用 [`tigercat feishu`](#快速开始) 直接收发消息。

TigerCat 基于 [Agent Client Protocol](https://agentclientprotocol.com)。独立模式对上游提供 ACP agent（`tigercat acp`），供 cc-connect 或 Zed 这样的宿主驱动；插件模式对当前 Codex 会话提供 Skill 和 MCP 工具。两种模式对下游都是 ACP 客户端，在已注册的 runtime 上启动 Worker。飞书和钉钉由可选宿主接入。

调度者负责路由和对话，每个 Worker 负责一个任务，订阅 Thread，再回报执行结果。独立模式由 TigerCat Router 调度，插件模式由当前 Codex 会话调度。

插件模式下，当前 Codex 会话的原生 Shell、编辑和写文件工具由 Codex 控制。TigerCat 的 MCP 服务注册自己的工具，不能检查或移除 Codex 的原生工具。这些工具仍在 Router 的有效工具集里时，插件进程拒绝启动，也不会退到更松的权限模式。这不是工具隔离，M0 也没有通过。TigerCat 的 Skill 引导主会话把实现交给 Worker。Worker 权限策略约束 TigerCat 启动的 Worker，主会话直接调用工具时遵循 Codex 宿主设置。

当前处于可行性验证阶段。CI 使用 stdio stub 覆盖七种内置运行时的发现、启动与 ACP 会话。待完成的验证包括真实厂商会话、飞书端到端往返、真实模型 Router，以及厂商 harness 的工具隔离。跨频道和共享 PR 接入列入后续里程碑。真实二进制的手动验证命令见下文。

</details>

## Codex 插件

运行 `npm ci`，再运行 `npm run build:plugin`。

生成的 `plugins/codex/` 包含插件清单、Skill、本地 MCP 服务和生产依赖，可整体复制分发。按 [Codex 插件文档](https://developers.openai.com/plugins/build/plugins) 将它添加为本地插件源；本仓库不修改全局 Codex 配置，也不自动安装插件。

同一目录里的 `server/cli.js plugin` 是 MCP 入口，工作目录是插件根目录。Codex、Claude Code 或其他宿主拉起它时，进程会拒绝启动，原因见上文。`.codex-plugin` 清单只负责 Codex 的安装发现，Worker/ACP 核心不依赖特定宿主。

协调工具契约包括 `runtimes`、`spawn`、`resume`、`list`、`send`、`read`、`interrupt`、`wait`、`kill`、`subscribe` 和 `unsubscribe`；配置 Lark 绑定后契约里还会出现 `lark_status`、`lark_discover` 和 `lark_execute`。这不是当前已经暴露的工具面。对仓库检查、编码、测试、调查和持续任务，主会话应主动调度 Worker，不需要用户额外说“使用 TigerCat”。解释、澄清和闲聊由主会话直接处理，外部副作用仍需用户确认。`spawn` 必须带用户项目的绝对 `cwd`；`wait` 每次最多 30 秒。插件启动目录是安装目录，不能据此推断项目路径。Worker 的实际编程能力仍来自所选 ACP runtime。

Worker 的 `permission = "ask"` 会通过 MCP elicitation 交给当前 Codex 宿主审批；宿主不支持审批 UI 或用户拒绝时，Worker 只会取消，TigerCat 不会自动放行。插件还提供可选的本地 `lark-cli` capability（需宿主显式配置绑定），用于按 profile 读取授权状态、按需发现能力和执行用户明确授权的业务命令；未知写入结果不会盲重试。

MCP 连接关闭时会清理 Worker。默认每个插件进程有隔离的临时状态；设置 `TIGERCAT_PLUGIN_DB` 可保留历史，同一个数据库只允许一个插件进程占用。重启后旧 Worker 标为中断，不自动重放任务；异常退出遗留的 `.plugin-lock` 需要确认旧进程退出后再移除。当前版本没有自动唤醒 Codex 会话、断线继续执行或持久结果投递的承诺。

`lark-cli` 用于插件中的可选飞书业务操作。原生飞书机器人有独立的进程入口和机器人身份。

## 独立运行时

内置七种运行时。`runtime discover` 和 `runtime list --json` 会报告本机厂商 CLI 的绝对路径。显式的路径环境变量优先于 `PATH`。

| 运行时 ID | 产品 | ACP 启动方式 | 厂商 CLI 路径变量 |
|---|---|---|---|
| `claude-code` | Claude Code | `@agentclientprotocol/claude-agent-acp@0.108.0` | `TIGERCAT_CLAUDE_BIN` |
| `codex` | Codex | `@agentclientprotocol/codex-acp@2.7.0` | `TIGERCAT_CODEX_BIN` |
| `deepseek-harness` | DeepSeek Harness | `dsh --profile acp` | `TIGERCAT_DEEPSEEK_HARNESS_BIN` |
| `pi` | Pi | `pi-acp@0.0.35` → `pi --mode rpc` | `TIGERCAT_PI_BIN` |
| `zcode` | ZCode | `zcode-acp-server@0.96.0` → `zcode` | `TIGERCAT_ZCODE_BIN` |
| `kimicode` | Kimi Code | `kimi acp` | `TIGERCAT_KIMICODE_BIN` |
| `trae` | TRAE | `traecli acp serve` | `TIGERCAT_TRAE_BIN` |

先安装所选产品的 CLI，并完成登录或配置凭据。Pi 使用 `npm install -g @earendil-works/pi-coding-agent` 安装。ZCode 可以使用桌面应用随附的 CLI，将 `TIGERCAT_ZCODE_BIN` 指向其 `.cjs` 文件。DeepSeek Harness、Kimi Code 和 TRAE 的安装及 ACP 说明见各自文档。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Pi ACP](https://github.com/svkozak/pi-acp) · [ZCode ACP](https://github.com/william0wang/zcode-acp) · [Kimi Code](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp) · [TRAE CLI](https://docs.trae.cn/cli_agent-client-protocol)

`runtime test` 执行 `initialize`、`session/new` 和 `session/prompt`。发现厂商 CLI 或设置独立 ACP 可执行文件后会启动真实进程，并可能调用模型。缺少 CLI 且未设置 `TIGERCAT_RUNTIME_LIVE=1` 时，测试报告为 `mode: "dry-run"`、`vendorExecuted: false`。

```bash
tigercat runtime discover --json
tigercat runtime test claude-code
tigercat runtime test codex
tigercat runtime test deepseek-harness
tigercat runtime test pi
tigercat runtime test zcode
tigercat runtime test kimicode
tigercat runtime test trae
```

通过 `tigercat feishu connect --runtime <运行时 ID>` 为飞书选择内核，例如 `tigercat feishu connect --runtime kimicode`。七种运行时也可用于插件 Worker 和 `coordinator_runtime`，同名的 `runtime add` 配置会覆盖内置项。

| 运行时 | 自动保留的凭据环境变量 |
|---|---|
| `claude-code` | `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`，或本机登录 |
| `codex` | `CODEX_API_KEY`、`OPENAI_API_KEY`，或本机登录及所选 provider 的 `env_key` |
| `deepseek-harness` | `DEEPSEEK_API_KEY` |
| `pi` | `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY`，或本机登录 |
| `zcode` | 使用本机 ZCode 登录与配置 |
| `kimicode` | `KIMI_API_KEY`、`KIMI_MODEL_API_KEY`、`KIMI_WEB_SEARCH_API_KEY`，或本机登录 |
| `trae` | `TRAECLI_PERSONAL_ACCESS_TOKEN`，或本机登录 |

Worker 按所选内核保留上表凭据。额外的提供方密钥可通过自定义 runtime 的 `env` 配置传入，该配置会明文保存。`TIGERCAT_CLAUDE_BIN` 和 `TIGERCAT_CODEX_BIN` 分别下传为 `CLAUDE_CODE_EXECUTABLE` 和 `CODEX_PATH`。Pi 和 ZCode 的路径分别下传为 `PI_ACP_PI_COMMAND` 和 `ZCODE_BIN`。无图形界面的 Codex 可设置 `NO_BROWSER=1`。

Claude Code 和 Codex 的 adapter 随项目依赖及插件 bundle 固定。Pi 和 ZCode 的社区 adapter 在首次启动时通过 `npx` 下载固定版本，需要网络和 npm。已有本地项目依赖时优先使用该依赖。Claude Code、Codex 的版本固定于 2026-11-18，Pi、ZCode 的版本固定于 2026-11-27。

可用 `TIGERCAT_RUNTIME_LIVE=1` 强制测试真实启动路径，所选产品仍需满足其 CLI 和凭据要求。

```bash
TIGERCAT_RUNTIME_LIVE=1 tigercat runtime test claude-code
TIGERCAT_RUNTIME_LIVE=1 tigercat runtime test codex
```

Claude Code 使用 `CLAUDE_AGENT_ACP_PROTOCOL=v1`。ZCode 使用 `ZCODE_ACP_MODE=build`，由 TigerCat 的权限策略处理 ACP 审批。七种内核默认 `permission = "ask"`，飞书渠道的交互权限行为见渠道文档。

已经安装独立 ACP 可执行文件时，可通过 `TIGERCAT_CLAUDE_CODE_ACP`、`TIGERCAT_CODEX_ACP`、`TIGERCAT_DEEPSEEK_HARNESS_ACP`、`TIGERCAT_PI_ACP`、`TIGERCAT_ZCODE_ACP`、`TIGERCAT_KIMICODE_ACP`、`TIGERCAT_TRAE_ACP` 指定完整路径。这些入口会直接启动，所需子命令应写在包装脚本中。

```bash
TIGERCAT_CLAUDE_CODE_ACP=/usr/local/bin/claude-agent-acp tigercat runtime test claude-code
TIGERCAT_CODEX_ACP=/usr/local/bin/codex-acp tigercat runtime test codex
```

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
