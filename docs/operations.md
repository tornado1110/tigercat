# 运行 TigerCat

[简体中文](operations.md) | [English](i18n/en/operations.md) | [日本語](i18n/ja/operations.md) | [한국어](i18n/ko/operations.md) | [Español](i18n/es/operations.md)

这一页说明本仓库今天这个进程怎么操作。它不增加命令。`tigercat --help` 里没有列出的命令，就不存在。

这里没有任何一项对着真实的 DeepSeek 账号、Claude Code、Codex、cc-connect 或飞书跑过。那些行标成未验证。CI 会跑的检查标成已测试。

## 已经实现的行为

| 行为 | 状态 |
| --- | --- |
| `tigercat acp` 在 stdin/stdout 上说 ACP | 已实现；上游一致性是 `npm run test:tck`，在那个 harness 跑得起来的地方 |
| 内置的 `claude-code` 和 `codex` profile | 已实现；CI 用 `test/stub-agent.ts` 和它们握手，不是厂商二进制 |
| 没有厂商二进制时的 `runtime test` | 已测试；dry-run agent，`vendorExecuted: false`，不读取 API key |
| 带 `TIGERCAT_CLAUDE_BIN` / `TIGERCAT_CODEX_BIN` 或 `TIGERCAT_RUNTIME_LIVE=1` 的 `runtime test` | 已实现；CI 里没跑，写这篇文档时也没跑 |
| `coordinator_runtime` 留空时的脚本化 Router | 已用进程内的脚本化 brain 测试过 |
| `coordinator_runtime` 点名的 ACP Router 进程 | 已实现（`launchCoordinator`）；没有对着真实模型跑过 |
| sqlite 里的 Thread、事件日志和未送达的 Router 队列在新进程里还在 | 已实现，在 `Engine.start` 里 |
| Worker 的 ACP 会话在重启后还在 | 内置的 `claude-code` 和 `codex` 不声明 `loadSession`。在它们上面重启会把 Worker 标成 `lost`，记一条 `worker.lost`，订阅回到 Router。回合已经结束（`idle` 或 `awaiting_input`）且 runtime 自己声明 `loadSession` 并且 `session/load` 成功时，才恢复原来的 ACP session id 并留下订阅。`running` 或 `starting` 的回合没有结果，即使能 `session/load` 也标成 `lost`，`reason` 是 `in_flight_turn`。成功路径只用 stdio stub 测过，没有对着真实的 Claude Code 或 Codex 跑过 |
| 下次启动时回收孤儿 worker 进程 | 已实现。记录的 pid 如果命令行还对得上这个 runtime，恢复前会杀掉。用 stdio stub 测过。Windows 上只有读得到命令行并且对得上时才杀 |
| TigerCat 内部的飞书或钉钉 | 未实现；那些频道留在宿主里 |
| DeepSeek Chat Completions Router（`router.provider = "deepseek"`） | 已实现；读取 `DEEPSEEK_API_KEY`；未做实机测试 |

## 布局

TigerCat 是一个前台进程。本仓库里没有 `start`、`stop`、`restart`，也没有 service unit。

```bash
tigercat --help
tigercat --version
tigercat acp
tigercat acp --config /path/to/config.toml
```


省略 flag 时，`TIGERCAT_CONFIG` 和 `--config` 是同一种覆盖。默认文件是 `~/.tigercat/config.toml`。文件不存在时用内置默认值，在 `runtime add` 或 `runtime remove` 之前什么都不写。

数据库是 `TIGERCAT_DB`，或者是配置路径同一目录下的 `tigercat.sqlite`。默认是 `~/.tigercat/tigercat.sqlite`。一个数据库只跑一个进程。这段代码直接打开 `node:sqlite`，不会协调第二个写入者。

[`examples/config.example.toml`](../examples/config.example.toml) 是脚本化演示。它没有给出 Router 可执行文件的名字。复制它不会得到一个模型。见下面的[脚本演示和真实 Router](#脚本演示和真实-router)。

`runtime list` 打印名字、command、args、permission，以及这一行是不是内置的。它不打印环境变量的值。

`runtime discover` 使用当前宿主的 `PATH` 和显式 `TIGERCAT_CLAUDE_BIN`、`TIGERCAT_CODEX_BIN`/`CODEX_PATH` 覆盖来探测本地厂商二进制。它只把存在且可执行的文件标为已发现，并显示绝对路径；不会运行二进制、联网或读取 API key。`runtime test` 仍然是实际握手的入口。

## 凭据

`router.provider = "deepseek"` 时，`tigercat acp` 读取 `DEEPSEEK_API_KEY`（或配置里的那个环境变量名），变量缺失就在任何请求之前退出。这次调用没有做过实机测试。Worker 的凭据来自文档列出的厂商变量，或具体 runtime 的显式 `env` 表。

Worker 不会原样继承宿主环境。TigerCat 会移除 Router、插件、飞书、cc-connect 的配置路径和令牌，以及继承来的密钥形状变量；明确支持的厂商凭据（`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CODEX_API_KEY`、`OPENAI_API_KEY` 和对应的二进制路径）仍可供内置 Worker 使用。runtime 自己的 `env` 表在过滤之后合并，因此只应把确实需要的变量显式写入该 runtime；它会以明文保存到 `config.toml`。Worker 不能通过继承环境读取 Router 的 `DEEPSEEK_API_KEY` 或 cc-connect 的 `CC_SESSION_KEY`。

三套凭据要分开：

1. **Router。** `router.provider = "deepseek"` 用 `DEEPSEEK_API_KEY` 里的密钥调用 DeepSeek Chat Completions。这条路径没有做过实机测试。不要把密钥放进 `config.toml`。不写 `router.provider` 就继续用脚本化 brain，它不会调用模型。ACP coordinator 仍然是你另外安装的程序，用 `coordinator_runtime` 点它的名字。不要同时设置 `router.provider` 和 `coordinator_runtime`。
2. **Worker（`claude-code`、`codex`）。** 两者都内置，权限是 `ask`。Claude Code 使用已有的 `claude` 登录，或 `ANTHROPIC_API_KEY`。Codex 使用 `CODEX_API_KEY` 或 `OPENAI_API_KEY`。这些是厂商程序自己的变量，TigerCat 不解析它们。`TIGERCAT_CLAUDE_BIN` 会作为 `CLAUDE_CODE_EXECUTABLE` 往下传。`TIGERCAT_CODEX_BIN` 会作为 `CODEX_PATH` 往下传。Worker 的继承环境会经过过滤；其他密钥请通过具体 runtime 的 `env` 显式传递，并注意它会明文写入配置。优先用各产品自己的登录文件。
3. **cc-connect 和飞书。** 频道归宿主。TigerCat 的注册只有：

   ```toml
   type = "acp"
   cmd = "tigercat"
   args = ["acp"]
   ```


   不要把飞书令牌抄进 TigerCat 的配置或 `runtime env`。`tigercat acp` 把每条上游 prompt 记成 `source` `acp`。第一条默认规则把 `source = "acp"` 准入为 `respond`。只有宿主设置了 `_meta.thread_id` 时才会用到飞书的 thread id；source 仍然是 `acp`。飞书往返没有跑过。

`runtime add --env K=V` 把值以明文写进 `config.toml`。那个文件不是密钥库。除非值是厂商二进制这种非密钥路径，否则把 `env` 留空。

内置 worker 在代码里是 `ask`。示例不添加 runtime 行，所以不设置 `permission`。`runtime add --permission` 接受 `ask`、`auto` 或 `deny`。

## 脚本演示和真实 Router

这是两件不同的事。示例文件只是第一件。

### 脚本演示

`coordinator_runtime` 保持不设置。于是 `cmdAcp` 不会调用 `launchCoordinator`。Router 是本进程里的 `ScriptedRouter`。它按 `default_worker_runtime` 点名的 runtime 去 spawn，不调用模型。

代码里这个名字的默认值是字符串 `worker`。这个名字不是内置的。没有配置文件时，脚本化 brain 决定 spawn 的 trigger 会失败，错误是 `unknown runtime worker`。示例把 `default_worker_runtime` 设为 `claude-code`，那是内置的。

README 里的检出步骤是：

```bash
npm install
npm run build
npm link
```


`bin/tigercat.js` 加载 `dist/cli.js`，所以命令能启动之前必须 `npm run build`。`npm link` 是 README 用来把 `tigercat` 放到 `PATH` 上的办法。在检出目录里、不 link 时：

```bash
node bin/tigercat.js --help
node bin/tigercat.js runtime list
node bin/tigercat.js acp
```


复制示例是可选的。它仍然不会启动一个模型：

```bash
mkdir -p ~/.tigercat
cp examples/config.example.toml ~/.tigercat/config.toml
tigercat runtime list
tigercat acp
```


这时 `runtime list` 会显示内置的 `claude-code` 和 `codex`。它不会显示 Router 命令，因为示例没有添加。`tigercat acp` 停在前台，在 stdin 和 stdout 上说换行分隔的 JSON-RPC。没有 `claude` 二进制且没有设置 `TIGERCAT_RUNTIME_LIVE` 时，脚本化 brain 以 `claude-code` spawn 的 worker 用的是 dry-run agent。这条路径不读 API key。它仍然不是模型。

### 真实的 ACP Router

前提，这里不提供：一个你自己安装并配置好的 ACP agent 可执行文件。本仓库不附带它，里面没有名为 `router-acp` 的程序，也不写如何安装 DeepSeek 或任何其他模型。

那份程序已经在机器上时，用 `tigercat --help` 已经列出的命令注册它。尖括号是占位符，不是可以照抄的命令：

```bash
tigercat runtime add <name> --command <existing-acp-agent> --permission ask
```


然后在你实际加载的配置文件里把 `coordinator_runtime` 设为 `<name>`。`tigercat acp` 会 spawn 那个命令。找不到命令时，启动失败，错误是 `bad_runtime`。不要把占位符写进 `config.toml` 再把它当成能用的 Router。

cc-connect 或任何其他 ACP 客户端是 `tigercat acp` 的父进程。日志和 ACP 流量共用 stdin 和 stdout。不要把密钥管道进 prompt。README 里的宿主片段（`type = "acp"`、`cmd = "tigercat"`、`args = ["acp"]`）不是本仓库会加载的文件，飞书往返也没有跑过。这一页不加 cc-connect 的安装步骤。

## 启动

`tigercat acp` 就是前台进程。没有守护进程命令。

`tigercat acp` 用 `process.cwd()` 作为工作区根。Worker 目录建在那棵树下：git 检出里是 `.tigercat/worktrees/<workerId>`，否则是 `.tigercat/workers/<workerId>`。

在牵涉模型之前先检查内置项。`PATH` 上没有 `claude` 或 `codex`，且没有设置 `TIGERCAT_RUNTIME_LIVE` 时，下面的命令不读 API key：

```bash
tigercat runtime test claude-code
tigercat runtime test codex
```


JSON 报告里是 `mode` `dry-run` 和 `vendorExecuted` false。真实 adapter 的启动方式是 `tigercat --help` 里的手动命令。写这篇文档时的测试没有执行它。

## 停止

没有 stop 子命令。

干净的路径是 ACP 客户端关掉 stdin。然后 `serveUpstream` 返回，`engine.close()` 要求每个仍活着的 worker handle 退出，IPC 监听和 sqlite handle 被关掉。

这条路径还会在 500ms 后安排 `process.exit(0)`，并在上游 MCP 客户端都关掉时再安排一次。Worker 的拆除在这个窗口里是尽力而为。它不是保证排空。

这段代码里 SIGINT 和 SIGTERM 没有处理函数。在 POSIX 上，worker 进程是 detached 启动的，所以只杀死 TigerCat 进程的信号会把它们留在后面。下次启动会看保存的 pid。命令行还对得上这个 runtime 的孤儿进程会在恢复前被杀掉。

## 重启和恢复

重启的意思是：停下前台进程，然后用同一份配置和数据库再跑 `tigercat acp`。

然后 `Engine.start`：

- 已有的 Router 会话行留在原地，或者插入一行
- 把还在途中的 Router 队列行退回 pending，并把 `router_busy` 设为 `0`
- 对每个非终态 Worker，先处理记录的 pid。命令行还对得上 runtime 的活进程会被杀掉。状态是 `running` 或 `starting` 时，这一轮没有结果：Worker 标成 `lost`，记一条 `worker.lost`，`reason` 是 `in_flight_turn`，`message` 是 `in-flight turn was lost on restart`，订阅释放，下一条事件走 Router。这时不因为 `session/load` 成功就把 Worker 改成 `idle`。回合已经结束（`idle` 或 `awaiting_input`）并且 runtime 声明了 `loadSession` 且 `session/load` 成功时，才在新进程里加载原来的 ACP session id，状态保持不变，Thread 订阅保留，下一条事件直接交给这个 Worker。没有 session id、runtime 不声明 `loadSession`，或 `session/load` 失败时，也标成 `lost` 并丢掉订阅。`code` 是 `lost`，其余 `reason` 是 `no_session`、`load_unsupported`、`load_failed` 或 `session_mismatch`，`message` 是 `worker session could not be restored after restart`

Thread 和事件日志还在。worktree 目录留在磁盘上。`removeWorkspace` 存在，但这条路径不调用它。

内置的 `claude-code` 和 `codex` 不声明 `loadSession`。在它们上面，重启走 `lost`，订阅回到 Router。上面说的留下订阅，只发生在回合已经结束、并且 runtime 自己声明了 `loadSession` 且 `session/load` 成功的时候，目前只用 stdio stub 验证过。

`interrupted` 留给显式 interrupt，重启不写这个状态。`interrupt` 取消当前回合并保留订阅，不会把 Worker 标成 `lost`。`resume` 接受已经处于 `lost` 或 `interrupted` 的 Worker：用调用方给出的新输入，在原来的 worktree 上开一个新的 ACP session。这不是 `session/load`。

不会发生的事：

- 上游的 TigerCat agent 仍然声明 `loadSession: false`。`runtime test` 仍然报告 `degraded: ["loadSession"]`，因为它只做 `session/new`，不调用 `session/load`。
- 死掉的进程不会继续显示为 `running` 或 `starting`。状态是这两个值时，记录的 pid 必须还活着。
- 加载失败时不会悄悄新建一个 ACP session。那是 `resume` 做的事。

一次性命令 `list`、`send`、`read`、`interrupt`、`wait`、`kill`、`subscribe`、`unsubscribe` 和 `spawn` 会打开同一个数据库，并自己调用 `Engine.start`。对一个还有非终态 Worker 的数据库跑 `tigercat list`，会恢复能 `session/load` 的 Worker，并把其余的标成 `lost`，哪怕另一个 `tigercat acp` 还握着它们。不要把这些命令指向正在运行的进程的数据库。没有只读的状态命令。

## 日志

事件载荷和 CLI 错误文本在保存或打印之前会经过脱敏：

- runtime `env` 里名字含 `key`、`token`、`secret`、`password` 或 `credential` 的精确值
- 父进程环境里同类变量，当值至少 8 个字符且不含引号或花括号
- 传给 `tigercat mcp --token` 的本机 IPC 令牌
- `Authorization` 的 bearer/basic/digest 头，`x-api-key` / `api_key` 赋值，密钥类名字的 `NAME=value`，对应的 JSON 字段，以及 `sk-` / `sk-ant-` / `sk-proj-` 令牌

握手失败时，提供者的 stderr 只有在这次擦除之后才会放进 `bad_runtime` 错误。单元测试用的是固定的假字符串，例如 `fake-bearer-token-0001`。它们不调用提供者。

prompt 文本按提交时的原样保存。`trigger.ingested` 不复制那段文本，但 trigger 行和 Router 队列会。脱敏不会改写 prompt。粘进消息里的密钥仍然在 sqlite 里，并且可能交给 Router。不要把密钥粘进 prompt。

限制，未对照真实提供者验证：印成上面任何一种形状都对不上的密钥、短于 4 个字符的值（父进程环境是 8）、或含有引号或花括号的值，仍然可能出现。不要把脱敏当成唯一控制。不要把密钥放进 prompt、规则文本或 `config.toml`。

`runtime list` 不打印 `env`。如果你写过，配置文件里仍然有它。

## 排障

`runtime test` 的 JSON 里 `ok: false` 且 `mode: "dry-run"`，表示 dry-run 进程失败了，不是 Claude Code 或 Codex 拒绝了密钥。`mode: "adapter"` 表示这个进程启动了 adapter。`vendorExecuted: false` 表示没有运行厂商二进制。

`unknown runtime <name>` 表示这个名字既不是内置的，也不是所加载配置文件里的 `command`。检查 `--config` 和 `TIGERCAT_CONFIG`。

`max concurrency <n> reached` 是配置里的 `max_concurrency`（默认 4）。它计算处于 `starting` 或 `running` 的 Worker。

崩溃之后，`tigercat list --json` 自己会跑恢复。回合已经结束并且 `session/load` 成功的 Worker 保持原来的 `idle` 或 `awaiting_input`。还在回合中的 Worker 显示 `lost`。在那之后再启动 `tigercat acp`，或者直接启动 `acp` 让它做同样的恢复。只有回合已经结束且 `session/load` 成功时，原来的 ACP session id 还在。失败或回合中断时不要指望旧 id 还能用。

如果两个 `tigercat acp` 进程指向同一个 sqlite 文件，把两个都停掉。这段代码不会修复两个写入者用过的数据库。

权限提示会留在 Worker 上，直到有东西回答。`tigercat acp` 里没有任何东西会自动回答 Worker 的 `ask` 策略。卡住的权限看起来像一个永远到不了 `worker.turn_end` 的 Worker。

## 这棵树里还没有的东西

- 没有 Router 可执行文件，也没有它的安装步骤。什么都不再装时，唯一会跑的 Router 是进程内的脚本化 brain。
- DeepSeek Chat Completions Router 已实现（`router.provider = "deepseek"`，密钥来自 `DEEPSEEK_API_KEY`）。它没有做过实机测试。默认仍然是脚本化 brain。
- 默认的 worker runtime 名字 `worker` 不是内置的。
- 重启会尝试下游 `session/load`。内置的 `claude-code` 和 `codex` 不声明 `loadSession`，因此标成 `lost`，订阅回到 Router。stdio stub 覆盖了加载成功、不声明 `loadSession`，以及 `session/load` 失败。没有对着真实的 Claude Code 或 Codex 跑过。SIGINT 和 SIGTERM 仍然没有处理函数。
- `session.pid` 在 worker 握手返回之后才写入。这个 pull request 没有改这一点，也没有加等待。过早读取 pid 的 Windows 测试，是开发阶段的进程启动竞态。
- 每个数据库一个 `node:sqlite` handle。第二个写入者不被协调。
- prompt 文本按提交时的原样保存。
- 真实的 DeepSeek、Claude Code、Codex、cc-connect 和飞书都没有跑过。
