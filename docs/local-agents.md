# 本机 Claude Code 与 Codex

TigerCat 会自动探测当前进程 `PATH` 中的 `claude` 和 `codex`。先查看探测结果：

```bash
npm run build
node dist/cli.js runtime discover --json
```

`vendorPath` 是实际发现的绝对路径。`runtime test claude-code` 和
`runtime test codex` 会优先使用发现的本机二进制，并通过项目内固定版本的 ACP
adapter 完成 `initialize`、`session/new` 和 `session/prompt`。没有厂商二进制时
只运行本地 dry-run，不会读取凭据；插件 bundle 也包含这两个 adapter，不依赖
首次启动时的 npx 缓存。

## 在 Codex 中使用

构建 `plugins/codex/` 后，把整个目录作为本地插件源。仓库内的
`.agents/plugins/marketplace.json` 已提供 `tigercat-local` marketplace；在支持
本地 marketplace 的 Codex 客户端中选择 TigerCat 并启用。插件的 `runtimes` 工具
会返回本机 Claude Code/Codex 的发现结果，`spawn` 使用当前项目的绝对 `cwd`。

也可以直接把 MCP 服务注册到当前 Codex 配置：

```toml
[mcp_servers.tigercat]
command = "node"
args = ["/absolute/path/to/tigercat/plugins/codex/server/cli.js", "plugin"]
```

## 在 Claude Code 中使用

Claude Code 支持同一个 MCP 服务。使用构建后的绝对路径注册一次：

```bash
claude mcp add --scope user tigercat -- node \
  /absolute/path/to/tigercat/plugins/codex/server/cli.js plugin
claude mcp list
```

这条路径让 Claude Code 作为当前会话的 Router 使用 TigerCat；TigerCat 仍可在
Worker runtime 中启动另一个 Claude Code 或 Codex。两层角色通过独立 MCP token
隔离。

## 飞书 mock

还没有真实发送时，可以显式打开进程内 mock：

```bash
TIGERCAT_LARK_MOCK=1 node plugins/codex/server/cli.js plugin
```

mock 提供 `lark_status`、`lark_discover`、`lark_execute` 和 `lark_api`。GET
以及 read 调用返回确定性 fixture；POST/PUT/PATCH/DELETE 和 write 仍要求宿主
提供 MCP elicitation，并且只有确认后才会记录 mock 调用。真实 `lark-cli` 只有
在绑定了 account、profile、credential home 和 revision 后才会出现。
