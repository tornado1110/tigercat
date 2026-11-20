import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Clock } from "./clock.js";
import { TigerError } from "./errors.js";
import { redactText } from "./redact.js";
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
  /** Process exited on its own. `kill()` does not call this. */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export interface RuntimeHandle {
  readonly pid: number | undefined;
  readonly acpSessionId: string | undefined;
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
  readonly acpSessionId = undefined;
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

/**
 * Names that belong to TigerCat's host/channel plumbing. They are not needed
 * by an ACP Worker and should not cross the process boundary when they happen
 * to be exported by the host shell. Runtime-specific env remains an explicit
 * escape hatch and is merged after this filter.
 */
const PRIVATE_INHERITED_ENV = new Set([
  "TIGERCAT_CONFIG",
  "TIGERCAT_DB",
  "TIGERCAT_PLUGIN_DB",
  "TIGERCAT_IPC_TOKEN",
  "TIGERCAT_WORKER_IPC_TOKEN",
  "TIGERCAT_LARK_ACCOUNT_REF",
  "TIGERCAT_LARK_PROFILE_REF",
  "TIGERCAT_LARK_CREDENTIAL_HOME",
  "TIGERCAT_LARK_CREDENTIAL_REVISION",
  "TIGERCAT_LARK_BIN",
  "TIGERCAT_LARK_EXPECTED_VERSION",
  "TIGERCAT_LARK_VERSION_POLICY",
  "CC_SESSION_KEY",
  "CC_PROJECT",
]);

const CLAUDE_CREDENTIAL_ENV = new Set([
  // These are the documented vendor credentials/overrides consumed by the
  // Claude adapter. Other secret-shaped variables must be configured on a
  // specific runtime instead of inherited by every Worker.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_EXECUTABLE",
]);

const CODEX_CREDENTIAL_ENV = new Set([
  // These are the documented vendor credentials/override consumed by the
  // Codex adapter.
  "CODEX_API_KEY",
  "CODEX_PATH",
  "OPENAI_API_KEY",
]);

function secretShapedEnv(name: string): boolean {
  return /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL|TOKEN)/i.test(name);
}

/** Build the environment visible to a downstream ACP process. Only the
 * credential variables belonging to the named built-in adapter are inherited;
 * custom runtimes must provide their own credentials explicitly. */
export function buildWorkerEnvironment(
  runtimeEnv: Record<string, string>,
  parentEnv: NodeJS.ProcessEnv = process.env,
  runtimeName?: string,
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  const allowedCredentials = runtimeName === "claude-code"
    ? CLAUDE_CREDENTIAL_ENV
    : runtimeName === "codex"
      ? CODEX_CREDENTIAL_ENV
      : new Set<string>();
  for (const [name, value] of Object.entries(parentEnv)) {
    // Windows environment names are case-insensitive even when Node exposes
    // the spelling used by the parent process.
    const canonical = name.toUpperCase();
    if (PRIVATE_INHERITED_ENV.has(canonical)) continue;
    if (secretShapedEnv(canonical) && !allowedCredentials.has(canonical)) continue;
    inherited[name] = value;
  }
  return { ...inherited, ...runtimeEnv };
}

export class ProcessRuntimeFactory implements RuntimeFactory {
  constructor(private readonly options: ProcessRuntimeOptions = {}) {}

  async launch(runtime: RuntimeConfig, ctx: LaunchContext): Promise<RuntimeHandle> {
    const proc = spawn(runtime.command, runtime.args, {
      cwd: ctx.cwd,
      env: buildWorkerEnvironment(runtime.env, process.env, runtime.name),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: runtime.windowsVerbatimArguments === true,
    });
    // `spawn()` reports ENOENT/EACCES asynchronously. Keep a listener from
    // the first tick so a bad local binary becomes a typed launch failure
    // instead of an uncaught `error` event that kills the host process.
    let rejectLaunchError!: (error: Error) => void;
    const launchError = new Promise<never>((_, reject) => {
      rejectLaunchError = reject;
    });
    const onLaunchError = (error: Error): void => {
      rejectLaunchError(new TigerError("bad_runtime", `${runtime.name}: process could not start: ${redactText(error.message)}`));
    };
    proc.once("error", onLaunchError);
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
            callback(new Error(`non JSON-RPC stdout: ${redactText(line.slice(0, 120))}`));
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

    try {
      const init = await withTimeout(
        Promise.race([
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
          launchError,
        ]),
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
        Promise.race([
          connection.agent
            .buildSession({
              cwd: ctx.cwd,
              mcpServers: ctx.mcpServers ?? [],
            })
            .start(),
          launchError,
        ]),
        timeoutMs,
        "session/new timed out",
      );
      proc.off("error", onLaunchError);
      return new ProcessHandle(proc, connection, session, updates, ctx.onExit);
    } catch (error) {
      let killMessage = "";
      try {
        await terminateProcess(proc);
      } catch (killError) {
        killMessage = killError instanceof Error ? ` (kill: ${killError.message})` : "";
      }
      proc.off("error", onLaunchError);
      connection.close();
      const message = error instanceof Error ? error.message : String(error);
      const detail = stderr ? ` (${redactText(stderr.trim())})` : "";
      throw new TigerError(
        "bad_runtime",
        `${runtime.name}: ${redactText(message)}${redactText(killMessage)}${detail}`,
      );
    }
  }
}

class ProcessHandle implements RuntimeHandle {
  private promptReject: ((error: Error) => void) | undefined;
  private exited = false;
  private suppressExit = false;
  private exitReported = false;

  constructor(
    private readonly proc: ChildProcess,
    private readonly connection: acp.ClientConnection,
    private readonly session: acp.ActiveSession,
    private readonly updates: RuntimeUpdate[],
    private readonly onExit: LaunchContext["onExit"],
  ) {
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      this.promptReject?.(new TigerError("worker_exited", "runtime process exited"));
      this.reportExit({ code, signal });
    });
    this.proc.on("error", (error) => {
      this.exited = true;
      this.promptReject?.(new TigerError("worker_exited", `runtime process error: ${redactText(error.message)}`));
      try { this.connection.close(); } catch { /* already closing */ }
      this.reportExit({ code: null, signal: null });
    });
  }

  private reportExit(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.suppressExit || this.exitReported) return;
    this.exitReported = true;
    this.onExit?.(info);
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  get acpSessionId(): string {
    return this.session.sessionId;
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
    this.suppressExit = true;
    let failure: unknown;
    try {
      await terminateProcess(this.proc);
    } catch (error) {
      failure = error;
    } finally {
      this.connection.close();
    }
    if (!this.exited) {
      this.promptReject?.(new TigerError("killed", "runtime killed"));
    }
    await waitForExit(this.proc);
    if (failure) {
      throw failure instanceof Error ? failure : new TigerError("killed", String(failure));
    }
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

async function terminateProcess(proc: ChildProcess): Promise<void> {
  const pid = proc.pid;
  try {
    if (process.platform === "win32") {
      if (pid) await reapWindowsTree(pid);
    } else if (pid) {
      killPosix(pid, proc);
    }
  } finally {
    for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
      stream?.destroy();
    }
  }
}

function killPosix(pid: number, proc: ChildProcess): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

const WINDOWS_REAP_TIMEOUT_MS = 20_000;
const WINDOWS_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Collect descendants while the parent is still alive, then taskkill /T /F.
 * A single WMI snapshot can miss a child; killing the parent first reparents
 * that child and the PID is lost. Issue #28.
 */
const WINDOWS_REAP_SCRIPT = `
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$root = [int]$env:TIGERCAT_KILL_ROOT
if ($root -le 0) { exit 2 }
$deadline = (Get-Date).AddSeconds(12)
$seen = New-Object 'System.Collections.Generic.HashSet[int]'
$stable = 0
function Get-Kids([int[]]$roots) {
  $procs = @(Get-CimInstance Win32_Process)
  $byParent = @{}
  foreach ($p in $procs) {
    $id = 0
    $parent = 0
    try { $id = [int]$p.ProcessId; $parent = [int]$p.ParentProcessId } catch { continue }
    if ($id -le 0) { continue }
    if (-not $byParent.ContainsKey($parent)) {
      $byParent[$parent] = New-Object 'System.Collections.Generic.List[int]'
    }
    [void]$byParent[$parent].Add($id)
  }
  $found = New-Object 'System.Collections.Generic.List[int]'
  $stack = New-Object 'System.Collections.Generic.Stack[int]'
  $visited = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($item in $roots) { if ($item -gt 0) { $stack.Push([int]$item) } }
  while ($stack.Count -gt 0) {
    $id = [int]$stack.Pop()
    if (-not $byParent.ContainsKey($id)) { continue }
    foreach ($child in @($byParent[$id])) {
      if ($child -le 0 -or $child -eq $root) { continue }
      if ($visited.Add([int]$child)) {
        [void]$found.Add([int]$child)
        $stack.Push([int]$child)
      }
    }
  }
  return ,$found
}
function Stop-Tree([int]$id) {
  if ($id -le 0) { return }
  $taskkill = Join-Path $env:SystemRoot "System32\\taskkill.exe"
  & $taskkill /PID $id /T /F 1>$null 2>$null | Out-Null
}
function Test-Live([int]$id) {
  if ($id -le 0) { return $false }
  return $null -ne (Get-Process -Id $id -ErrorAction SilentlyContinue)
}
while ((Get-Date) -lt $deadline) {
  $roots = New-Object 'System.Collections.Generic.List[int]'
  [void]$roots.Add($root)
  foreach ($id in @($seen)) { [void]$roots.Add([int]$id) }
  $found = @(Get-Kids $roots.ToArray())
  $added = $false
  foreach ($id in $found) {
    if ($id -gt 0 -and $id -ne $root -and $seen.Add([int]$id)) { $added = $true }
  }
  foreach ($id in @($seen)) { Stop-Tree ([int]$id) }
  $anyLive = $false
  foreach ($id in @($seen)) { if (Test-Live ([int]$id)) { $anyLive = $true } }
  if ($added -or $anyLive) { $stable = 0 } else { $stable++ }
  $need = 2
  if ($seen.Count -eq 0) { $need = 4 }
  if ($stable -ge $need) {
    Stop-Tree $root
    break
  }
  Start-Sleep -Milliseconds 200
}
Stop-Tree $root
$ids = New-Object 'System.Collections.Generic.List[int]'
[void]$ids.Add($root)
foreach ($id in @($seen)) { [void]$ids.Add([int]$id) }
$confirm = (Get-Date).AddSeconds(4)
do {
  $live = New-Object 'System.Collections.Generic.List[int]'
  foreach ($id in @($ids)) {
    if (Test-Live ([int]$id)) { Stop-Tree ([int]$id); [void]$live.Add([int]$id) }
  }
  if ($live.Count -eq 0) { break }
  Start-Sleep -Milliseconds 100
} while ((Get-Date) -lt $confirm)
Write-Output ($ids -join ',')
exit 0
`;

function windowsSystemRoot(): string {
  return process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
}

function windowsKillEnv(root: number): NodeJS.ProcessEnv {
  const rootDir = windowsSystemRoot();
  const system32 = path.join(rootDir, "System32");
  const pathValue = [
    system32,
    path.join(system32, "WindowsPowerShell", "v1.0"),
    process.env.PATH,
    process.env.Path,
  ].filter((entry): entry is string => Boolean(entry)).join(";");
  return {
    ...process.env,
    SystemRoot: rootDir,
    PATH: pathValue,
    Path: pathValue,
    TIGERCAT_KILL_ROOT: String(root),
  };
}

async function reapWindowsTree(root: number): Promise<void> {
  let stdout = "";
  const powershell = path.join(windowsSystemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    stdout = execFileSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_REAP_SCRIPT, "utf16le").toString("base64")],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: WINDOWS_REAP_TIMEOUT_MS,
        env: windowsKillEnv(root),
      },
    );
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "") : "";
    const message = error instanceof Error ? error.message : String(error);
    const detail = stderr ? ` (${redactText(stderr.trim())})` : "";
    throw new TigerError("killed", `windows process tree kill failed for ${root}: ${redactText(message)}${detail}`);
  }
  const pids = new Set<number>([root]);
  for (const match of stdout.matchAll(/\d+/g)) {
    const pid = Number(match[0]);
    if (pid > 0) pids.add(pid);
  }
  const deadline = Date.now() + WINDOWS_CONFIRM_TIMEOUT_MS;
  let survivors = [...pids];
  while (Date.now() < deadline) {
    survivors = [...pids].filter((pid) => pidAlive(pid));
    if (survivors.length === 0) return;
    for (const pid of survivors) taskKillTree(pid);
    await delay(100);
  }
  throw new TigerError("killed", `windows process tree still alive: ${survivors.join(",")}`);
}

function taskKillTree(pid: number): void {
  const taskkill = path.join(windowsSystemRoot(), "System32", "taskkill.exe");
  try {
    execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
      env: windowsKillEnv(pid),
    });
  } catch {
    // already gone, or still exiting; the poll decides
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
