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
import { servePlugin } from "./plugin.js";
import { listenForTools } from "./ipc.js";
import { discoverRuntimes, listRuntimes, planRuntimeTest, type ListedRuntime, type RuntimeTestPlan } from "./builtins.js";
import { redactText } from "./redact.js";
import { ProcessRuntimeFactory } from "./runtime.js";
import { chatRouterFromConfig } from "./router-llm.js";
import { SqliteStore } from "./store.js";
import type { PermissionPolicy, RuntimeConfig } from "./types.js";
import { VERSION } from "./version.js";
import { LocalLarkCli } from "./lark-cli.js";
import { LocalLarkTransport } from "./lark-transport.js";
import { LarkResourceSource, PersonalResourceTracker, resourceScanMarkdown } from "./personal-resources.js";

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
      profile: { type: "string" },
      "credential-home": { type: "string" },
      lookback: { type: "string" },
      source: { type: "string" },
      query: { type: "string" },
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
    if (command === "plugin") {
      await servePlugin(typeof values.config === "string" ? values.config : undefined);
      return 0;
    }
    if (command === "feishu") {
      if (positionals.length > 1 && !(positionals.length === 2 && positionals[1] === "connect")) throw new TigerError("usage", "usage: tigercat feishu [connect] [--cwd repo] [--runtime name]");
      const { serveFeishu } = await import("./feishu.js");
      await serveFeishu({
        cwd: path.resolve(typeof values.cwd === "string" ? values.cwd : process.cwd()),
        configFile: typeof values.config === "string" ? values.config : undefined,
        runtime: typeof values.runtime === "string" ? values.runtime : undefined,
        report: (message) => io.stderr(`${message}\n`),
      });
      return 0;
    }
    if (command === "acp") {
      return await cmdAcp(typeof values.config === "string" ? values.config : undefined);
    }
    if (command === "mcp") return await serveMcp({
      port: Number(values.port),
      token: String(values.token ?? ""),
      role: values.role === "worker" ? "worker" : "router",
    }).then(() => 0);
    if (command === "personal") return await cmdPersonal(positionals.slice(1), values, io);
    if (command === "runtime") return await cmdRuntime(positionals.slice(1), values, io);
    return await cmdTool(command, positionals.slice(1), values, io);
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error));
    if (values.json) io.stdout(`${JSON.stringify({ ok: false, error: message, code: isTigerError(error) ? error.code : "error" })}\n`);
    else io.stderr(`${message}\n`);
    return error instanceof TigerError && error.code === "usage" ? 2 : 1;
  }
}

async function cmdPersonal(args: string[], values: Record<string, unknown>, io: CliIo): Promise<number> {
  const sub = args[0] ?? "scan";
  const profile = typeof values.profile === "string" ? values.profile : process.env.TIGERCAT_LARK_PROFILE_REF;
  if (!profile) throw new TigerError("usage", "usage: tigercat personal scan|confirm|refresh|list|close --profile <profile> [ids...]");
  const credentialHome = typeof values["credential-home"] === "string" ? values["credential-home"] : process.env.TIGERCAT_LARK_CREDENTIAL_HOME ?? process.env.HOME;
  if (!credentialHome || !path.isAbsolute(credentialHome)) throw new TigerError("usage", "--credential-home must be an absolute path");
  const db = process.env.TIGERCAT_DB ?? path.join(path.dirname(configPath(typeof values.config === "string" ? values.config : undefined)), "tigercat.sqlite");
  if (db !== ":memory:") mkdirSync(path.dirname(db), { recursive: true });
  const store = SqliteStore.open(db);
  const lookback = typeof values.lookback === "string" ? Number(values.lookback) : undefined;
  const cli = new LocalLarkCli({ accountRef: profile, profileRef: profile, credentialHome, credentialRevision: process.env.TIGERCAT_LARK_CREDENTIAL_REVISION ?? "local" });
  const tracker = new PersonalResourceTracker({ source: new LarkResourceSource(new LocalLarkTransport(cli)), store, clock: new SystemClock() });
  try {
    if (sub === "scan") {
      const result = await tracker.scan({ source: typeof values.source === "string" ? values.source : "documents", query: typeof values.query === "string" ? values.query : undefined, sinceDays: lookback });
      io.stdout(values.json ? `${JSON.stringify(result)}\n` : `${resourceScanMarkdown(result)}\n`);
      return result.errors.length ? 1 : 0;
    }
    if (sub === "confirm") {
      const tracked = await tracker.confirm(args.slice(1));
      io.stdout(`${JSON.stringify({ tracked, count: tracked.length })}\n`);
      return 0;
    }
    if (sub === "refresh") {
      const result = await tracker.refresh();
      io.stdout(values.json ? `${JSON.stringify(result)}\n` : `${resourceScanMarkdown(result)}\n`);
      return result.errors.length ? 1 : 0;
    }
    if (sub === "list") {
      const tracked = await tracker.list();
      io.stdout(`${JSON.stringify({ tracked, count: tracked.length })}\n`);
      return 0;
    }
    if (sub === "close") {
      const tracked = await tracker.close(args.slice(1));
      io.stdout(`${JSON.stringify({ tracked, count: tracked.length })}\n`);
      return 0;
    }
    throw new TigerError("usage", "usage: tigercat personal scan|confirm|refresh|list|close --profile <profile> [ids...]");
  } finally {
    await store.close();
  }
}

async function cmdAcp(configFile: string | undefined): Promise<number> {
  const config = loadConfig(configPath(configFile));
  const db = process.env.TIGERCAT_DB ?? path.join(path.dirname(configPath(configFile)), "tigercat.sqlite");
  if (db !== ":memory:") mkdirSync(path.dirname(db), { recursive: true });
  const store = SqliteStore.open(db);
  const router = config.routerProvider;
  if (router && config.coordinatorRuntime) {
    throw new TigerError(
      "router_conflict",
      "router.provider and coordinator_runtime are both set. Use the DeepSeek tool Router or an ACP coordinator, not both. No process was started.",
    );
  }
  const brain = router ? chatRouterFromConfig(router, process.env) : undefined;
  const engine = new Engine({
    store,
    clock: new SystemClock(),
    config,
    factory: new ProcessRuntimeFactory(),
    workspaceRoot: process.cwd(),
    mcpLaunch: mcpLaunch(),
    ...(brain ? { brain } : {}),
  });
  if (router) {
    const key = process.env[router.apiKeyEnv];
    if (key) engine.noteSecret(router.apiKeyEnv, key);
  }
  const ipc = await listenForTools(engine.tools);
  engine.noteSecret("TIGERCAT_WORKER_IPC_TOKEN", ipc.workerToken);
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
          role === "worker" ? ipc.workerToken : ipc.token,
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
    const payload = listRuntimes(config);
    io.stdout(values.json ? `${JSON.stringify(payload)}\n` : formatRuntimes(payload));
    return 0;
  }
  if (sub === "discover") {
    const payload = discoverRuntimes(config);
    io.stdout(values.json ? `${JSON.stringify(payload)}\n` : formatRuntimes(payload));
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
    if (!name) throw new TigerError("usage", "usage: tigercat runtime test <name>");
    const plan = planRuntimeTest(config, name);
    const report = await testRuntime(plan);
    io.stdout(`${JSON.stringify(report)}\n`);
    return report.ok ? 0 : 1;
  }
  throw new TigerError("usage", "usage: tigercat runtime add|list|discover|remove|test");
}

async function testRuntime(plan: RuntimeTestPlan): Promise<Record<string, unknown>> {
  const factory = new ProcessRuntimeFactory({ handshakeTimeoutMs: 8_000 });
  const base = {
    runtime: plan.runtime.name,
    mode: plan.mode,
    vendorFound: plan.vendorFound,
    vendorExecuted: false,
    adapter: plan.adapter,
    manual: plan.manual || undefined,
  };
  try {
    const handle = await factory.launch(plan.launch, {
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
    const vendorExecuted = plan.mode === "adapter";
    return {
      ...base,
      ok: result.stopReason === "end_turn" || result.stopReason === "cancelled" || result.stopReason === "refusal",
      protocolVersion: acp.PROTOCOL_VERSION,
      stopReason: result.stopReason,
      degraded: ["loadSession"],
      acpSessionId: handle.acpSessionId ?? null,
      vendorExecuted,
      preview: plan.mode === "dry-run" ? result.text.slice(0, 200) : undefined,
      message: vendorExecuted
        ? `${plan.adapter?.package}@${plan.adapter?.version} completed initialize, session/new, and session/prompt.`
        : plan.message,
    };
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error));
    return {
      ...base,
      ok: false,
      reason: isTigerError(error) ? error.code : "bad_runtime",
      message: plan.mode === "dry-run" ? `${message} ${plan.message}` : message,
    };
  }
}

async function cmdTool(
  command: string,
  args: string[],
  values: Record<string, unknown>,
  io: CliIo,
): Promise<number> {
  const known = ["spawn", "resume", "list", "send", "read", "interrupt", "wait", "kill", "subscribe", "unsubscribe"];
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
    case "resume":
      return engine.resume(args[0] ?? "", args.slice(1).join(" "));
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

function formatRuntimes(runtimes: ListedRuntime[]): string {
  if (runtimes.length === 0) return "(no runtimes)\n";
  return runtimes
    .map((runtime) => {
      const kind = runtime.overridden ? "override" : runtime.builtin ? "builtin" : "config";
      const mode = runtime.testMode ? `\t${runtime.testMode}` : "";
      const vendor = runtime.vendorPath ? `\tvendor=${runtime.vendorPath}` : "";
      return `${runtime.name}\t${runtime.command} ${runtime.args.join(" ")}\t${runtime.permission}\t${kind}${mode}${vendor}`;
    })
    .join("\n") + "\n";
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (typeof code === "number") process.exitCode = code;
    },
    (error) => {
      const message = redactText(error instanceof Error ? error.message : String(error));
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
  tigercat feishu [connect] [--cwd repo] [--runtime name] [--config file]
  tigercat plugin [--config file]  MCP tools for a host-driven Codex plugin
  tigercat personal scan|confirm|refresh|list|close --profile <profile> [--source documents|mail|minutes|messages] [--query text] [ids...]
  tigercat runtime add <name> --command <cmd> [--arg a] [--env K=V] [--tag t] [--permission ask|auto|deny]
    --env is written to config.toml in plaintext. Do not put API keys there.
  tigercat runtime list
  tigercat runtime discover   # probe local Claude Code and Codex binaries
  tigercat runtime remove <name>
  tigercat runtime test <name>
  tigercat spawn --runtime <name> --thread <id> <task>
  tigercat list|send|read|interrupt|wait|kill|resume|subscribe|unsubscribe

Built-in workers: claude-code, codex.
When claude or codex is absent, runtime test handshakes a local dry-run agent.
Real run: TIGERCAT_CLAUDE_BIN=/path/to/claude tigercat runtime test claude-code
          TIGERCAT_CODEX_BIN=/path/to/codex tigercat runtime test codex

Flags:
  --json     Stable JSON on stdout
  --config   Path to config.toml (default ~/.tigercat/config.toml)
  --help     Show this help
`;
}
