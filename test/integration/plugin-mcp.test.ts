import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { defaultConfig, saveConfig } from "../../src/config.js";
import { createPluginHost, type PluginHost } from "../../src/plugin.js";
import { FakeTimeRuntimeFactory } from "../../src/runtime.js";
import { ProcessRuntimeFactory, type RuntimeFactory } from "../../src/runtime.js";

const roots: string[] = [];
const hosts: PluginHost[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "tigercat-plugin-test-"));
  roots.push(root);
  return root;
}

async function connect(permission: "ask" | "deny" = "deny", dbPath?: string, factory?: RuntimeFactory, capabilities?: Record<string, unknown>, larkMock = false) {
  const root = await temporaryRoot();
  const clock = new FakeClock();
  const config = defaultConfig();
  // A plugin host must ignore standalone coordinator/provider configuration.
  config.coordinatorRuntime = "must-not-start";
  config.routerProvider = { provider: "deepseek", model: "unused", baseUrl: "https://invalid.example", apiKeyEnv: "UNSET_PLUGIN_ROUTER_KEY" };
  config.runtimes = [{ name: "test-worker", command: "fake", args: [], env: {}, permission, tags: [], description: "test" }];
  const priorMock = process.env.TIGERCAT_LARK_MOCK;
  const priorBinary = process.env.TIGERCAT_LARK_BIN;
  if (larkMock) {
    process.env.TIGERCAT_LARK_MOCK = "1";
    // A mock host must not accidentally fall through to a real local binary.
    process.env.TIGERCAT_LARK_BIN = "/path/that-must-not-be-spawned/lark-cli";
  }
  let host: PluginHost;
  try {
    host = await createPluginHost({ config, workspaceRoot: root, dbPath, clock, factory: factory ?? new FakeTimeRuntimeFactory(clock, 100) });
  } finally {
    if (priorMock === undefined) delete process.env.TIGERCAT_LARK_MOCK;
    else process.env.TIGERCAT_LARK_MOCK = priorMock;
    if (priorBinary === undefined) delete process.env.TIGERCAT_LARK_BIN;
    else process.env.TIGERCAT_LARK_BIN = priorBinary;
  }
  hosts.push(host);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "codex-test-host", version: "1" }, { capabilities });
  clients.push(client);
  await host.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { host, client, root, clock };
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content[0]!.text!) as Record<string, unknown>;
}

describe("host-driven Codex plugin", () => {
  it("replays mock Lark status, discovery, reads and structured GETs without spawning a binary", async () => {
    const { client } = await connect("deny", undefined, undefined, undefined, true);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["lark_status", "lark_discover", "lark_execute", "lark_api"]));
    expect(payload(await client.callTool({ name: "lark_status", arguments: {} }))).toMatchObject({ ok: true, status: "ready", profileRef: "mock-profile" });
    expect(payload(await client.callTool({ name: "lark_discover", arguments: { skill: "lark-im" } }))).toMatchObject({ ok: true, value: { name: "lark-im" }, attempted: false });
    expect(payload(await client.callTool({ name: "lark_execute", arguments: { args: ["docs", "list"], effect: "read" } }))).toMatchObject({ ok: true, value: { mocked: true, effect: "read" } });
    expect(payload(await client.callTool({ name: "lark_api", arguments: { method: "GET", path: "/open-apis/docs/v1/documents", params: { page_size: 1 } } }))).toMatchObject({ ok: true, value: { mocked: true, effect: "read" } });
    const deniedWrite = await client.callTool({ name: "lark_execute", arguments: { args: ["im", "messages", "create"], effect: "write" } });
    expect(deniedWrite.isError).toBe(true);
  });

  it("requires host elicitation before a mock Lark write", async () => {
    const { client } = await connect("deny", undefined, undefined, { elicitation: { form: {} } }, true);
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      expect(request.params.message).toMatch(/lark-cli write|Lark API/);
      return { action: "accept", content: { confirm: "yes" } };
    });
    const write = await client.callTool({ name: "lark_execute", arguments: { args: ["im", "messages", "create"], effect: "write" } });
    expect(payload(write)).toMatchObject({ ok: true, value: { mocked: true, effect: "write" }, attempted: false });
    const apiWrite = await client.callTool({ name: "lark_api", arguments: { method: "POST", path: "/open-apis/im/v1/messages", data: { content: "mock" } } });
    expect(payload(apiWrite)).toMatchObject({ ok: true, value: { mocked: true, effect: "write" }, attempted: false });
  });

  it("uses the current host as Router and controls multiple turns over the shared Engine", async () => {
    const { host, client, root, clock } = await connect();
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools.sort()).toEqual(["spawn", "resume", "list", "send", "read", "interrupt", "wait", "kill", "subscribe", "unsubscribe", "runtimes"].sort());
    const catalog = await client.callTool({ name: "runtimes", arguments: {} });
    expect(catalog.isError).not.toBe(true);
    const started = payload(await client.callTool({ name: "spawn", arguments: { runtime: "test-worker", cwd: root, prompt: "first task" } }));
    expect(started.status).toBe("started");
    await host.engine.settle();
    clock.advance(100);
    await host.engine.settle();
    const id = String(started.workerId);
    let view = payload(await client.callTool({ name: "read", arguments: { id } }));
    expect(view.state).toBe("idle");
    await client.callTool({ name: "send", arguments: { id, input: "second turn" } });
    await host.engine.settle();
    clock.advance(100);
    await host.engine.settle();
    view = payload(await client.callTool({ name: "read", arguments: { id } }));
    expect(view.state).toBe("idle");
    expect((await host.engine.events()).filter((event) => event.type === "worker.turn_end")).toHaveLength(2);
    expect((await host.engine.workers()).map((worker) => worker.runtime)).toEqual(["test-worker"]);
    const killed = payload(await client.callTool({ name: "kill", arguments: { id } }));
    expect(killed.status).toBe("killed");
    await expect.poll(async () => payload(await client.callTool({ name: "read", arguments: { id } })).state, { timeout: 5_000 }).toBe("killed");
  });

  it("refuses plugin-cache paths by requiring an explicit absolute project cwd", async () => {
    const { host, client } = await connect();
    for (const cwd of [undefined, ".", "../project"]) {
      const result = await client.callTool({ name: "spawn", arguments: { runtime: "test-worker", prompt: "task", ...(cwd ? { cwd } : {}) } });
      expect(result.isError).toBe(true);
    }
    expect(await host.engine.workers()).toHaveLength(0);
  });

  it("keeps ask policy explicit when no Worker approval channel is available", async () => {
    const { host, client, root } = await connect("ask");
    const result = await client.callTool({ name: "spawn", arguments: { runtime: "test-worker", cwd: root, prompt: "task" } });
    expect(result.isError).not.toBe(true);
    expect(payload(await client.callTool({ name: "runtimes", arguments: {} }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "test-worker", permission: "ask", approval: "host-elicitation" }),
    ]));
    expect(await host.engine.workers()).toHaveLength(1);
  });

  it("bridges an ask permission request to the host elicitation UI", async () => {
    const { host, client, root } = await connect("ask", undefined, new ProcessRuntimeFactory(), { elicitation: { form: {} } });
    host.engine.config.runtimes = [{
      name: "test-worker",
      command: process.execPath,
      args: [path.resolve("test/stub-agent.ts")],
      env: { TIGERCAT_STUB_SCENARIO: "ask-permission" },
      permission: "ask",
      tags: [],
      description: "permission bridge",
    }];
    let elicited = false;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicited = true;
      if (request.params.mode !== "form") {
        throw new Error(`unexpected elicitation mode: ${request.params.mode}`);
      }
      const property = request.params.requestedSchema.properties.decision;
      const decision = "enum" in property && property.enum[0];
      return { action: "accept", content: { decision: String(decision) } };
    });
    const started = payload(await client.callTool({ name: "spawn", arguments: { runtime: "test-worker", cwd: root, prompt: "approval task" } }));
    await client.callTool({ name: "wait", arguments: { ids: [String(started.workerId)], mode: "all", timeout: 5_000 } });
    expect(elicited).toBe(true);
    const view = payload(await client.callTool({ name: "read", arguments: { id: String(started.workerId) } }));
    expect(view.state).toBe("idle");
    expect((view.events as Array<{ type: string }>).some((event) => event.type === "worker.turn_end")).toBe(true);
  });

  it("bounds waits and isolates independent host connections", async () => {
    const first = await connect();
    const second = await connect();
    await first.client.callTool({ name: "spawn", arguments: { runtime: "test-worker", cwd: first.root, prompt: "private task" } });
    expect(payload(await second.client.callTool({ name: "list", arguments: {} }))).toEqual([]);
    const result = await first.client.callTool({ name: "wait", arguments: { ids: [], mode: "all", timeout: 30_001 } });
    expect(result.isError).toBe(true);
  });

  it("protects persisted state from concurrent hosts and releases its claim on close", async () => {
    const dbRoot = await temporaryRoot();
    const dbPath = path.join(dbRoot, "plugin.sqlite");
    const first = await connect("deny", dbPath);
    const started = payload(await first.client.callTool({ name: "spawn", arguments: { runtime: "test-worker", cwd: first.root, prompt: "keep history" } }));
    await first.host.engine.settle();
    await expect(createPluginHost({ config: defaultConfig(), workspaceRoot: first.root, dbPath })).rejects.toMatchObject({ code: "plugin_database_busy" });
    await first.client.close();
    await first.host.close();
    const second = await connect("deny", dbPath);
    expect(payload(await second.client.callTool({ name: "read", arguments: { id: started.workerId } })).state).toBe("interrupted");
  });

  it("starts the CLI over real stdio without Router credentials", async () => {
    const root = await temporaryRoot();
    const configFile = path.join(root, "config.toml");
    await writeFile(configFile, "coordinator_runtime = 'must-not-start'\n[router]\nprovider = 'deepseek'\napi_key_env = 'UNSET_PLUGIN_ROUTER_KEY'\n");
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist/cli.js"), "plugin", "--config", configFile], stderr: "pipe" });
    const client = new Client({ name: "real-stdio-test", version: "1" });
    clients.push(client);
    await client.connect(transport);
    expect((await client.listTools()).tools.some((tool) => tool.name === "runtimes")).toBe(true);
    await client.close();
  });

  it("dispatches and continues a real stdio ACP Worker from a Codex-style MCP client", async () => {
    const root = await temporaryRoot();
    const configFile = path.join(root, "config.toml");
    const config = defaultConfig();
    config.runtimes = [{
      name: "stdio-worker", command: process.execPath,
      args: [path.resolve("test/stub-agent.ts")],
      env: { TIGERCAT_STUB_SCENARIO: "ok" },
      permission: "deny", tags: [], description: "real stdio regression",
    }];
    saveConfig(config, configFile);
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist/cli.js"), "plugin", "--config", configFile], stderr: "pipe" });
    const client = new Client({ name: "codex-style-host", version: "1" });
    clients.push(client);
    await client.connect(transport);
    const started = payload(await client.callTool({ name: "spawn", arguments: { runtime: "stdio-worker", cwd: root, prompt: "first task" } }));
    expect(started.status).toBe("started");
    const id = String(started.workerId);
    await client.callTool({ name: "wait", arguments: { ids: [id], mode: "all", timeout: 5_000 } });
    const first = payload(await client.callTool({ name: "read", arguments: { id } }));
    expect(first.state).toBe("idle");
    const firstEnd = (first.events as Array<{ id: string; type: string }>).find((event) => event.type === "worker.turn_end")!;
    expect(firstEnd).toBeDefined();
    const complete = payload(await client.callTool({ name: "read", arguments: { id: firstEnd.id } }));
    expect((complete.payload as Record<string, unknown>).text).toContain("first task");
    await client.callTool({ name: "send", arguments: { id, input: "second task" } });
    await client.callTool({ name: "wait", arguments: { ids: [id], mode: "all", timeout: 5_000 } });
    const second = payload(await client.callTool({ name: "read", arguments: { id } }));
    expect((second.events as Array<{ type: string }>).filter((event) => event.type === "worker.turn_end")).toHaveLength(2);
    await client.callTool({ name: "kill", arguments: { id } });
    expect(payload(await client.callTool({ name: "read", arguments: { id } })).state).toBe("killed");
  }, 60_000);

  it("closes on stdin EOF and removes the persisted database claim", async () => {
    const root = await temporaryRoot();
    const dbPath = path.join(root, "state.sqlite");
    const configFile = path.join(root, "config.toml");
    await writeFile(configFile, "");
    const child = spawn(process.execPath, [path.resolve("dist/cli.js"), "plugin", "--config", configFile], { env: { ...process.env, TIGERCAT_PLUGIN_DB: dbPath }, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    try {
      await expect.poll(async () => {
        try { return JSON.parse(await readFile(`${dbPath}.plugin-lock`, "utf8")).pid; } catch { return undefined; }
      }).toBe(child.pid);
      child.stdin.end();
      expect(await exited).toBe(0);
      await expect(readFile(`${dbPath}.plugin-lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      child.kill();
    }
  });
});
