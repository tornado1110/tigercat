import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callTool } from "./ipc.js";
import { toolNamesForRole, type RouterToolName } from "./tools.js";

/**
 * MCP process launched by a downstream ACP agent via `mcpServers`.
 * Router registrations are exactly {@link toolNamesForRole}("router"),
 * which is asserted to contain no shell or edit tools.
 */
export async function serveMcp(options: {
  port: number;
  token: string;
  role: "router" | "worker";
}): Promise<void> {
  await createMcpServer(options).connect(new StdioServerTransport());
}

/** Shared registrations for the ACP bridge and the host-driven plugin. */
export function createMcpServer(options: {
  port: number;
  token: string;
  role: "router" | "worker";
}): McpServer {
  const names = toolNamesForRole(options.role);
  const server = new McpServer({ name: "tigercat", version: "0.1.0" });
  for (const name of names) {
    server.registerTool(
      name,
      {
        description: describe(name as RouterToolName),
        inputSchema: schemas[name] ?? z.object({}),
      },
      async (args) => {
        try {
          const result = await callTool({
            port: options.port,
            token: options.token,
            role: options.role,
            method: name,
            params: args,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true, content: [{ type: "text" as const, text: message }] };
        }
      },
    );
  }
  return server;
}

const schemas: Record<string, ReturnType<typeof z.object> | undefined> = {
  spawn: z.object({
    runtime: z.string(),
    task: z.string().optional(),
    prompt: z.string().optional(),
    cwd: z.string().optional(),
    repo: z.string().optional(),
    thread: z.string().optional(),
    threads: z.array(z.string()).optional(),
  }),
  resume: z.object({ id: z.string(), input: z.string() }),
  list: z.object({}),
  send: z.object({ id: z.string(), input: z.string() }),
  read: z.object({ id: z.string(), since: z.number().optional() }),
  interrupt: z.object({ id: z.string() }),
  wait: z.object({
    ids: z.array(z.string()),
    mode: z.enum(["any", "all"]),
    timeout: z.number(),
  }),
  kill: z.object({ id: z.string() }),
  subscribe: z.object({ worker: z.string(), thread: z.string() }),
  unsubscribe: z.object({ worker: z.string(), thread: z.string() }),
};

function describe(name: string): string {
  switch (name) {
    case "spawn":
      return "Start a Worker. Returns immediately with its id.";
    case "resume":
      return "Resume a lost or interrupted Worker on its existing worktree.";
    case "list":
      return "List Workers and states.";
    case "send":
      return "Send follow-up input to a Worker.";
    case "read":
      return "Read Worker state or events. Use a worker.turn_end id for the full result.";
    case "interrupt":
      return "Cancel the current Worker turn. Keeps its worktree and subscriptions.";
    case "wait":
      return "Wait for Workers to settle, then read their results.";
    case "kill":
      return "End a Worker and release subscriptions. Keeps its worktree.";
    case "subscribe":
      return "Route future messages from a Thread to a Worker.";
    case "unsubscribe":
      return "Stop routing a Thread to a Worker.";
    default:
      return name;
  }
}
