import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { serveUpstream } from "./acp-agent.js";
import { SystemClock } from "./clock.js";
import {
  configPath,
  loadConfig,
  removeRuntime,
  saveConfig,
  upsertRuntime,
} from "./config.js";
import { Engine } from "./engine.js";
import { TigerError, isTigerError } from "./errors.js";
import { serveMcp } from "./mcp.js";
import { listenForTools } from "./ipc.js";
import { ProcessRuntimeFactory } from "./runtime.js";
import { SqliteStore } from "./store.js";
import type { PermissionPolicy, RuntimeConfig } from "./types.js";
import { VERSION } from "./version.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      config: { type: "string" },
      command: { type: "string" },
      arg: { type: "string", multiple: true },
      env: { type: "string", multiple: true },
      tag: { type: "string", multiple: true },
      description: { type: "string" },
      permission: { type: "string" },
      runtime: { type: "string" },
      cwd: { type: "string" },
      thread: { type: "string" },
      since: { type: "string" },
      mode: { type: "string" },
      timeout: { type: "string" },
      port: { type: "string" },
      token: { type: "string" },
      role: { type: "string" },
    },
  });
  const command = positionals[0] ?? "help";
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (values.help || command === "help" || argv.length === 0) {
    io.stdout(helpText());
    return 0;
  }
  try {
    if (command === "acp") {
      return await cmdAcp(typeof values.config === "string" ? values.config : undefined);
    }
    if (command === "mcp") return await serveMcp({
      port: Number(values.port),
      token: String(values.token ?? ""),
      role: values.role === "worker" ? "worker" : "router",
    }).then(() => 0);
    if (command === "runtime") return await cmdRuntime(positionals.slice(1), values, io);
    return await cmdTool(command, positionals.slice(1), values, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (values.json) io.stdout(`${JSON.stringify({ ok: false, error: message, code: isTigerError(error) ? error.code : "error" })}\n`);
    else io.stderr(`${message}\n`);
    return error instanceof TigerError && error.code === "usage" ? 2 : 1;
  }
}

async function cmdAcp(configFile: string | undefined): Promise<number> {
  const config = loadConfig(configPath(configFile));
  const db = process.env.TIGERCAT_DB ?? path.join(path.dirname(configPath(configFile)), "tigercat.sqlite");
  if (db !== ":memory:") mkdirSync(path.dirname(db), { recursive: true });
  const store = SqliteStore.open(db);
  const engine = new Engine({
    store,
    clock: new SystemClock(),
    config,
    factory: new ProcessRuntimeFactory(),
    workspaceRoot: process.cwd(),
    mcpLaunch: mcpLaunch(),
  });
  const ipc = await listenForTools(engine.tools);
  engine.attachIpc({
    port: ipc.port,
    token: ipc.token,
    mcpCommand: (role) => [
      {
        name: "tigercat",
        command: process.execPath,
        args: [
          ...mcpLaunch().argsPrefix,
          "mcp",
          "--port",
          String(ipc.port),
          "--token",
          ipc.token,
          "--role",
          role,
        ],
        env: [],
      },
    ],
  });
  await engine.start();
  if (config.coordinatorRuntime) await engine.launchCoordinator();
  await serveUpstream(engine);
  await engine.close();
  await ipc.close();
  await store.close();
  return 0;
}

async function cmdRuntime(
  args: string[],
  values: Record<string, unknown>,
  io: CliIo,
): Promise<number> {
  const sub = args[0];
  const file = configPath(typeof values.config === "string" ? values.config : undefined);
  const config = loadConfig(file);
  if (sub === "list") {
    const payload = config.runtimes.map((runtime) => ({
      name: runtime.name,
      command: runtime.command,
      args: runtime.args,
      tags: runtime.tags,
      permission: runtime.permission,
      description: runtime.description,
    }));
    io.stdout(values.json ? `${JSON.stringify(payload)}\n` : formatRuntimes(config.runtimes));
    return 0;
  }
  if (sub === "add") {
    const name = args[1];
    if (!name || typeof values.command !== "string" || !values.command) {
      throw new TigerError("usage", "usage: tigercat runtime add <name> --command <cmd> [--arg a]...");
    }
    const runtime: RuntimeConfig = {
      name,
      command: values.command,
      args: arrayOf(values.arg),
      env: envOf(arrayOf(values.env)),
      tags: arrayOf(values.tag),
      description: typeof values.description === "string" ? values.description : "",
      permission: permissionOf(values.permission),
    };
    saveConfig(upsertRuntime(config, runtime), file);
    io.stdout(values.json ? `${JSON.stringify({ ok: true, name })}\n` : `added ${name}\n`);
    return 0;
  }
  if (sub === "remove") {
    const name = args[1];
    if (!name) throw new TigerError("usage", "usage: tigercat runtime remove <name>");
    saveConfig(removeRuntime(config, name), file);
    io.stdout(values.json ? `${JSON.stringify({ ok: true, name })}\n` : `removed ${name}\n`);
    return 0;
  }
  if (sub === "test") {
    const name = args[1];
    const runtime = config.runtimes.find((entry) => entry.name === name);
    if (!runtime) throw new TigerError("unknown_runtime", `unknown runtime ${name ?? ""}`);
    const report = await testRuntime(runtime);
    io.stdout(`${JSON.stringify(report)}\n`);
    return report.ok ? 0 : 1;
  }
  throw new TigerError("usage", "usage: tigercat runtime add|list|remove|test");
}

async function testRuntime(runtime: RuntimeConfig): Promise<Record<string, unknown>> {
  const factory = new ProcessRuntimeFactory({ handshakeTimeoutMs: 8_000 });
  try {
    const handle = await factory.launch(runtime, {
      cwd: process.cwd(),
      role: "worker",
      onUpdate: () => undefined,
      onPermission: async (request) => ({
        outcome: {
          outcome: "selected",
          optionId: request.options[0]?.optionId ?? "reject",
        },
      }),
    });
    const result = await Promise.race([
      handle.prompt("ping"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new TigerError("timeout", "prompt timed out")), 8_000)),
    ]);
    await handle.kill();
    return {
      ok: result.stopReason === "end_turn" || result.stopReason === "cancelled" || result.stopReason === "refusal",
      protocolVersion: acp.PROTOCOL_VERSION,
      stopReason: result.stopReason,
      degraded: ["loadSession"],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: isTigerError(error) ? error.code : "bad_runtime",
      message,
    };
  }
}

async function cmdTool(
  command: string,
  args: string[],
  values: Record<string, unknown>,
  io: CliIo,
): Promise<number> {
  const known = ["spawn", "list", "send", "read", "interrupt", "wait", "kill", "subscribe", "unsubscribe"];
  if (!known.includes(command)) throw new TigerError("usage", `unknown command ${command}`);
  const file = configPath(typeof values.config === "string" ? values.config : undefined);
  const config = loadConfig(file);
  const db = process.env.TIGERCAT_DB ?? path.join(path.dirname(file), "tigercat.sqlite");
  if (db !== ":memory:") mkdirSync(path.dirname(db), { recursive: true });
  const store = SqliteStore.open(db);
  const engine = new Engine({
    store,
    clock: new SystemClock(),
    config,
    factory: new ProcessRuntimeFactory(),
    workspaceRoot: process.cwd(),
  });
  await engine.start();
  try {
    const result = await runTool(engine, command, args, values);
    io.stdout(values.json || command !== "list" ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } finally {
    await engine.close();
    await store.close();
  }
}

async function runTool(
  engine: Engine,
  command: string,
  args: string[],
  values: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case "spawn":
      return engine.spawn({
        runtime: String(values.runtime ?? args[0] ?? ""),
        task: args.slice(values.runtime ? 0 : 1).join(" ") || undefined,
        prompt: args.slice(values.runtime ? 0 : 1).join(" ") || undefined,
        cwd: typeof values.cwd === "string" ? values.cwd : undefined,
        thread: typeof values.thread === "string" ? values.thread : undefined,
      });
    case "list":
      return engine.list();
    case "send":
      return engine.send(args[0] ?? "", args.slice(1).join(" "));
    case "read":
      return engine.read(args[0] ?? "", values.since ? Number(values.since) : undefined);
    case "interrupt":
      return engine.interrupt(args[0] ?? "");
    case "wait":
      return engine.wait(
        args,
        values.mode === "all" ? "all" : "any",
        values.timeout ? Number(values.timeout) : 0,
      );
    case "kill":
      return engine.kill(args[0] ?? "");
    case "subscribe":
      return engine.subscribe(args[0] ?? "", args[1] ?? "");
    case "unsubscribe":
      return engine.unsubscribe(args[0] ?? "", args[1] ?? "");
    default:
      throw new TigerError("usage", `unknown command ${command}`);
  }
}

function mcpLaunch(): { command: string; argsPrefix: string[] } {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  return { command: process.execPath, argsPrefix: [cli] };
}

function arrayOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return [];
}

function envOf(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    env[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return env;
}

function permissionOf(value: unknown): PermissionPolicy {
  if (value === "auto" || value === "ask" || value === "deny") return value;
  return "ask";
}

function formatRuntimes(runtimes: RuntimeConfig[]): string {
  if (runtimes.length === 0) return "(no runtimes)\n";
  return runtimes
    .map((runtime) => `${runtime.name}\t${runtime.command} ${runtime.args.join(" ")}\t${runtime.permission}`)
    .join("\n") + "\n";
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (typeof code === "number") process.exitCode = code;
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    },
  );
}

function helpText(): string {
  return `tigercat ${VERSION}
A Super-agent router for coding agents.

Usage:
  tigercat acp [--config file]
  tigercat runtime add <name> --command <cmd> [--arg a] [--env K=V] [--tag t] [--permission ask|auto|deny]
  tigercat runtime list|remove|test
  tigercat spawn --runtime <name> --thread <id> <task>
  tigercat list|send|read|interrupt|wait|kill|subscribe|unsubscribe

Flags:
  --json     Stable JSON on stdout
  --config   Path to config.toml (default ~/.tigercat/config.toml)
  --help     Show this help
`;
}
