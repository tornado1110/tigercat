# IM 渠道

## 启动飞书

1. 在飞书开放平台创建企业自建应用，启用机器人。添加接收消息事件 `im.message.receive_v1`，订阅方式选长连接。给应用授予接收私聊、群内 @ 消息和以应用身份发送消息的权限。发布应用并将机器人加入要接入的群。
2. 为渠道配置一个 Worker 运行时。文本渠道使用 `permission = "deny"`，或使用你已明确配置为 `auto` 的运行时。内置运行时默认使用 `ask`。可通过 `tigercat runtime add <name> --command <ACP adapter> --permission deny` 注册运行时。
3. 将以下环境变量传给 TigerCat 进程。应用密钥放在本机环境或进程的密钥配置中。

| 环境变量 | 值 |
| --- | --- |
| `TIGERCAT_FEISHU_APP_ID` | 企业自建应用的 App ID |
| `TIGERCAT_FEISHU_APP_SECRET` | 应用密钥 |
| `TIGERCAT_FEISHU_BOT_OPEN_ID` | 机器人在本应用下的 Open ID |
| `TIGERCAT_FEISHU_ALLOWED_USERS` | 允许触发 Worker 的用户 Open ID，逗号分隔 |
| `TIGERCAT_FEISHU_ALLOWED_CHATS` | 可选，允许触发 Worker 的群 Chat ID，逗号分隔 |

```sh
tigercat feishu --cwd /absolute/path/to/repo --runtime feishu-worker
```

从源码运行时先执行 `npm ci` 和 `npm run build`，再把上面的 `tigercat` 换成 `node dist/cli.js`。日志出现 `Feishu WebSocket connected.` 后，从允许的账号给机器人发送一条私聊。群消息需要 @ 配置的机器人，结果会通过原消息回复到话题。

进程在配置文件旁创建 `feishu-<app-id>.sqlite`，记录收到的消息 ID、Worker 事件和待发送的结果。每个应用数据库只能由一个进程持有。异常退出后若遗留 `.lock`，确认旧进程退出后再删除。每个会话一次执行一条文本，其他会话可各自运行。进程重启后，下条新消息会创建 Worker，旧工作区保留。已接收但被重启打断的任务需用一条新消息提交。第一版支持文本来回，附件与交互卡片需单独接入。

## 新增一个 IM 适配器

`serveImChannel` 管理引擎、数据库和进程生命周期。`ImChannel` 根据渠道实例与会话标识查找 Worker，按会话排队，按提供方消息 ID 去重，并通过 SQLite 投递队列交付结果。一个适配器实例使用一个独立数据库。

参考 `src/feishu.ts`，新适配器实现以下边界：

- `connect` 管理 SDK 连接，验证渠道身份与访问规则，再把入站事件转换为 `ImMessage`。消息 ID 对提供方重投必须稳定，会话标识要包含足够的租户、群或话题信息。
- `replyTarget` 保存回复所需的地址，例如原消息 ID。它会持久化，凭据放在适配器的进程环境里。
- `transport.send` 实现提供方回复。收到成功确认时返回 `delivered`。可以证明未发送时返回 `not_sent`，由公共队列做有上限的重试。结果未知时返回 `unknown`，队列保留该状态等待核对。支持消息幂等键的提供方可以从 `eventId` 派生键。
