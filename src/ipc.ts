import { connect, createServer, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import type { ToolApi } from "./brains.js";
import { isTigerError, TigerError } from "./errors.js";
import { toolNamesForRole } from "./tools.js";

export interface IpcEndpoint {
  port: number;
  /** Router credential; retained as token for existing host callers. */
  token: string;
  workerToken: string;
  close(): Promise<void>;
}

/**
 * Localhost JSON-lines bridge so an MCP server process (launched by a
 * downstream agent) can call the resident engine. Credentials bind the role
 * on every request; a client-supplied role can never grant more access.
 */
export async function listenForTools(tools: ToolApi): Promise<IpcEndpoint> {
  const token = randomBytes(16).toString("hex");
  const workerToken = randomBytes(16).toString("hex");
  const sockets = new Set<Socket>();
  let closing: Promise<void> | undefined;
  const server: Server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    bindSocket(socket, token, tools, workerToken);
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
    workerToken,
    close: () => {
      closing ??= new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // server.close alone waits for idle and blocked request sockets forever.
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}

/** The legacy three-argument form accepts a Router credential only. */
export function bindSocket(socket: Socket, token: string, tools: ToolApi, workerToken?: string): void {
  let buffer = "";
  socket.setEncoding("utf8");
  // Peer resets and writes racing shutdown must not crash the host process.
  socket.on("error", () => undefined);
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      void handleLine(socket, token, workerToken, tools, line);
    }
  });
}

async function handleLine(socket: Socket, token: string, workerToken: string | undefined, tools: ToolApi, line: string): Promise<void> {
  let message: { id?: unknown; token?: unknown; method?: unknown; params?: unknown; role?: unknown };
  try {
    message = JSON.parse(line) as typeof message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
  } catch {
    return;
  }
  const id = message.id ?? null;
  const role = message.token === token ? "router" : workerToken && message.token === workerToken ? "worker" : undefined;
  if (!role) {
    write(socket, { id, error: { code: "unauthorized", message: "bad token" } });
    return;
  }
  if (message.role !== undefined && message.role !== role) {
    write(socket, { id, error: { code: "unauthorized", message: "token does not authorize the requested role" } });
    return;
  }
  const method = typeof message.method === "string" ? message.method : "";
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
    case "resume":
      if (!tools.resume) throw new TigerError("unknown_tool", "resume is unavailable on this bridge");
      return tools.resume(String(input.id ?? ""), String(input.input ?? ""));
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
  if (socket.destroyed || !socket.writable) return;
  socket.write(`${JSON.stringify(message)}\n`);
}

export function callTool(options: {
  port: number;
  token: string;
  role: "router" | "worker";
  method: string;
  params: unknown;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(options.port, "127.0.0.1");
    const id = randomBytes(8).toString("hex");
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        try {
          const message = JSON.parse(line) as { id?: string; result?: unknown; error?: { code?: string; message: string } };
          if (!message || message.id !== id) continue;
          if (message.error) {
            const error = typeof message.error.code === "string"
              ? new TigerError(message.error.code, message.error.message)
              : new Error(message.error.message);
            finish(error);
          } else {
            finish(undefined, message.result);
          }
          return;
        } catch {
          finish(new Error("Invalid IPC response."));
          return;
        }
      }
    });
    socket.on("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("IPC connection ended before a response.")));
    socket.once("close", () => finish(new Error("IPC connection closed before a response.")));
    socket.once("connect", () => {
      try {
        socket.write(`${JSON.stringify({
          id,
          token: options.token,
          role: options.role,
          method: options.method,
          params: options.params,
        })}\n`);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
