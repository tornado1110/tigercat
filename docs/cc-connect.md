# 把 tigercat acp 接到 cc-connect

这一页说明怎样让 cc-connect 把 `tigercat acp` 当作一个通用 ACP agent 拉起来。宿主保持原样：本仓库不修改 cc-connect。TigerCat 在这条路径上只提供 ACP agent。飞书或钉钉频道归宿主。

本页保留下面的宿主注册。飞书 → cc-connect → TigerCat → Worker 的四步仍是这条接入要覆盖的场景。本页没有跑过这四步，没有把 M0 标成通过，也没有录像。

这里不加 cc-connect 的安装步骤。宿主自己的文档决定它把 agent 注册写在哪个文件里。

## 启动 `tigercat acp`

`tigercat --help` 列出的启动方式是：

```bash
tigercat acp
tigercat acp --config /path/to/config.toml
```

进程停在前台，在 stdin 和 stdout 上说换行分隔的 JSON-RPC。没有 `start`、`stop` 或守护进程子命令。cc-connect 是父进程。日志和 ACP 流量共用这两条流。不要把密钥管道进 prompt。

`cmd = "tigercat"` 要求 `tigercat` 在宿主的 `PATH` 上。README 的检出步骤是：

```bash
npm install
npm run build
npm link
```

`bin/tigercat.js` 加载 `dist/cli.js`，所以命令能启动之前必须 `npm run build`。在检出目录里、不 link 时：

```bash
node bin/tigercat.js acp
node bin/tigercat.js acp --config /path/to/config.toml
```

省略 `--config` 时，`TIGERCAT_CONFIG` 和 `--config` 是同一种覆盖。默认文件是 `~/.tigercat/config.toml`。文件不存在时用内置默认值，在 `runtime add` 或 `runtime remove` 之前什么都不写。

数据库是 `TIGERCAT_DB`，或者是配置路径同一目录下的 `tigercat.sqlite`。默认是 `~/.tigercat/tigercat.sqlite`。一个数据库只跑一个进程。不要把 `tigercat list` 指向 cc-connect 正在使用的那个库。前台的停止、重启和恢复写在 [docs/operations.md](operations.md)。

`tigercat acp` 用 `process.cwd()` 作为工作区根。宿主拉起进程时的工作目录就是这个根。Worker 目录建在那棵树下：git 检出里是 `.tigercat/worktrees/<workerId>`，否则是 `.tigercat/workers/<workerId>`。

## 宿主注册

下面这段由宿主加载。TigerCat 不读取 `type`、`cmd` 或 `args`。本仓库也不加载这段 TOML。

```toml
type = "acp"
cmd = "tigercat"
args = ["acp"]
```

宿主要带上配置文件时，把 CLI 已经接受的 flag 放进同一条命令：

```toml
type = "acp"
cmd = "tigercat"
args = ["acp", "--config", "/path/to/config.toml"]
```

`/path/to/config.toml` 是占位路径。不要在那个文件里写 API key、令牌或飞书应用密钥。

`initialize` 报告的 `agentInfo.name` 是 `tigercat`，`loadSession` 是 false。上游的 TigerCat agent 不提供 `session/load`。

## 配置和规则

[`examples/config.example.toml`](../examples/config.example.toml) 是脚本化演示。它没有设置 `coordinator_runtime`，`default_worker_runtime` 是内置的 `claude-code`。复制它不会得到一个模型 Router，也不会把 Worker 选成 `codex`。

`coordinator_runtime` 留空，并且不写 `router.provider` 时，`tigercat acp` 使用本进程里的脚本化 brain。那个 brain 不调用模型。它按 `default_worker_runtime` 点名的 runtime 去 spawn，并把该 Trigger 的 Thread key 交给 `spawn` 的 `threads`。代码里这个名字的默认值是字符串 `worker`。`worker` 不是内置的。没有配置文件时，脚本化 brain 决定 spawn 的 Trigger 会失败，错误是 `unknown runtime worker`。

内置 Worker 的名字是 `claude-code` 和 `codex`。要让脚本化 brain 点名 Codex，在实际加载的配置里写：

```toml
default_worker_runtime = "codex"
```

这只选定名字。本页没有对着真实的 Codex 二进制跑过。

`router.provider = "deepseek"` 会换成 DeepSeek Chat Completions，密钥来自 `DEEPSEEK_API_KEY` 或配置里的环境变量名。不要把密钥写进 `config.toml`。不要同时设置 `router.provider` 和 `coordinator_runtime`。两条都设置时进程不启动，错误是 `router_conflict`。DeepSeek 这条路径的说明在 README，本页没有做实机测试。ACP coordinator 仍然是另外安装的程序，用 `coordinator_runtime` 点它的名字。

省略 `[filter]`，或写了 `[filter]` 但没有 `rules` 时，规则来自 [`examples/rules.default.toml`](../examples/rules.default.toml)，版本 `2026-11-19.1`。第一条规则的名字是 `upstream-acp`：`source = "acp"`，结果是 `respond`。引擎按规则顺序做第一次匹配，没有在规则之外把 `acp` 特殊处理。配置里自己写了 `filter.rules` 时，这份列表替换默认规则。

内置 Worker 的权限是 `ask`。`tigercat acp` 不会自动回答 Worker 的 `ask`。卡住的权限看起来像一个到不了 `worker.turn_end` 的 Worker。`runtime add --env` 把值以明文写进 `config.toml`。那个文件不是密钥库。

三套凭据分开的写法在 [docs/operations.md](operations.md)。不要把飞书令牌抄进 TigerCat 的配置或 `runtime env`。Worker 的继承环境会去掉 `CC_SESSION_KEY`、`CC_PROJECT` 和 Router 的密钥。明确支持的厂商凭据仍可供内置 Worker 使用。

## source 与 Thread

cc-connect 送来的每条 prompt 都记成 `source` `acp`。飞书话题经宿主进来时，source 仍然是 `acp`。

Thread key 只有在 `_meta.thread_id` 是字符串时才用那个字符串。否则 Thread 是 `acp:<sessionId>`。宿主把飞书话题 id 放进 `_meta.thread_id` 时，source 不变。同一个 ACP 会话里，不传 `_meta.thread_id` 的 prompt 共用 `acp:<sessionId>`。不同话题要分成不同 Thread，由宿主为每条 prompt 设置不同的 `_meta.thread_id`。本仓库不修改宿主去替它填写。

默认的第一条规则把 `source = "acp"` 准入为 `respond`。此时：

- 该 Thread 已经有 Worker 订阅时，Trigger 进入那个 Worker 的收件队列。不产生 Router 回合。
- 还没有订阅者时，Trigger 进入 Router。脚本化 brain 对 `respond` 执行 spawn，并订阅这次传入的 Thread key。

宿主重投同一条事件时，应复用 `_meta.event_id`（非空字符串）；可同时传 `_meta.timestamp`（非负毫秒时间戳）。同一身份只接纳一次，内容变更返回冲突。有事件 ID 但省略时间时使用稳定的 `0`。不传事件 ID 的普通 prompt 仍是独立提交。认领后未完成的提交返回 `ingest_incomplete`，需要核对已有执行。`_meta.author` 缺省是 `user`。`_meta.kind` 缺省是 `im.message`。`_meta.is_bot` 只有在值是 true 时才记成 bot。

## prompt 返回之后

`session/prompt` 在 Worker 还在跑时就会返回，这样宿主可以再接受下一条消息。已经结束的 Worker 会在这次回复里多一行 `Worker <id> finished: ...`。脚本化 brain 自己的回复行是 `started <workerId> on <threadId>`。没有进入 Router、而是直接交给已订阅 Worker 时，回复行是 `Delivered to <n> worker(s).`。

对外转发的 Worker 事件只有 `worker.turn_end` 和 `worker.error`。`worker.update` 不在这条发送里。prompt 返回之后的 `session/update` 不是飞书发送。

接纳 prompt 时，TigerCat 记下当时的 `CC_SESSION_KEY`、`CC_PROJECT`（有值才记），以及 `TIGERCAT_CC_CONNECT_BIN`（未设置时命令名是 `cc-connect`）。记下的 `CC_SESSION_KEY` 非空时，上述终态事件随后用 `cc-connect send --stdin` 送出，包括在这次 prompt 返回前已经结束的事件。消息在 stdin 上，不放在命令行上。cc-connect 在启动 ACP agent 时注入 `CC_SESSION_KEY`。本页不给出这个变量的值。

Worker 仍在跑、且没有 `CC_SESSION_KEY` 时，prompt 里的说明是：`Worker <id> is still running. This prompt is returning. The result will not reach Feishu.` 后面接着 `CC_SESSION_KEY is unset. cc-connect injects it when it starts the ACP agent. A session/update after session/prompt returns is not a Feishu send: cc-connect buffers that text until an EventResult, and its ACP adapter emits EventResult only when session/prompt returns.` 有 `CC_SESSION_KEY` 时，对应的一行是 `Worker <id> is still running. This prompt is returning so another message can be accepted. The result is sent afterwards with cc-connect send.`

`cc-connect send` 的正文取 Worker 事件里的文本。本页没有一份带 diff 或 PR 链接的 Router 摘要。

就代码而言，四步对应的是：

1. 没有订阅者的 `source = "acp"` prompt 在默认规则下是 `respond`。脚本化 brain spawn `default_worker_runtime`，并订阅宿主给出的 Thread key。这不是一次已经记录的飞书话题实跑。
2. 另一条 prompt 带着另一个 `_meta.thread_id` 时，那是另一个 Thread。前一条的 prompt 已经返回，宿主可以再送下一条。两个飞书话题的实机全双工没有跑过。
3. 原 Thread 上已有订阅，并且准入结果是 `respond` 时，后续 Trigger 进入该 Worker，不经过 Router。
4. Worker 发出 `worker.turn_end` 或 `worker.error`，并且接纳 prompt 时记下了 `CC_SESSION_KEY`，TigerCat 用 `cc-connect send --stdin` 送出 Worker 文本。

## 没有证明的内容

- 飞书四步端到端没有跑过。
- M0 没有通过。[TESTING.md](../TESTING.md) 里「Feishu via cc-connect」仍是 not run。本页不去勾选那里的实机项，也不改 [docs/operations.md](operations.md) 的未验证行。
- 工具隔离没有证明。`tigercat acp` 不检查 Worker 自带的 shell、编辑或写文件工具。`tigercat plugin` 在那些原生工具还在时拒绝启动。那次拒绝是另一个命令，不是工具隔离。
- 本页没有录像，也不把 README 里的实机演示标成已完成。
- 真实的 DeepSeek、Claude Code、Codex、cc-connect 和飞书都没有为写这一页而跑过。

## 不经过 cc-connect 的飞书命令

`tigercat --help` 还有：

```text
tigercat feishu [connect] [--cwd repo] [--runtime name] [--config file]
```

`tigercat feishu connect` 和 `tigercat feishu` 是另一个进程。它不加载上面的宿主片段，不把入站消息记成 `source` `acp`，也不读取 `_meta.thread_id`。接入步骤在 [docs/im-channels.md](im-channels.md)。应用密钥留在本机绑定或进程环境里。不要把密钥写进本文件、`config.toml`、issue 或 pull request。

这条进程可以在没有 cc-connect 的情况下看四步对话各自落在哪里。本页没有跑过它。它不替换上面的宿主注册，也不替换该场景对 cc-connect 的完成条件。

- 一条私聊，或一条已授权群里的 @，会为那个会话启动一个 Worker。`tigercat feishu connect` 在没有已配置的默认 Worker 时，先发现本机 Codex，再发现 Claude Code。
- 另一个会话是另一个 Worker。前一个还在执行时，后一个也可以处理。这是渠道进程里的并行，不是 ACP Router 对另一条 prompt 的回复。
- 原会话里的下一条消息交给同一个 Worker。运行时支持 ACP steering 时，补充消息并入当前轮；否则上一轮结束后再执行并回复。
- Worker 结束后，渠道把 Worker 文本回复到发起那条消息一次。那是渠道回复，不是 Router 写的摘要，也不是一份 diff 或 PR 链接。

issue 6 的完成条件仍然包括：未修改的 cc-connect 宿主、本页的注册方式，以及 README 用的短录像。本页给出注册方式。录像和四步实跑都不在这里。
