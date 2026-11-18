// Minimal stdio MCP server that stays alive after initialize.
// Used to prove `tigercat acp` exits when the client closes stdin
// even if an MCP child is still running.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined || message.method === undefined) continue;
    if (message.method === "initialize") {
      const version = message.params?.protocolVersion ?? "2025-06-18";
      write(message.id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-hold", version: "0.0.0" },
      });
    } else if (message.method === "tools/list") {
      write(message.id, { tools: [] });
    } else {
      write(message.id, {});
    }
  }
});

function write(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
