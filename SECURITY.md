# 安全策略

[简体中文](SECURITY.md) | [English](docs/i18n/en/SECURITY.md) | [日本語](docs/i18n/ja/SECURITY.md) | [한국어](docs/i18n/ko/SECURITY.md) | [Español](docs/i18n/es/SECURITY.md)

## 报告漏洞

请通过 [GitHub Private Vulnerability Reporting](https://github.com/tornado1110/tigercat/security/advisories/new) 私下报告安全漏洞。

请不要为疑似漏洞开公开的 issue、discussion 或 pull request。在任何公开说明之前，给维护者时间确认并修复。

不要在 issue、pull request、提交、日志或 discussion 里发布密钥。这包括 API key、令牌、密码、会话 cookie 和私有端点。如果密钥已经泄露，先吊销它，再通过上面的私密渠道报告这次暴露。

## 受支持的版本

TigerCat 尚未到 1.0。安全修复只进入最新的发布版。

## 安全模型

TigerCat 协调 worker agent。它不是凭据的存放处，自己也不修改检出。

1. API key 和令牌通过环境变量，或该 runtime 自己的认证提供。它们不会被提交。错误文本和事件载荷在打印或保存之前会先脱敏；具体模式，以及覆盖不到的情况，写在 [docs/operations.md](docs/operations.md)。`config.toml` 不是存放密钥的地方。
2. 凭据绝不能进入模型的上下文：不能出现在 coordinator 的 prompt、worker 的 prompt、工具结果或事件摘要里。
3. Worker 的权限请求默认是 `ask`。TigerCat 默认不会自动批准这些请求。
4. coordinator 不能直接改代码。它只把工作分发给 worker agent。
