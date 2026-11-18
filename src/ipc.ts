import { createServer, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import type { ToolApi } from "./brains.js";
import { isTigerError } from "./errors.js";
import { toolNamesForRole } from "./tools.js";

export interface IpcEndpoint {
  port: number;
  token: string;
  close(): Promise<void>;
}

/**
 * Localhost JSON-lines bridge so an MCP server process (launched by a
 * downstream agent) can call the resident engine. The token is required
 * on every request.
 */
export async function listenForTools(tools: ToolApi): Promise<IpcEndpoint> {
  const token = randomBytes(16).toString("hex");
  const server: Server = createServer((socket) => {
    bindSocket(socket, token, tools);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("IPC server did not bind a TCP port");
  }
  return {
    port: address.port,
    token,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function bindSocket(socket: Socket, token: string, tools: ToolApi): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      void handleLine(socket, token, tools, line);
    }
  });
}

async function handleLine(socket: Socket, token: string, tools: ToolApi, line: string): Promise<void> {
  let message: { id?: unknown; token?: unknown; method?: unknown; params?: unknown; role?: unknown };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return;
  }
  const id = message.id ?? null;
  if (message.token !== token) {
    write(socket, { id, error: { code: "unauthorized", message: "bad token" } });
    return;
  }
  const method = typeof message.method === "string" ? message.method : "";
  const role = message.role === "worker" ? "worker" : "router";
  if (!toolNamesForRole(role).includes(method)) {
    write(socket, { id, error: { code: "unknown_tool", message: `unknown tool ${method}` } });
    return;
  }
  try {
    const result = await dispatch(tools, method, message.params);
    write(socket, { id, result });
  } catch (error) {
    write(socket, {
      id,
      error: {
        code: isTigerError(error) ? error.code : "error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function dispatch(tools: ToolApi, method: string, params: unknown): Promise<unknown> {
  const input = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "spawn":
      return tools.spawn({
        runtime: String(input.runtime ?? ""),
        task: typeof input.task === "string" ? input.task : undefined,
        prompt: typeof input.prompt === "string" ? input.prompt : undefined,
        cwd: typeof input.cwd === "string" ? input.cwd : undefined,
        repo: typeof input.repo === "string" ? input.repo : undefined,
        thread: typeof input.thread === "string" ? input.thread : undefined,
        threads: Array.isArray(input.threads) ? input.threads.map(String) : undefined,
      });
    case "list":
      return tools.list();
    case "send":
      return tools.send(String(input.id ?? ""), String(input.input ?? ""));
    case "read":
      return tools.read(String(input.id ?? ""), typeof input.since === "number" ? input.since : undefined);
    case "interrupt":
      return tools.interrupt(String(input.id ?? input.worker ?? ""));
    case "wait":
      return tools.wait(
        Array.isArray(input.ids) ? input.ids.map(String) : [],
        input.mode === "all" ? "all" : "any",
        typeof input.timeout === "number" ? input.timeout : 0,
      );
    case "kill":
      return tools.kill(String(input.id ?? ""));
    case "subscribe":
      return tools.subscribe(String(input.worker ?? ""), String(input.thread ?? ""));
    case "unsubscribe":
      return tools.unsubscribe(String(input.worker ?? ""), String(input.thread ?? ""));
    default:
      throw new Error(`unknown tool ${method}`);
  }
}

function write(socket: Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

export async function callTool(options: {
  port: number;
  token: string;
  role: "router" | "worker";
  method: string;
  params: unknown;
}): Promise<unknown> {
  const { connect } = await import("node:net");
  const socket = connect(options.port, "127.0.0.1");
  const id = randomBytes(8).toString("hex");
  const result = new Promise((resolve, reject) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        const message = JSON.parse(line) as { id?: string; result?: unknown; error?: { message: string } };
        if (message.id !== id) continue;
        socket.end();
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
    socket.on("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  socket.write(
    `${JSON.stringify({
      id,
      token: options.token,
      role: options.role,
      method: options.method,
      params: options.params,
    })}\n`,
  );
  return result;
}
