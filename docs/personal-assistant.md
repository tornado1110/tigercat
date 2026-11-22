# 本地个人助手闭环

TigerCat 的个人助手先把飞书用户数据读回本机，再由用户确认哪些文档需要持续跟踪。机器人通道只负责交互，用户 profile 负责读取文档内容，两种身份不会互相替代。

## 本地命令

```bash
export TIGERCAT_LARK_PROFILE_REF=cli_xxx
export TIGERCAT_LARK_CREDENTIAL_HOME="$HOME"

tigercat personal scan --json
tigercat personal confirm docx:<token-1> docx:<token-2> docx:<token-3>
tigercat personal refresh --json
tigercat personal list
tigercat personal close docx:<token-1>
```

`scan` 使用用户身份读取最近更新的 `docx` 和 `wiki` 文档，返回带标题、链接、负责人和候选理由的列表。`confirm` 只读取一次正文并把基线哈希写入 TigerCat 本地 SQLite。`refresh` 重读正文，发现变化时返回差异摘要和原文链接。所有跟踪状态保存在本机，命令不会发送消息、催办作者或修改飞书文档。

飞书机器人进程设置同样的四个 `TIGERCAT_LARK_*` 绑定变量后，会在原私聊中识别“扫描稿件”“盯住这三篇”“刷新稿件”和“结束跟踪第 2 篇”。普通消息仍交给本地 Worker。

## Codex 插件工具

绑定 `lark-cli` 后，插件提供 `lark_personal_scan`、`lark_personal_confirm`、`lark_personal_refresh` 和 `lark_personal_list`。这些工具复用插件数据库和同一份可信 profile binding，适合由 Codex 当前对话承接候选确认和后续判断。

## 当前边界

候选扫描是保守的最近更新文档召回，用户确认后才开始跟踪。作者催办、飞书卡片主动推送、邮箱和会议纪要的统一候选排序仍应建立在这条只读闭环通过真实五天验证之后。
