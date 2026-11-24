# 参与贡献 TigerCat

[简体中文](CONTRIBUTING.md) | [English](docs/i18n/en/CONTRIBUTING.md) | [日本語](docs/i18n/ja/CONTRIBUTING.md) | [한국어](docs/i18n/ko/CONTRIBUTING.md) | [Español](docs/i18n/es/CONTRIBUTING.md)

感谢你帮助改进 TigerCat。本文说明如何准备检出、提交信息必须怎么写，以及如何开 pull request。

## 开发环境

TigerCat 运行在 Node.js 22.13 或更高版本上（见 `package.json` 的 `engines`）。如果仓库里有 `.nvmrc`，用它来选择这个 Node 版本。

```bash
git clone https://github.com/tornado1110/tigercat.git
cd tigercat
npm ci
```

开 pull request 之前，请运行：

```bash
npm run lint
npm run typecheck
npm test
```

改动了构建会编译的代码时，也要运行 `npm run build`。

这些命令覆盖的范围写在 [TESTING.md](TESTING.md)。真实 agent 的端到端测试不在 CI 里跑，因为它们需要付费的 API key。那篇文档说明 CI 实际跑什么。不要把 API key 放进仓库或 pull request。

## 提交信息

提交信息必须遵循 [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)。[Release Please](RELEASING.md) 读取它们来维护 `CHANGELOG.md`，并开出版本发布的 pull request。不符合这一约定的提交不会进入 changelog，也不会提升版本号。

使用下面的形式：

```text
<type>[optional scope][!]: <short summary>

[optional body]

[optional footer]
```

摘要使用英文祈使句、小写，并且结尾不加句号。

| 类型 | 何时使用 | 版本提升 |
| --- | --- | --- |
| `feat` | 用户可见的能力 | minor（`0.1.0` 到 `0.2.0`） |
| `fix` | 缺陷修复 | patch（`0.1.0` 到 `0.1.1`） |
| `feat!` 或 `BREAKING CHANGE:` 页脚 | 破坏性变更 | 版本处于 `0.x` 时为 minor；从 `1.0.0` 起为 major |
| `docs`、`test`、`chore`、`ci`、`refactor`、`perf`、`build` | 其余情况 | 无，除非该提交被标为破坏性变更 |

示例：

```text
feat: route a stalled task to another ACP runtime

fix(client): retry a worker session that closed before the first event

docs: describe the permission ask default
```

包版本仍是 `0.x` 时，破坏性变更提升 minor，而不是直接跳到 `1.0.0`。即便如此，也要在页脚写明：

```text
feat!: drop the legacy session id field

BREAKING CHANGE: session ids from 0.1 are not accepted.
```

## Pull request

1. 从最新的 `main` 拉出分支。
2. 改动保持集中。一个 pull request 只做一件事。
3. 每次提交都使用 Conventional Commits。如果 pull request 以 squash 方式合并，标题必须是一条 Conventional Commit，因为这个标题会成为 `main` 上的那条提交。
4. 运行 `npm run lint`、`npm run typecheck` 和 `npm test`。填好 pull request 模板，包括你如何测试。
5. 不要提交密钥、令牌、`.env` 文件，或含有这些内容的日志。
6. 等待审阅。除非你是维护者且仓库规则允许，否则不要合并自己的 pull request。

维护者合并 Release Please 开出的发布 pull request。贡献者不向 npm 发布。见 [RELEASING.md](RELEASING.md)。

## 安全

按 [SECURITY.md](SECURITY.md) 的说明私下报告漏洞。不要为安全报告开公开 issue，也不要在 issue、pull request 或 discussion 里粘贴密钥。

## 行为准则

本项目遵循 [Contributor Covenant](CODE_OF_CONDUCT.md)。参与即表示你同意该准则。

## 翻译

文档以简体中文为唯一事实来源。改文档时先写中文，译文随后跟上。用下面的命令查看哪些译文已经落后：

```bash
npm run docs:i18n-check
```

每份译文的第一行是来源标记。它记下中文源文件的仓库路径，以及该文件的 git blob 哈希。取 `git rev-parse HEAD:<path>` 的完整 40 位，也就是对换行已规范成 LF 的文件内容做 `git hash-object`：

```html
<!-- i18n-source: <path> @ <blob> -->
```

不要写提交 SHA。本仓库只用 rebase 合并，提交 SHA 在合并时会被改写，短 `%h` 的长度也会变。

该命令在比较前把 CRLF 换成 LF，来源 blob 不一致时提示译文落后。它也会对照 HEAD 检查更新。如果更新来源 blob 时正文未改，或译文正文与原文一致，命令会返回非零退出码。检查已提交的译文时，可在命令末尾加上 `-- --base <revision>` 指定对照版本。PR 的 CI 使用目标分支作对照。

欢迎母语者审阅译文并提交 pull request。日语、韩语和西班牙语目前由机器辅助生成，尚未经母语者审阅。
