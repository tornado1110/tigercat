import { mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listRuntimes, resolveRuntime } from "./builtins.js";
import { SystemClock, type Clock } from "./clock.js";
import { configPath, loadConfig } from "./config.js";
import { Engine, type PendingPermission } from "./engine.js";
import { TigerError } from "./errors.js";
import { listenForTools, type IpcEndpoint } from "./ipc.js";
import { createMcpServer } from "./mcp.js";
import { ProcessRuntimeFactory, type RuntimeFactory } from "./runtime.js";
import { SqliteStore } from "./store.js";
import type { AppConfig } from "./types.js";
import { LocalLarkCli, validateLarkCliArguments, type LarkCliBinding } from "./lark-cli.js";
import { LocalLarkTransport, MockLarkTransport, validateLarkApiRequest, type LarkApiRequest, type LarkTransport } from "./lark-transport.js";
import { redactText } from "./redact.js";
import { LarkResourceSource, PersonalResourceTracker, resourceScanMarkdown } from "./personal-resources.js";
import { assertRouterSessionMayStart, codexPluginRouterSurface } from "./plugin-boundary.js";

export interface PluginOptions {
  config: AppConfig;
  workspaceRoot: string;
  /** Omit for an isolated, temporary database owned by this connection. */
  dbPath?: string;
  factory?: RuntimeFactory;
  clock?: Clock;
}

export interface PluginHost {
  server: McpServer;
  engine: Engine;
  close(): Promise<void>;
}

/**
 * The connected host session is the Router. This process would own Workers
 * and their event history; it never starts a coordinator or calls a Router model.
 *
 * Codex plugin mode cannot inspect or remove the host's native shell, edit,
 * and write tools. Startup refuses while those tools remain in the Router's
 * effective set. It does not fall back to a looser permission mode.
 */
export async function createPluginHost(options: PluginOptions): Promise<PluginHost> {
  assertRouterSessionMayStart(codexPluginRouterSurface());
  const temporaryRoot = options.dbPath ? undefined : await mkdtemp(path.join(tmpdir(), "tigercat-plugin-"));
  const dbPath = options.dbPath ? path.resolve(options.dbPath) : path.join(temporaryRoot!, "state.sqlite");
  const lockPath = `${dbPath}.plugin-lock`;
  let lock: FileHandle | undefined;
  let store: SqliteStore | undefined;
  let engine: Engine | undefined;
  let ipc: IpcEndpoint | undefined;
  let server: McpServer | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // Release every owned resource, even when a preceding teardown fails.
      try {
        await server?.close();
      } finally {
        try {
          await engine?.close();
        } finally {
          try {
            await ipc?.close();
          } finally {
            try {
              await store?.close();
            } finally {
              if (lock) {
                await lock.close();
                await rm(lockPath, { force: true });
              }
              if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
            }
          }
        }
      }
    })();
    return closing;
  };
  try {
    await mkdir(path.dirname(dbPath), { recursive: true });
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new TigerError("plugin_database_busy", "This plugin database is already claimed. Use a separate TIGERCAT_PLUGIN_DB for each host. After a crash, verify the old process has exited before removing its .plugin-lock file.");
      }
      throw error;
    }
    await lock.writeFile(`${JSON.stringify({ pid: process.pid })}\n`);
    store = SqliteStore.open(dbPath);
    engine = new Engine({
      store,
      config: options.config,
      workspaceRoot: options.workspaceRoot,
      clock: options.clock ?? new SystemClock(),
      factory: options.factory ?? new ProcessRuntimeFactory(),
      // Events remain available through read(). The host makes every decision.
      brain: { decide: async () => ({ reply: "" }) },
    });
    const ownedEngine = engine;
    ipc = await listenForTools({
      ...engine.tools,
      spawn: async (input) => {
        const cwd = input.cwd ?? input.repo;
        if (!cwd || !path.isAbsolute(cwd)) {
          throw new TigerError("invalid_args", "Plugin spawn requires an absolute cwd or repo for the user's project.");
        }
        resolveRuntime(options.config, input.runtime);
        return ownedEngine.spawn(input);
      },
      wait: (ids, mode, timeout) => {
        if (!Number.isFinite(timeout) || timeout < 0 || timeout > 30_000) {
          throw new TigerError("invalid_args", "Plugin wait timeout must be between 0 and 30000 milliseconds.");
        }
        return ownedEngine.wait(ids, mode, timeout);
      },
    });
    engine.noteSecret("TIGERCAT_WORKER_IPC_TOKEN", ipc.workerToken);
    // Downstream Workers receive the same restricted MCP bridge as ACP mode.
    const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    engine.attachIpc({
      port: ipc.port,
      token: ipc.token,
      mcpCommand: (role) => [{
        name: "tigercat",
        command: process.execPath,
        args: [cliPath, "mcp", "--port", String(ipc!.port), "--token", role === "worker" ? ipc!.workerToken : ipc!.token, "--role", role],
        env: [],
      }],
    });
    server = createMcpServer({ port: ipc.port, token: ipc.token, role: "router" });
    server.registerTool("runtimes", {
      description: "List Worker runtimes and permission policies.",
      inputSchema: z.object({}),
    }, async () => ({ content: [{ type: "text", text: JSON.stringify(listRuntimes(options.config).map((runtime) => ({
      ...runtime,
      approval: runtime.permission === "ask" ? "host-elicitation" : "automatic-policy",
    }))) }] }));
    registerLarkTools(server, store);
    const removePermissionHandler = engine.addPermissionHandler(async (request) => {
      await handlePluginPermission(ownedEngine, server!, request);
    });
    await engine.start();
    const originalClose = close;
    const closeWithHandler = async () => {
      removePermissionHandler();
      await originalClose();
    };
    return { server, engine, close: closeWithHandler };
  } catch (error) {
    await close();
    throw error;
  }
}

function pluginLark(): LarkTransport | undefined {
  if (process.env.TIGERCAT_LARK_MOCK === "1") return new MockLarkTransport();
  const accountRef = process.env.TIGERCAT_LARK_ACCOUNT_REF;
  const profileRef = process.env.TIGERCAT_LARK_PROFILE_REF;
  const credentialHome = process.env.TIGERCAT_LARK_CREDENTIAL_HOME;
  const credentialRevision = process.env.TIGERCAT_LARK_CREDENTIAL_REVISION;
  if (!accountRef || !profileRef || !credentialHome || !credentialRevision || !path.isAbsolute(credentialHome)) return undefined;
  const binding: LarkCliBinding = { accountRef, profileRef, credentialHome, credentialRevision };
  return new LocalLarkTransport(new LocalLarkCli(binding, {
    binary: process.env.TIGERCAT_LARK_BIN,
    expectedVersion: process.env.TIGERCAT_LARK_EXPECTED_VERSION,
    versionPolicy: process.env.TIGERCAT_LARK_VERSION_POLICY === "exact" ? "exact" : "same-minor",
  }));
}

function registerLarkTools(server: McpServer, store: SqliteStore): void {
  const lark = pluginLark();
  if (!lark) return;
  const personal = () => new PersonalResourceTracker({ source: new LarkResourceSource(lark), store, clock: new SystemClock() });
  server.registerTool("lark_status", {
    description: "Read the bound Lark user authorization status.",
    inputSchema: z.object({}),
  }, async () => ({ content: [{ type: "text", text: JSON.stringify(await lark.status()) }] }));
  server.registerTool("lark_discover", {
    description: "Inspect a Lark capability contract. Omit skill to list capabilities.",
    inputSchema: z.object({ skill: z.string().optional() }),
  }, async ({ skill }) => ({ content: [{ type: "text", text: JSON.stringify(await lark.discover(skill)) }] }));
  server.registerTool("lark_execute", {
    description: "Run a Lark command with the bound user. Writes require user approval.",
    inputSchema: z.object({ args: z.array(z.string()), effect: z.enum(["read", "write"]), expectedRevision: z.string().optional() }),
  }, async ({ args, effect, expectedRevision }) => {
    const invalid = validateLarkCliArguments(args);
    if (invalid) return { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "invalid_request", message: invalid, attempted: false }) }] };
    if (effect === "write") {
      const capabilities = server.server.getClientCapabilities();
      if (!capabilities?.elicitation?.form) {
        return { isError: true, content: [{ type: "text", text: "lark write requires a host approval UI; no command was run" }] };
      }
      const confirmation = await server.server.elicitInput({
        mode: "form",
        message: `Approve lark-cli write: ${redactText(args.join(" "))}`,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: { type: "string", title: "Confirm", enum: ["yes", "no"], enumNames: ["Run this write", "Cancel"] },
          },
          required: ["confirm"],
        },
      });
      if (confirmation.action !== "accept" || confirmation.content?.confirm !== "yes") {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "cancelled", attempted: false }) }] };
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(await lark.execute({ args, effect, expectedRevision })) }] };
  });
  const larkParam = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]);
  server.registerTool("lark_api", {
    description: "Call a Lark Open API path. GET is read-only; other methods require approval.",
    inputSchema: z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string(),
      params: z.record(z.string(), larkParam).optional(),
      data: z.unknown().optional(),
      expectedRevision: z.string().optional(),
    }),
  }, async (request) => {
    const invalid = validateLarkApiRequest(request as LarkApiRequest);
    if (invalid) return { content: [{ type: "text", text: JSON.stringify(invalid) }] };
    if (request.method !== "GET") {
      const capabilities = server.server.getClientCapabilities();
      if (!capabilities?.elicitation?.form) {
        return { isError: true, content: [{ type: "text", text: "lark API write requires a host approval UI; no command was run" }] };
      }
      const confirmation = await server.server.elicitInput({
        mode: "form",
        message: `Approve Lark API ${request.method} ${request.path}`,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: { type: "string", title: "Confirm", enum: ["yes", "no"], enumNames: ["Run this write", "Cancel"] },
          },
          required: ["confirm"],
        },
      });
      if (confirmation.action !== "accept" || confirmation.content?.confirm !== "yes") {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "cancelled", attempted: false }) }] };
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(await lark.api(request as LarkApiRequest)) }] };
  });
  server.registerTool("personal_resources_scan", {
    description: "Find resources in an authorized Lark source for local tracking.",
    inputSchema: z.object({ source: z.string().min(1), query: z.string().optional(), sinceDays: z.number().int().positive().max(3650).optional(), limit: z.number().int().positive().max(50).optional() }),
  }, async ({ source, query, sinceDays, limit }) => {
    const result = await personal().scan({ source, query, sinceDays, limit });
    return { content: [{ type: "text", text: JSON.stringify({ ...result, markdown: resourceScanMarkdown(result) }) }] };
  });
  server.registerTool("personal_resources_confirm", {
    description: "Start local tracking for resource ids from the latest scan.",
    inputSchema: z.object({ ids: z.array(z.string()).min(1).max(20) }),
  }, async ({ ids }) => {
    const tracked = await personal().confirm(ids);
    return { content: [{ type: "text", text: JSON.stringify({ tracked, count: tracked.length }) }] };
  });
  server.registerTool("personal_resources_refresh", {
    description: "Refresh tracked resources and report changes.",
    inputSchema: z.object({}),
  }, async () => {
    const result = await personal().refresh();
    return { content: [{ type: "text", text: JSON.stringify({ ...result, markdown: resourceScanMarkdown(result) }) }] };
  });
  server.registerTool("personal_resources_list", {
    description: "List locally tracked resources.",
    inputSchema: z.object({}),
  }, async () => {
    const tracked = await personal().list();
    return { content: [{ type: "text", text: JSON.stringify({ tracked, count: tracked.length }) }] };
  });
}

export async function servePlugin(configFile?: string): Promise<void> {
  const host = await createPluginHost({
    config: loadConfig(configPath(configFile)),
    workspaceRoot: process.cwd(),
    dbPath: process.env.TIGERCAT_PLUGIN_DB,
  });
  let ended!: () => void;
  const disconnected = new Promise<void>((resolve) => { ended = resolve; });
  const stop = () => ended();
  host.server.server.onclose = stop;
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await host.server.connect(new StdioServerTransport());
    await disconnected;
  } finally {
    process.stdin.removeListener("end", stop);
    process.stdin.removeListener("close", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await host.close();
  }
}

/**
 * Bridge ACP permission requests into the connected Codex host's MCP
 * elicitation UI. A missing or declined UI always cancels the native request;
 * this path never guesses an allow option.
 */
async function handlePluginPermission(
  engine: Engine,
  server: McpServer,
  request: PendingPermission,
): Promise<void> {
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities?.elicitation?.form) {
    try {
      engine.respondPermission({
        workerId: request.workerId,
        permissionId: request.permissionId,
        decision: { outcome: "cancelled" },
      });
    } catch {
      // The Worker may have ended while the host capability was being read.
    }
    return;
  }
  try {
    const response = await server.server.elicitInput({
      mode: "form",
      message: `Worker approval required: ${request.title || request.kind || "operation"}`,
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            title: "Decision",
            description: request.input ? JSON.stringify(request.input).slice(0, 1_000) : undefined,
            enum: request.options.map((option) => option.optionId),
            enumNames: request.options.map((option) => option.name),
          },
        },
        required: ["decision"],
      },
    });
    if (response.action !== "accept" || typeof response.content?.decision !== "string") {
      engine.respondPermission({
        workerId: request.workerId,
        permissionId: request.permissionId,
        decision: { outcome: "cancelled" },
      });
      return;
    }
    const option = request.options.find((candidate) => candidate.optionId === response.content!.decision);
    if (!option) {
      engine.respondPermission({
        workerId: request.workerId,
        permissionId: request.permissionId,
        decision: { outcome: "cancelled" },
      });
      return;
    }
    engine.respondPermission({
      workerId: request.workerId,
      permissionId: request.permissionId,
      decision: { outcome: "selected", optionId: option.optionId, optionKind: option.kind },
    });
  } catch {
    try {
      engine.respondPermission({
        workerId: request.workerId,
        permissionId: request.permissionId,
        decision: { outcome: "cancelled" },
      });
    } catch {
      // Shutdown and timeout races are already handled by Engine.
    }
  }
}
