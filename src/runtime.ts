import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { Readable, Transform, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Clock } from "./clock.js";
import { TigerError } from "./errors.js";
import type { RuntimeConfig } from "./types.js";

export interface PromptResult {
  stopReason: string;
  text: string;
  awaitingInput: boolean;
}

export interface RuntimeUpdate {
  sessionUpdate?: string;
  text?: string;
  toolTitle?: string;
  toolKind?: string;
  paths?: string[];
}

export interface PermissionAnswer {
  outcome: "selected" | "cancelled";
  optionId?: string;
}

export interface LaunchContext {
  cwd: string;
  role: "router" | "worker";
  mcpServers?: acp.McpServer[];
  onUpdate: (update: RuntimeUpdate) => void;
  onPermission: (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
}

export interface RuntimeHandle {
  readonly pid: number | undefined;
  prompt(text: string): Promise<PromptResult>;
  cancel(): Promise<void>;
  kill(): Promise<void>;
}

export interface RuntimeFactory {
  launch(runtime: RuntimeConfig, ctx: LaunchContext): Promise<RuntimeHandle>;
}

export class FakeTimeRuntimeFactory implements RuntimeFactory {
  constructor(
    private readonly clock: Clock,
    private readonly durationMs: number,
  ) {}

  async launch(runtime: RuntimeConfig, ctx: LaunchContext): Promise<RuntimeHandle> {
    const duration = Number(runtime.env.TIGERCAT_FAKE_DURATION_MS ?? this.durationMs);
    return new FakeHandle(this.clock, Number.isFinite(duration) ? duration : this.durationMs, runtime, ctx);
  }
}

class FakeHandle implements RuntimeHandle {
  readonly pid = undefined;
  private killed = false;
  private cancelCurrent: (() => void) | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly durationMs: number,
    private readonly runtime: RuntimeConfig,
    private readonly ctx: LaunchContext,
  ) {}

  prompt(text: string): Promise<PromptResult> {
    const scenario = this.runtime.env.TIGERCAT_STUB_SCENARIO ?? "ok";
    if (scenario === "crash-mid-turn") {
      this.ctx.onUpdate({ sessionUpdate: "agent_message_chunk", text: "partial" });
      return Promise.reject(new TigerError("worker_exited", "fake runtime crashed mid-turn"));
    }
    if (scenario === "bad-handshake") {
      return Promise.reject(new TigerError("version_mismatch", "fake runtime protocol mismatch"));
    }
    this.ctx.onUpdate({ sessionUpdate: "agent_message_chunk", text: `start ${text.slice(0, 40)}` });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result: PromptResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      this.cancelCurrent = () => finish({ stopReason: "cancelled", text: "", awaitingInput: false });
      if (scenario === "hang" || scenario === "ignore-cancel") {
        this.cancelCurrent = () => {
          if (scenario === "ignore-cancel") return;
          finish({ stopReason: "cancelled", text: "", awaitingInput: false });
        };
        return;
      }
      const timer = this.clock.setTimeout(() => {
        if (this.killed) {
          reject(new TigerError("killed", "fake runtime killed"));
          return;
        }
        const huge = scenario === "huge-output";
        const asking = scenario === "ask-input";
        finish({
          stopReason: "end_turn",
          text: huge ? "x".repeat(5_000) : asking ? "Which file should I edit?" : `done ${text.slice(0, 120)}`,
          awaitingInput: asking,
        });
      }, this.durationMs);
      const previous = this.cancelCurrent;
      this.cancelCurrent = () => {
        this.clock.clearTimeout(timer);
        previous?.();
      };
    });
  }

  async cancel(): Promise<void> {
    this.cancelCurrent?.();
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.cancelCurrent?.();
  }
}

export interface ProcessRuntimeOptions {
  handshakeTimeoutMs?: number;
}

export class ProcessRuntimeFactory implements RuntimeFactory {
  constructor(private readonly options: ProcessRuntimeOptions = {}) {}

  async launch(runtime: RuntimeConfig, ctx: LaunchContext): Promise<RuntimeHandle> {
    const proc = spawn(runtime.command, runtime.args, {
      cwd: ctx.cwd,
      env: { ...process.env, ...runtime.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stderr = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_000);
    });
    if (!proc.stdin || !proc.stdout) {
      throw new TigerError("bad_runtime", `failed to pipe runtime ${runtime.name}`);
    }
    let garbage = "";
    const guardedStdout = new Transform({
      transform(chunk, _encoding, callback) {
        garbage += chunk.toString("utf8");
        let newline = garbage.indexOf("\n");
        while (newline >= 0) {
          const line = garbage.slice(0, newline).trim();
          garbage = garbage.slice(newline + 1);
          newline = garbage.indexOf("\n");
          if (line.length > 0 && !line.startsWith("{")) {
            callback(new Error(`non JSON-RPC stdout: ${line.slice(0, 120)}`));
            return;
          }
        }
        callback(null, chunk);
      },
    });
    proc.stdout.pipe(guardedStdout);
    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(guardedStdout) as ReadableStream<Uint8Array>,
    );
    const updates: RuntimeUpdate[] = [];
    const connection = acp
      .client({ name: "tigercat" })
      .onRequest(acp.methods.client.session.requestPermission, async (request) =>
        ctx.onPermission(request.params),
      )
      .onRequest(acp.methods.client.fs.readTextFile, async () => {
        if (ctx.role === "router") {
          throw acp.RequestError.invalidRequest(undefined, "router has no file tools");
        }
        return { content: "" };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async () => {
        if (ctx.role === "router") {
          throw acp.RequestError.invalidRequest(undefined, "router cannot edit files");
        }
        return {};
      })
      .onRequest(acp.methods.client.terminal.create, async () => {
        throw acp.RequestError.invalidRequest(undefined, "terminal is not available");
      })
      .onNotification(acp.methods.client.session.update, (note) => {
        const update = toUpdate(note.params.update);
        updates.push(update);
        ctx.onUpdate(update);
      })
      .connect(stream);

    const timeoutMs = this.options.handshakeTimeoutMs ?? 8_000;
    const fail = (error: unknown): never => {
      killProcess(proc);
      connection.close();
      const message = error instanceof Error ? error.message : String(error);
      throw new TigerError("bad_runtime", `${runtime.name}: ${message}${stderr ? ` (${stderr.trim()})` : ""}`);
    };

    try {
      const init = await withTimeout(
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: {
              readTextFile: ctx.role === "worker",
              writeTextFile: ctx.role === "worker",
            },
            terminal: false,
          },
          clientInfo: { name: "tigercat", version: "0.1.0" },
        }),
        timeoutMs,
        "initialize timed out",
      );
      if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new TigerError(
          "version_mismatch",
          `${runtime.name} negotiated protocol ${String(init.protocolVersion)}, expected ${acp.PROTOCOL_VERSION}`,
        );
      }
      const session = await withTimeout(
        connection.agent
          .buildSession({
            cwd: ctx.cwd,
            mcpServers: ctx.mcpServers ?? [],
          })
          .start(),
        timeoutMs,
        "session/new timed out",
      );
      return new ProcessHandle(proc, connection, session, updates);
    } catch (error) {
      return fail(error);
    }
  }
}

class ProcessHandle implements RuntimeHandle {
  private promptReject: ((error: Error) => void) | undefined;
  private exited = false;

  constructor(
    private readonly proc: ChildProcess,
    private readonly connection: acp.ClientConnection,
    private readonly session: acp.ActiveSession,
    private readonly updates: RuntimeUpdate[],
  ) {
    this.proc.on("exit", () => {
      this.exited = true;
      this.promptReject?.(new TigerError("worker_exited", "runtime process exited"));
    });
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  async prompt(text: string): Promise<PromptResult> {
    const start = this.updates.length;
    const response = await new Promise<acp.PromptResponse>((resolve, reject) => {
      this.promptReject = reject;
      this.session.prompt(text).then(resolve, reject);
    }).finally(() => {
      this.promptReject = undefined;
    });
    const textOut = this.updates
      .slice(start)
      .map((update) => update.text ?? "")
      .join("");
    const meta = response._meta ?? undefined;
    const awaiting =
      textOut.includes("[[awaiting-input]]") ||
      (typeof meta === "object" && meta !== null && (meta as { awaitingInput?: unknown }).awaitingInput === true);
    return {
      stopReason: response.stopReason,
      text: textOut,
      awaitingInput: awaiting,
    };
  }

  async cancel(): Promise<void> {
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.session.sessionId,
    });
  }

  async kill(): Promise<void> {
    killProcess(this.proc);
    this.connection.close();
    if (!this.exited) {
      this.promptReject?.(new TigerError("killed", "runtime killed"));
    }
    await waitForExit(this.proc);
  }
}

function toUpdate(update: acp.SessionUpdate): RuntimeUpdate {
  if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
    const content = update.content;
    return {
      sessionUpdate: update.sessionUpdate,
      text: content.type === "text" ? content.text : "",
    };
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const locations = "locations" in update && Array.isArray(update.locations) ? update.locations : [];
    return {
      sessionUpdate: update.sessionUpdate,
      toolTitle: "title" in update && typeof update.title === "string" ? update.title : undefined,
      toolKind: "kind" in update && typeof update.kind === "string" ? update.kind : undefined,
      paths: locations
        .map((location) => ("path" in location ? location.path : undefined))
        .filter((value): value is string => typeof value === "string"),
    };
  }
  return { sessionUpdate: update.sessionUpdate };
}

function killProcess(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      killWindowsTree(pid);
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
    stream?.destroy();
  }
}

function killWindowsTree(pid: number): void {
  // taskkill /T can terminate the parent before its children and orphan them.
  // Those orphans keep the worker directory locked. Kill descendants first.
  const command = [
    "function Kill-Tree([int]$id) {",
    "  Get-CimInstance Win32_Process -Filter \"ParentProcessId=$id\" | ForEach-Object { Kill-Tree $_.ProcessId }",
    "  & taskkill.exe /PID $id /F | Out-Null",
    "}",
    `Kill-Tree ${pid}`,
  ].join(" ");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 20_000,
  });
}

function waitForExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TigerError("timeout", message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
