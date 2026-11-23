# 本地个人资料工具

这层是个人助手的通用资料能力。它把授权来源中的对象发现、用户确认、本地快照、变化检测和关闭跟踪拆开，业务场景只需要选择来源和查询条件。文档、邮件、会议纪要和消息都使用同一套资源接口，审稿只是其中一种使用方式。

## CLI

```bash
export TIGERCAT_LARK_PROFILE_REF=cli_xxx
export TIGERCAT_LARK_CREDENTIAL_HOME="$HOME"

tigercat personal scan --source documents --query "" --json
tigercat personal scan --source mail --query "待处理" --json
tigercat personal scan --source minutes --query "项目" --json
tigercat personal scan --source messages --query "需要确认" --json
tigercat personal confirm documents:docx:<resource-id>
tigercat personal refresh --json
tigercat personal list
tigercat personal close documents:docx:<resource-id>
```

`scan` 只读取来源并返回带稳定 id 的候选资源。`confirm` 读取资源内容并保存本地基线。`refresh` 重新读取已确认资源并报告变化。`list` 和 `close` 只操作本地跟踪状态。所有跟踪数据写入 TigerCat 本地 SQLite，工具不会发送消息或修改来源内容。

## Codex 插件工具

插件提供 `personal_resources_scan`、`personal_resources_confirm`、`personal_resources_refresh` 和 `personal_resources_list`。`personal_resources_scan` 接受 `source`、`query`、`sinceDays` 和 `limit`，来源适配器负责把不同平台的返回数据映射成统一的 `ResourceCandidate`。

## 扩展方式

新增来源只实现 `ResourceSource` 的 `search` 和 `read`。跟踪、快照哈希、变化摘要、SQLite 持久化和用户确认流程都由 `PersonalResourceTracker` 复用。飞书目前提供 documents、mail、minutes 和 messages 四个只读来源，后续可加入其他 IM 或云盘适配器，不需要复制一套业务跟踪逻辑。
