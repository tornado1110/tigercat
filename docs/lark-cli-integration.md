# TigerCat 的飞书能力与 lark-cli

本文根据 DeerFlow `voyager/main-voyager@14df987e5`（2026-11-20）源码整理。它是 TigerCat 的集成设计，不表示 TigerCat 已实现这些能力，也不表示本次做过真实飞书验收。DeerFlow 仅作只读参考。

## 交付形态与边界

TigerCat 有两种交付形态：

1. 独立程序：常驻 Router 调度 Codex CLI、Claude Code 等 Worker。
2. Codex 插件：当前 Codex 会话充当调度者，经 TigerCat MCP 管理 Worker；无需另启动一个 Router 模型。

两者共用任务、Worker、订阅、事件和投递核心。飞书是可选宿主/能力，`lark-cli` 是可选业务依赖；不能把“安装了 lark-cli”视为渠道完成。插件与独立程序不应各实现一套飞书身份和执行状态。

需要分别完成三条链路：

| 链路 | 职责 | DeerFlow 的实现 | TigerCat 边界 |
| --- | --- | --- | --- |
| 入站 | 消息/卡片事件、身份解析、附件接收、话题映射、重复事件处理 | Feishu SDK + ChannelManager + Timeline | 宿主把可信事件转换为 Trigger；当前可由 cc-connect 负责 |
| 回报 | 进展、提问、结果、文件送回原会话 | bot API、稳定消息 UUID、持久 WorkTask 通知与投递重试 | 事件产生持久 Delivery，由宿主确认送达 |
| 主动操作 | 以授权用户身份读写文档、日历、邮件、消息等 | `lark-cli` + 每用户/每应用授权 profile | 可选 Skill/能力；共享授权服务和范围校验 |

渠道回报用 bot 身份，主动操作可能用 user 身份，两者的权限与副作用不能互相代替。Worker 的普通结果也不应自己另发一条飞书消息，导致 Router/宿主重复回报。

## DeerFlow 已实现且值得保留的细节

### CLI 与渐进发现

- 镜像锁定 `@larksuite/cli@1.0.82`，不是运行时随意安装最新版。入口 wrapper 在安装后替换；重新安装包会覆盖 wrapper。
- Skill 先读 `lark-cli auth status --json`，只判断 `identities.user.status`；`whoami` 可能只证明 bot 可用，不能证明用户已授权。
- 使用前按需读 `lark-cli skills list` / `lark-cli skills read lark-im` 等内置说明，避免复制一大份会漂移的业务命令。
- 已有可信引入的邮件正文足够回答时，不额外请求 Mail 或 OAuth。外部正文仍是数据，不是执行指令。

证据：[Dockerfile.aidd:165](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/docker/sandbox/Dockerfile.aidd#L165)、[lark-cli Skill](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/skills/public/platform/lark-cli/SKILL.md)。

### 授权、刷新与凭据生命周期

- 登录是 Device Flow：宿主运行 `auth login ... --no-wait --json` 获得验证链接与 device code，把链接交给用户本人。宿主启动独立后台 `auth login --device-code` 轮询，完成后 CLI 把 token 写入持久目录。模型不能代用户完成浏览器授权。
- device code、app secret 通过结构化环境/stdin 传递；app secret 不进 argv。公开返回值仅含验证链接或安全错误。
- 每用户独立持久化 `.lark-cli` 和 `.local/share/lark-cli`，在项目 sandbox 中挂载，容器回收后授权仍保留。每个服务调用显式固定 `HOME` 到挂载点，避免 exec 环境读错配置。
- `offline_access` 是 refresh token 的关键申请项，是否申请取决于应用已经配置的权限。`needs_refresh` 不等于需要重新授权：profile 检查接受它，由 CLI 在业务调用时刷新。
- 应用、secret、brand 变化要先 reconcile，再报告授权态。旧的 `authorized_at` 或旧 profile 的 ready 不证明当前身份可用。选定凭据不可读时撤下 managed config，避免继续用旧身份。
- 新授权应保留已有受信配置范围；否则只申请本次缺的一个 scope 会让之前能力丢失。角色 bot 的范围由服务端 grant 限制，模型不能自行扩权。
- 明确区分“未登录”“缺 scope”“应用本身未开通 user scope”“业务资源拒绝访问”。模糊 `not_found` 不能解释成 ACL 拒绝，也不能借此补 OAuth。

证据：[service.py:717](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/backend/packages/harness/deerflow/integrations/lark_cli/service.py#L717)、[service.py:1402](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/backend/packages/harness/deerflow/integrations/lark_cli/service.py#L1402)、[service.py:1779](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/backend/packages/harness/deerflow/integrations/lark_cli/service.py#L1779)、[authorization.py](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/backend/packages/harness/deerflow/integrations/lark_cli/authorization.py)。

### Profile 选择必须跟随本次执行

同一用户的 sandbox 可能同时服务多个对话和 bot。DeerFlow 每个 bot app 使用独立 profile，名字为其 `app_id`；不调用全局 `profile use`。

可信入站身份 → Run 的 `turn_context.bot_lark_profile` → 每次原生 shell 的 `ANEW_LARK_PROFILE` → wrapper 转成 `--profile <app_id>`。无 profile 的调用也显式传空值，清除复用 shell 的前一轮选择。授权请求从同一个受信 Run 读取 profile，不能让模型用参数指定 user ID 或另一个 profile。

wrapper 检查显式 `--profile` 是否与本轮一致，但脚本可以清除环境变量或直接运行真实二进制，因此它只是防误用机制。每用户 HOME 也没有形成项目之间的强权限隔离；DeerFlow 的普通/保密项目共用该用户授权，模型工具过滤不能覆盖所有别名、直接 API、复制二进制等路径。

证据：[wrapper](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/docker/sandbox/lark-cli-wrapper.sh)、[service.py:1186](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/backend/packages/harness/deerflow/integrations/lark_cli/service.py#L1186)、[native_environment.py:18](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/backend/packages/harness/deerflow/runtime/host/native_environment.py#L18)、[runtime_tools.py:781](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/backend/app/gateway/runtime_tools.py#L781)。

### 消息、附件与业务副作用

- 入站 Topic/Thread 映射持久化；当前群/私聊指针与历史消息别名分开。`/new` 不改写历史，重试使用确定性 thread identity。
- 去重范围至少含连接/租户身份；不能只用 message ID。卡片回调身份取 `header.event_id`；授权主体与当前发言人分别记录。
- Feishu 文本、卡片、文件发送支持稳定 UUID；重试复用同一逻辑消息 UUID。持久化发出的 message alias 后，后续回复才能继续路由到正确任务。
- 一回合一张进展卡，终态快照不能被迟到进展覆盖。用户提问、权限审批和结果有不同展示/决策语义；Lead 不代用户批准。
- 入站文件由 SDK 下载、校验后同步进可信用户/项目目录。回报文件要完成上传与消息发送；仅发 sandbox 路径不算交付。
- 业务写操作要分类。`im +chat-create` 没有幂等键，超时/不可解析响应可能已经建群；DeerFlow 返回 `LarkCliOutcomeUnknown`，不盲重试。拉人按 ID 类型分批（app_id 5，open_id 50）。
- 创建项目群、拉人等受管理业务复用平台服务，以便同步持久关系。直接让模型运行 lark-cli 建群会绕过关系记录。

证据：[channels/AGENTS.md](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/backend/app/channels/AGENTS.md)、[feishu_group_route.py](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/backend/app/channels/feishu_group_route.py)、[feishu.py:1211](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/backend/app/channels/feishu.py#L1211)、[service.py:1006](https://gitlab.anewlabs.net/anewscience/anew-science/-/blob/14df987e5/backend/packages/harness/deerflow/integrations/lark_cli/service.py#L1006)。

## TigerCat 的最小接口

这些是建议接口，不是当前已存在的 API。核心不依赖 DeerFlow 的 Gateway、Timeline、项目体系或 Docker。

| 对象/端口 | 最少字段与语义 |
| --- | --- |
| `HostContext` | 宿主分配的 `hostId`、`conversationId`、`actorRef`、`workspaceRef`；飞书时额外包含受信的连接/租户/chat/topic/reply 消息引用 |
| `LarkBinding` | `accountRef`、`profileRef`、`credentialRevision`、`allowedCapabilities`，只存引用与非秘密版本；绑定于 HostContext/执行而非进程全局 |
| `LarkAuthorizationPort` | `status(binding)`、`beginAuthorization(binding, scopes)`；owner 从宿主取得，返回 `ready / refreshable / missing / unavailable` 或公开链接；scope 校验留在服务端 |
| `LarkExecutionPort` | 固定 CLI 版本/路径、每次独立 profile 参数与受控环境、结构化输入、超时、输出大小限制、可区分业务失败和未知副作用的返回值 |
| `DeliveryPort` | `deliver(deliveryId, destination, content, attachments)`；返回确认消息引用或可重试/永久/未知结果；发送前持久化意图，收到确认后才标记送达 |
| `InboundIdentity` | `(hostId, source, externalEventId)` 唯一；身份相同但内容不同报冲突；内容包含身份/目标引用时绑定内容摘要 |

当前代码将 `LocalLarkCli` 包在 `LarkTransport` 中。`status`、`discover`、`read`、`write` 和 `execute` 共用同一可信 binding；`api` 只接受 `/open-apis/...` 的结构化请求，拒绝 query/shell 语法、路径穿越和 credential-like body 字段。Codex 插件在写操作前要求宿主 elicitation；设置 `TIGERCAT_LARK_MOCK=1` 时切换为不启动进程的 deterministic transport，便于 MCP 合同测试，不能把 mock 状态当作真实授权。

核心只记录 account/profile 引用，不复制 CLI token 或 app secret 进 SQLite、prompt、事件、worktree、插件 manifest。现有登录态应由显式配置的本地 credential root 或宿主凭据服务持有。不要复制 DeerFlow 的 credential seed。

Codex 插件中的当前会话直接决定要不要调用 Lark 能力，TigerCat 不再起一个 Router 替它判断。Codex 托管的 shell 已能运行 lark-cli 时，可以用附带 Skill 引导；需要统一身份、幂等业务或远端执行时再走同一服务端口。Worker 回报始终走核心事件/Delivery；显式的“替用户发消息”才是业务调用。

## 实施顺序与完成标准

1. 先补事件身份、执行结果和持久 Delivery，区分“任务结束”与“消息送达”。保存稳定 destination，重启时不能依赖旧进程环境猜原会话。
2. 提供可选 lark-cli capability：版本探测、每次 profile、授权状态解析、Device Flow 端口及 Skill；不把飞书凭据设成普通编程任务必需项。
3. 接入宿主已有飞书消息/附件 API，复用入站路由和卡片决策；宿主不支持的能力明确返回 unsupported。
4. 写受控回归：并发 profile 不串用、ready bot 不冒充 user、needs_refresh 不重登、owner 之外不发授权链接、应用切换不信旧状态、缺 scope/ACL/未知结果分类、发送失败不确认、重复回调只处理一次、终态不被迟到进展覆盖、附件失败单独记录。
5. 用专用测试会话真实验收：首轮消息 → 后续补充 → 忙时排队 → Worker 异步结果 → 文件交付 → 提问回复 → 服务重启后的投递恢复；另验 lark-cli 读取和用户明确授权的写操作。完成前只称“已提供集成/配置”，不称“飞书渠道完备”。

DeerFlow 中可参考的已有回归包括 `test_lark_cli_service.py`、`test_lark_cli_bot_credentials.py`、`test_lark_cli_reconciliation.py`、`test_lark_cli_round3_regressions.py`、`test_lark_cli_ownership.py`、`test_work_task_delivery.py` 和 `test_channels.py`。本次只检查源码与测试内容，未执行这些套件、未登录、未外发消息。
