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

`node server/cli.js plugin` 会拒绝启动。Codex 插件模式的 Router 会话仍带有宿主原生的 shell、编辑和写文件工具，TigerCat 不能检查或移除它们，因此进程不会启动，也不会改用更松的权限模式。这不是工具隔离，M0 没有通过。

构建 `plugins/codex/` 后，可以把整个目录作为本地插件源。仓库内的
`.agents/plugins/marketplace.json` 已提供 `tigercat-local` marketplace。启用后
MCP 进程仍会拒绝启动，`runtimes` 和 `spawn` 不会对当前会话暴露。

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

同一 MCP 入口也会拒绝启动。Claude Code 会话同样自带原生 shell、编辑和写文件工具，TigerCat 不能检查或移除它们。拒绝启动不是工具隔离。

Worker runtime 仍可在独立模式里启动另一个 Claude Code 或 Codex。两层角色通过独立 MCP token
隔离。

## 飞书 mock

插件进程会在注册 Lark 工具之前拒绝启动，因此下面的命令现在也不会进入 mock。宿主不能证明原生 shell、编辑和写文件工具已经从 Router 会话拿掉时，`TIGERCAT_LARK_MOCK=1` 不会让启动继续。

```bash
TIGERCAT_LARK_MOCK=1 node plugins/codex/server/cli.js plugin
```

若进程能够启动，mock 提供 `lark_status`、`lark_discover`、`lark_execute` 和 `lark_api`。GET
以及 read 调用返回确定性 fixture；POST/PUT/PATCH/DELETE 和 write 仍要求宿主
提供 MCP elicitation，并且只有确认后才会记录 mock 调用。真实 `lark-cli` 只有
在绑定了 account、profile、credential home 和 revision 后才会出现。
