import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemClock } from "../../src/clock.js";
import { defaultConfig } from "../../src/config.js";
import { Engine } from "../../src/engine.js";
import { ProcessRuntimeFactory } from "../../src/runtime.js";
import { SqliteStore } from "../../src/store.js";
import { startStdioEngine, stubRuntime, waitForEvent } from "../harness/stdio-engine.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTree(root);
});

async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

async function waitForRecordedPid(
  engine: {
    store: {
      getSession(id: string): Promise<{ pid: number | null; state: string } | undefined>;
    };
  },
  workerId: string,
  iteration: number,
): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    const session = await engine.store.getSession(workerId);
    if (session?.pid && session.pid > 0) return session.pid;
    if (session && (session.state === "error" || session.state === "killed")) {
      throw new Error(`iteration ${iteration} worker ${workerId} is ${session.state} before its pid was recorded`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`iteration ${iteration} worker ${workerId} pid was not recorded after launch`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Regression guard for #28. Windows pays for repeated WMI snapshots inside kill(). */
const LEAK_REPEATS = process.platform === "win32" ? 20 : 1;

function descendantPids(root: number): number[] {
  if (process.platform === "win32") return windowsDescendants(root);
  const found: number[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined) break;
    let out = "";
    try {
      out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    } catch {
      out = "";
    }
    for (const part of out.split(/\s+/)) {
      const child = Number(part);
      if (child > 0 && !seen.has(child)) {
        seen.add(child);
        found.push(child);
        stack.push(child);
      }
    }
  }
  return found;
}

function windowsDescendants(root: number): number[] {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `
$ProgressPreference = 'SilentlyContinue'
$root = ${root}
$procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$byParent = @{}
foreach ($p in $procs) {
  $id = [int]$p.ProcessId
  $parent = [int]$p.ParentProcessId
  if (-not $byParent.ContainsKey($parent)) { $byParent[$parent] = New-Object System.Collections.Generic.List[int] }
  [void]$byParent[$parent].Add($id)
}
$stack = New-Object System.Collections.Generic.Stack[int]
$stack.Push($root)
$seen = New-Object System.Collections.Generic.HashSet[int]
$out = New-Object System.Collections.Generic.List[int]
while ($stack.Count -gt 0) {
  $id = [int]$stack.Pop()
  if (-not $byParent.ContainsKey($id)) { continue }
  foreach ($child in @($byParent[$id])) {
    if ($seen.Add([int]$child)) { [void]$out.Add([int]$child); $stack.Push([int]$child) }
  }
}
Write-Output ($out -join ',')
`;
  try {
    const stdout = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      input: script,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    return stdout.split(/[^0-9]+/).map(Number).filter((pid) => pid > 0 && pid !== root);
  } catch {
    return [];
  }
}

describe("real stdio stub-agent", () => {
  it("ok: handshake, agent_message_chunk, and end_turn", async () => {
    const harness = await startStdioEngine("ok");
    roots.push(harness.root);
    const reportedPull = "https://github.com/example/project/pull/42";
    const spawned = await harness.engine.spawn({
      runtime: "ok",
      prompt: `Completed in ${reportedPull}?example=1`,
      threads: ["feishu:eng:cli"],
    });
    expect(spawned.status).toBe("started");
    const update = await waitForEvent(
      harness.engine,
      (event) => event.type === "worker.update" && String(event.payload.text ?? "").includes("stub ok"),
    );
    expect(update.workerId).toBe(spawned.workerId);
    const end = await waitForEvent(harness.engine, (event) => event.type === "worker.turn_end");
    expect(end.payload.stopReason).toBe("end_turn");
    expect(await harness.engine.read(spawned.workerId)).toMatchObject({ links: [reportedPull] });
    expect(await harness.engine.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(1);
    await harness.engine.close();
    await harness.store.close();
  });

  it("hang: session/cancel ends the turn and keeps the subscription", async () => {
    const harness = await startStdioEngine("hang");
    roots.push(harness.root);
    const spawned = await harness.engine.spawn({
      runtime: "hang",
      prompt: "wait",
      threads: ["feishu:eng:cli"],
    });
    await waitForEvent(
      harness.engine,
      (event) => event.type === "worker.update" && String(event.payload.text ?? "").includes("hanging"),
    );
    await harness.engine.interrupt(spawned.workerId);
    const end = await waitForEvent(
      harness.engine,
      (event) => event.type === "worker.turn_end" && event.payload.stopReason === "cancelled",
    );
    expect(end.workerId).toBe(spawned.workerId);
    const session = await harness.engine.store.getSession(spawned.workerId);
    expect(session?.state).not.toBe("killed");
    expect(await harness.engine.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(1);
    await harness.engine.close();
    await harness.store.close();
  });

  it("ask-permission: a permission request is answered and the turn ends", async () => {
    const harness = await startStdioEngine("ask-permission");
    roots.push(harness.root);
    const spawned = await harness.engine.spawn({
      runtime: "ask-permission",
      prompt: "edit",
      threads: ["feishu:eng:cli"],
    });
    await waitForEvent(harness.engine, (event) => event.type === "worker.permission_request");
    const started = Date.now();
    let ended = false;
    while (Date.now() - started < 8_000) {
      harness.engine.resolvePermission(spawned.workerId, "allow");
      const events = await harness.engine.events();
      if (events.some((event) => event.type === "worker.turn_end")) {
        ended = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(ended).toBe(true);
    await harness.engine.close();
    await harness.store.close();
  });

  it("garbage-stdout: non JSON-RPC output becomes worker.error", async () => {
    const harness = await startStdioEngine("garbage-stdout");
    roots.push(harness.root);
    const spawned = await harness.engine.spawn({
      runtime: "garbage-stdout",
      prompt: "junk",
      threads: ["feishu:eng:cli"],
    });
    const error = await waitForEvent(harness.engine, (event) => event.type === "worker.error");
    expect(error.workerId).toBe(spawned.workerId);
    expect(await harness.engine.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(0);
    await harness.engine.close();
    await harness.store.close();
  });

  it("crash-mid-turn: process exit releases subscriptions", async () => {
    const harness = await startStdioEngine("crash-mid-turn");
    roots.push(harness.root);
    const spawned = await harness.engine.spawn({
      runtime: "crash-mid-turn",
      prompt: "crash",
      threads: ["feishu:eng:cli"],
    });
    const error = await waitForEvent(harness.engine, (event) => event.type === "worker.error");
    expect(error.workerId).toBe(spawned.workerId);
    expect(await harness.engine.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(0);
    const session = await harness.engine.store.getSession(spawned.workerId);
    expect(session?.state).toBe("error");
    await harness.engine.close();
    await harness.store.close();
  });

  it("ignore-cancel: a stuck turn is killed and subscriptions are released", async () => {
    const harness = await startStdioEngine("ignore-cancel", {}, 400);
    roots.push(harness.root);
    const spawned = await harness.engine.spawn({
      runtime: "ignore-cancel",
      prompt: "stuck",
      threads: ["feishu:eng:cli"],
    });
    await waitForEvent(harness.engine, (event) => event.workerId === spawned.workerId && event.type === "worker.update" && event.payload.text === "ignoring cancellation");
    await harness.engine.interrupt(spawned.workerId);
    const started = Date.now();
    let released = false;
    while (Date.now() - started < 5_000) {
      const session = await harness.engine.store.getSession(spawned.workerId);
      const subs = await harness.engine.store.subscriptionsForWorker(spawned.workerId);
      if (session?.state === "killed" && subs.length === 0) {
        released = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(released).toBe(true);
    const session = await harness.engine.store.getSession(spawned.workerId);
    expect(session?.pid).toBeTruthy();
    expect(alive(session?.pid ?? 0)).toBe(false);
    await harness.engine.close();
    await harness.store.close();
  });

  it("leak-child-process: kill reaps the child", async () => {
    for (let iteration = 1; iteration <= LEAK_REPEATS; iteration += 1) {
      const pidFile = path.join(tmpdir(), `tigercat-leak-${process.pid}-${iteration}.pid`);
      const harness = await startStdioEngine("leak-child-process", { TIGERCAT_LEAK_PIDFILE: pidFile });
      roots.push(harness.root);
      try {
        const spawned = await harness.engine.spawn({
          runtime: "leak-child-process",
          prompt: "leak",
          threads: ["feishu:eng:cli"],
        });
        await waitForEvent(harness.engine, (event) => event.type === "worker.spawned");
        // worker.spawned is emitted before the process exists. The leaked
        // child's pid file is written during session/new, which returns
        // before the parent pid is stored. Read the parent only after that
        // store update, then the child file is already written.
        const stub = await waitForRecordedPid(harness.engine, spawned.workerId, iteration);
        let child = 0;
        try {
          child = Number(readFileSync(pidFile, "utf8"));
        } catch {
          child = 0;
        }
        expect(child, `iteration ${iteration} leaked child`).toBeGreaterThan(0);
        expect(alive(child), `iteration ${iteration} child should be alive before kill`).toBe(true);
        const tracked = new Set<number>([stub, child, ...descendantPids(stub)]);
        await harness.engine.kill(spawned.workerId);
        const deadline = Date.now() + 3_000;
        let survivors = [...tracked].filter((pid) => alive(pid));
        while (Date.now() < deadline && survivors.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          survivors = [...tracked].filter((pid) => alive(pid));
        }
        expect(survivors, `iteration ${iteration} descendant pids still alive`).toEqual([]);
      } finally {
        await harness.engine.close();
        await harness.store.close();
      }
    }
    console.log(`leak-child iterations passed: ${LEAK_REPEATS}`);
  }, 120_000);

  it("bad-handshake: version mismatch is worker.error and releases the subscription", async () => {
    const harness = await startStdioEngine("bad-handshake");
    roots.push(harness.root);
    const spawned = await harness.engine.spawn({
      runtime: "bad-handshake",
      prompt: "nope",
      threads: ["feishu:eng:cli"],
    });
    const error = await waitForEvent(harness.engine, (event) => event.type === "worker.error");
    expect(error.workerId).toBe(spawned.workerId);
    expect(String(error.payload.message)).toMatch(/version_mismatch|protocol 999/);
    expect(await harness.engine.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(0);
    await harness.engine.close();
    await harness.store.close();
  });

  it("ask-input: preserves the worker's awaiting-input state", async () => {
    const harness = await startStdioEngine("ask-input");
    roots.push(harness.root);
    const spawned = await harness.engine.spawn({ runtime: "ask-input", prompt: "choose a file", threads: ["feishu:eng:cli"] });
    const end = await waitForEvent(harness.engine, (event) => event.type === "worker.turn_end");
    expect(end.workerId).toBe(spawned.workerId);
    expect(end.payload.awaitingInput).toBe(true);
    expect(end.payload.text).toContain("Which file should I edit?");
    await harness.engine.close();
    await harness.store.close();
  });

  it("slow-stream: forwards all streamed chunks before turn end", async () => {
    const harness = await startStdioEngine("slow-stream");
    roots.push(harness.root);
    const spawned = await harness.engine.spawn({ runtime: "slow-stream", prompt: "stream", threads: ["feishu:eng:cli"] });
    for (let index = 0; index < 4; index += 1) {
      await waitForEvent(harness.engine, (event) => event.workerId === spawned.workerId && event.type === "worker.update" && event.payload.text === `tick-${index} `);
    }
    const end = await waitForEvent(harness.engine, (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end");
    expect(end.payload.stopReason).toBe("end_turn");
    await harness.engine.close();
    await harness.store.close();
  });

  it("no-session-load: restart marks the worker abnormal and routes the next event", async () => {
    const first = await startStdioEngine("no-session-load");
    roots.push(first.root);
    const db = path.join(first.root, "state.sqlite");
    const spawned = await first.engine.spawn({
      runtime: "no-session-load",
      prompt: "persist this",
      threads: ["feishu:eng:cli"],
    });
    await waitForEvent(first.engine, (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end");
    await first.engine.close();
    await first.store.close();

    const secondStore = SqliteStore.open(db);
    const config = defaultConfig();
    config.defaultWorkerRuntime = "no-session-load";
    config.runtimes = [stubRuntime("no-session-load")];
    const second = new Engine({
      store: secondStore,
      clock: new SystemClock(),
      config,
      factory: new ProcessRuntimeFactory({ handshakeTimeoutMs: 8_000 }),
      workspaceRoot: first.root,
    });
    await second.start();
    const recovered = await second.store.getSession(spawned.workerId);
    expect(recovered?.state).toBe("lost");
    const lost = (await second.events()).find((event) => event.type === "worker.lost" && event.workerId === spawned.workerId);
    expect(lost?.payload).toMatchObject({
      code: "lost",
      reason: "load_unsupported",
      message: "worker session could not be restored after restart",
    });
    expect(await second.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(0);
    const follow = await second.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "keith",
      text: "continue after restart",
      kind: "im.message",
      timestamp: Date.now(),
    });
    expect(follow.deliveredTo).not.toContain(spawned.workerId);
    expect(follow.router).toBe(true);
    await second.close();
    await secondStore.close();
  });

  it("huge-output: caps the stored turn summary", async () => {
    const harness = await startStdioEngine("huge-output");
    roots.push(harness.root);
    const spawned = await harness.engine.spawn({ runtime: "huge-output", prompt: "large", threads: ["feishu:eng:cli"] });
    const end = await waitForEvent(harness.engine, (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end");
    expect(String(end.payload.text ?? "").length).toBe(65_536);
    expect(String(end.payload.summary ?? "").length).toBeLessThanOrEqual(1_000);
    const read = await harness.engine.read(end.id);
    expect(JSON.stringify(read)).toContain("spilled");
    await harness.engine.close();
    await harness.store.close();
  });
});
