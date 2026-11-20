import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolApi } from "../../src/brains.js";
import { bindSocket, callTool, listenForTools } from "../../src/ipc.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

describe("IPC credential-bound roles", () => {
  it("permits Worker reads but rejects role elevation and Router tools with a Worker credential", async () => {
    const tools = fakeTools();
    const endpoint = await listenForTools(tools);
    closers.push(endpoint.close);
    expect(endpoint.workerToken).not.toBe(endpoint.token);
    await expect(callTool({ port: endpoint.port, token: endpoint.workerToken, role: "worker", method: "read", params: { id: "worker-a" } }))
      .resolves.toEqual({ id: "worker-a" });
    await expect(callTool({ port: endpoint.port, token: endpoint.workerToken, role: "router", method: "spawn", params: { runtime: "test", task: "task" } }))
      .rejects.toMatchObject({ code: "unauthorized" });
    await expect(callTool({ port: endpoint.port, token: endpoint.workerToken, role: "worker", method: "kill", params: { id: "worker-a" } }))
      .rejects.toMatchObject({ code: "unknown_tool" });
    expect(await rawRequest(endpoint.port, { token: endpoint.workerToken, method: "spawn" })).toMatchObject({ error: { code: "unknown_tool" } });
    expect(tools.spawn).not.toHaveBeenCalled();
    expect(tools.kill).not.toHaveBeenCalled();
  });

  it("preserves Router access without a role field and rejects every explicit mismatch", async () => {
    const tools = fakeTools();
    const endpoint = await listenForTools(tools);
    closers.push(endpoint.close);
    expect(await rawRequest(endpoint.port, { token: endpoint.token, method: "list" })).toMatchObject({ result: [] });
    await expect(callTool({ port: endpoint.port, token: endpoint.token, role: "router", method: "spawn", params: { runtime: "test", task: "task" } }))
      .resolves.toMatchObject({ workerId: "worker-a" });
    await expect(callTool({ port: endpoint.port, token: endpoint.token, role: "worker", method: "read", params: { id: "worker-a" } }))
      .rejects.toMatchObject({ code: "unauthorized" });
    expect(await rawRequest(endpoint.port, { token: endpoint.token, role: "admin", method: "list" })).toMatchObject({ error: { code: "unauthorized" } });
    expect(await rawRequest(endpoint.port, { token: "invalid", method: "list" })).toMatchObject({ error: { code: "unauthorized" } });
    expect(tools.spawn).toHaveBeenCalledTimes(1);
    expect(tools.read).not.toHaveBeenCalled();
  });

  it("keeps the three-argument bindSocket credential Router-only", async () => {
    const tools = fakeTools();
    const server = createServer((socket) => bindSocket(socket, "legacy-router", tools));
    const port = await openServer(server);
    closers.push(() => closeServer(server));
    expect(await rawRequest(port, { token: "legacy-router", method: "list" })).toMatchObject({ result: [] });
    expect(await rawRequest(port, { token: "legacy-router", role: "worker", method: "read" })).toMatchObject({ error: { code: "unauthorized" } });
    expect(tools.read).not.toHaveBeenCalled();
  });
});

describe("IPC connection shutdown", () => {
  it("closes blocked requests and half-open sockets without awaiting tool completion", async () => {
    let started!: () => void;
    let complete!: (result: unknown) => void;
    const waitStarted = new Promise<void>((resolve) => { started = resolve; });
    const tools = fakeTools({ wait: async () => {
      started();
      return new Promise((resolve) => { complete = resolve; });
    } });
    const endpoint = await listenForTools(tools);
    closers.push(endpoint.close);
    const pending = callTool({ port: endpoint.port, token: endpoint.token, role: "router", method: "wait", params: { ids: ["worker-a"], mode: "all", timeout: 30_000 } });
    // Attach the rejection handler before closing the transport.
    const rejected = expect(pending).rejects.toThrow(/IPC connection (ended|closed)/);
    await waitStarted;
    const idle = connect(endpoint.port, "127.0.0.1");
    idle.on("error", () => undefined);
    await new Promise<void>((resolve) => idle.once("connect", resolve));
    const idleClosed = new Promise<void>((resolve) => idle.once("close", () => resolve()));
    await within(Promise.all([endpoint.close(), endpoint.close(), rejected, idleClosed]), 1_000);
    expect(idle.destroyed).toBe(true);
    // A late result must not write to the destroyed socket or crash the host.
    complete({ status: "timeout", done: [] });
    await Promise.resolve();
  });

  it("rejects when the peer ends before replying", async () => {
    const server = createServer((socket) => {
      socket.resume();
      socket.end();
    });
    const port = await openServer(server);
    closers.push(() => closeServer(server));
    await expect(callTool({ port, token: "test", role: "router", method: "list", params: {} }))
      .rejects.toThrow(/IPC connection (ended|closed)/);
  });

  it("rejects malformed replies without throwing from a socket event handler", async () => {
    const server = createServer((socket) => {
      socket.resume();
      socket.end("invalid JSON\n");
    });
    const port = await openServer(server);
    closers.push(() => closeServer(server));
    await expect(callTool({ port, token: "test", role: "router", method: "list", params: {} }))
      .rejects.toThrow("Invalid IPC response");
  });

  it("handles connection refusal with one rejected promise", async () => {
    const server = createServer();
    const port = await openServer(server);
    await closeServer(server);
    await expect(callTool({ port, token: "test", role: "router", method: "list", params: {} }))
      .rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

function fakeTools(overrides: Partial<ToolApi> = {}): ToolApi {
  return {
    spawn: vi.fn(async () => ({ status: "started" as const, workerId: "worker-a", threadId: "thread-a" })),
    list: vi.fn(async () => []),
    send: vi.fn(async () => ({ status: "started" as const })),
    read: vi.fn(async (id) => ({ id })),
    interrupt: vi.fn(async () => ({ status: "cancelled" })),
    wait: vi.fn(async () => ({ status: "ok", done: [] })),
    kill: vi.fn(async () => ({ status: "killed" })),
    subscribe: vi.fn(async () => ({ status: "ok" as const })),
    unsubscribe: vi.fn(async () => ({ status: "ok" as const })),
    ...overrides,
  };
}

function rawRequest(port: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, "127.0.0.1");
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify({ id: "raw-request", ...body })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Record<string, unknown>);
    });
  });
}

async function openServer(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("IPC shutdown did not finish within its budget")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
