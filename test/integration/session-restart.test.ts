import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SystemClock } from "../../src/clock.js";
import { defaultConfig } from "../../src/config.js";
import { Engine } from "../../src/engine.js";
import { pidAlive, ProcessRuntimeFactory } from "../../src/runtime.js";
import { SqliteStore } from "../../src/store.js";
import { startStdioEngine, stubRuntime, waitForEvent } from "../harness/stdio-engine.js";

/**
 * POSIX hand check (the test below is the CI evidence):
 *
 *   npx vitest run test/integration/session-restart.test.ts -t SIGKILL
 *
 * Windows uses Node's SIGKILL, which is TerminateProcess, and tasklist
 * instead of ps. The test is not skipped there: the child is a real process
 * and it has to be gone afterward.
 */
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTree(root);
});

describe("restart recovery over stdio", () => {
  it("SIGKILL of a running worker is not left running after restart", async () => {
    const first = await startStdioEngine("hang");
    roots.push(first.root);
    const spawned = await first.engine.spawn({
      runtime: "hang",
      prompt: "stay running",
      threads: ["feishu:eng:cli"],
    });
    const running = await waitForRunning(first.engine, spawned.workerId);
    expect(listedByOs(running.pid), "ps should list the live worker").toBe(true);
    expect(pidAlive(running.pid)).toBe(listedByOs(running.pid));

    const snapshot = path.join(first.root, "restart.sqlite");
    snapshotDatabase(path.join(first.root, "state.sqlite"), snapshot);
    expect(readSnapshot(snapshot, spawned.workerId)).toEqual({ state: "running", pid: running.pid });

    process.kill(running.pid, "SIGKILL");
    await waitUntilDead(running.pid);
    expect(readSnapshot(snapshot, spawned.workerId)).toEqual({ state: "running", pid: running.pid });
    expect(listedByOs(running.pid), "ps should not list the killed worker").toBe(false);
    expect(pidAlive(running.pid)).toBe(false);

    const secondStore = SqliteStore.open(snapshot);
    const config = defaultConfig();
    config.defaultWorkerRuntime = "hang";
    config.runtimes = [stubRuntime("hang")];
    const second = new Engine({
      store: secondStore,
      clock: new SystemClock(),
      config,
      factory: new ProcessRuntimeFactory({ handshakeTimeoutMs: 8_000 }),
      workspaceRoot: first.root,
    });
    try {
      await second.start();
      const recovered = await second.store.getSession(spawned.workerId);
      expect(recovered?.state).toBe("lost");
      expect(recovered?.pid).toBeNull();
      expect(listedByOs(running.pid)).toBe(false);
      expect(pidAlive(running.pid)).toBe(false);
      const lost = (await second.events()).find((event) => event.type === "worker.lost" && event.workerId === spawned.workerId);
      expect(lost?.payload).toMatchObject({
        code: "lost",
        reason: "in_flight_turn",
        message: "in-flight turn was lost on restart",
      });
    } finally {
      await second.close();
      await secondStore.close();
      await first.engine.close();
      await first.store.close();
    }
  });

  it("SIGKILL during a turn is lost even when session/load would succeed", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "tigercat-midturn-"));
    roots.push(scratch);
    const env = {
      TIGERCAT_STUB_SESSION_FILE: path.join(scratch, "session-id"),
      TIGERCAT_STUB_SESSION_LOG: path.join(scratch, "session-log"),
    };
    const first = await startStdioEngine("session-load-hang", env);
    roots.push(first.root);
    const spawned = await first.engine.spawn({
      runtime: "session-load-hang",
      prompt: "stay in the turn",
      threads: ["feishu:eng:cli"],
    });
    const running = await waitForRunning(first.engine, spawned.workerId);
    const before = await first.engine.store.getSession(spawned.workerId);
    expect(before?.acpSessionId).toMatch(/^stub-load-/);
    expect(await first.engine.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(1);
    expect(listedByOs(running.pid)).toBe(true);

    const snapshot = path.join(first.root, "restart.sqlite");
    snapshotDatabase(path.join(first.root, "state.sqlite"), snapshot);
    expect(readSnapshot(snapshot, spawned.workerId).state).toBe("running");
    process.kill(running.pid, "SIGKILL");
    await waitUntilDead(running.pid);

    const secondStore = SqliteStore.open(snapshot);
    const config = defaultConfig();
    config.defaultWorkerRuntime = "session-load-hang";
    config.runtimes = [stubRuntime("session-load-hang", env)];
    const second = new Engine({
      store: secondStore,
      clock: new SystemClock(),
      config,
      factory: new ProcessRuntimeFactory({ handshakeTimeoutMs: 8_000 }),
      workspaceRoot: first.root,
    });
    try {
      await second.start();
      const recovered = await second.store.getSession(spawned.workerId);
      expect(recovered?.state).toBe("lost");
      const lost = (await second.events()).find((event) => event.type === "worker.lost" && event.workerId === spawned.workerId);
      expect(lost?.payload).toMatchObject({
        code: "lost",
        reason: "in_flight_turn",
        message: "in-flight turn was lost on restart",
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
      expect((await second.events()).some((event) => event.workerId === spawned.workerId && event.type === "worker.turn_end")).toBe(false);
    } finally {
      await second.close();
      await secondStore.close();
      await first.engine.close();
      await first.store.close();
    }
  });

  it("session/load resumes the same ACP session and keeps direct routing", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "tigercat-load-"));
    roots.push(scratch);
    const sessionFile = path.join(scratch, "session-id");
    const logFile = path.join(scratch, "session-log");
    const env = {
      TIGERCAT_STUB_SESSION_FILE: sessionFile,
      TIGERCAT_STUB_SESSION_LOG: logFile,
    };
    const first = await startStdioEngine("session-load", env);
    roots.push(first.root);
    const db = path.join(first.root, "state.sqlite");
    const spawned = await first.engine.spawn({
      runtime: "session-load",
      prompt: "remember this session",
      threads: ["feishu:eng:cli"],
    });
    const ended = await waitForEvent(first.engine, (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end");
    const before = await first.engine.store.getSession(spawned.workerId);
    expect(before?.acpSessionId).toMatch(/^stub-load-/);
    expect(await first.engine.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(1);
    await first.engine.close();
    await first.store.close();

    const secondStore = SqliteStore.open(db);
    const config = defaultConfig();
    config.defaultWorkerRuntime = "session-load";
    config.runtimes = [stubRuntime("session-load", env)];
    const second = new Engine({
      store: secondStore,
      clock: new SystemClock(),
      config,
      factory: new ProcessRuntimeFactory({ handshakeTimeoutMs: 8_000 }),
      workspaceRoot: first.root,
    });
    try {
      await second.start();
      const after = await second.store.getSession(spawned.workerId);
      expect(after?.acpSessionId).toBe(before?.acpSessionId);
      expect(after?.state).toBe("idle");
      expect(await second.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(1);
      const log = readFileSync(logFile, "utf8");
      expect(log).toContain(`load ${before?.acpSessionId}`);
      expect(log.match(/^new /gm)).toHaveLength(1);

      const follow = await second.ingest({
        source: "feishu",
        thread: "feishu:eng:cli",
        author: "keith",
        text: "continue after restart",
        kind: "im.message",
        timestamp: Date.now(),
      });
      expect(follow.deliveredTo).toEqual([spawned.workerId]);
      expect(follow.router).toBe(false);
      await waitForEvent(second, (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end" && event.id !== ended.id);
      await second.settle();
      const routedTriggers = (await second.routerTurns())
        .flatMap((turn) => turn.items)
        .filter((item) => item.kind === "trigger");
      expect(routedTriggers).toEqual([]);
    } finally {
      await second.close();
      await secondStore.close();
    }
  });
});

function readSnapshot(file: string, workerId: string): { state: string; pid: number | null } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT state, pid FROM sessions WHERE id = ?").get(workerId) as
      | { state: string; pid: number | null }
      | undefined;
    if (!row) throw new Error(`snapshot has no session ${workerId}`);
    return { state: row.state, pid: row.pid };
  } finally {
    db.close();
  }
}

function snapshotDatabase(source: string, dest: string): void {
  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA wal_checkpoint(FULL);");
    const escaped = dest.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
}

function listedByOs(pid: number): boolean {
  if (process.platform === "win32") {
    let out = "";
    try {
      out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
    } catch {
      return false;
    }
    return out.includes(`"${pid}"`);
  }
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" });
    return out.trim() === String(pid);
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    if (!listedByOs(pid) && !pidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`pid ${pid} is still listed after SIGKILL`);
}

async function waitForRunning(engine: Engine, workerId: string): Promise<{ pid: number }> {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    const session = await engine.store.getSession(workerId);
    if (session?.pid && session.pid > 0 && session.state === "running") return { pid: session.pid };
    if (session && (session.state === "error" || session.state === "killed" || session.state === "lost")) {
      throw new Error(`worker ${workerId} became ${session.state} before it was running`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`worker ${workerId} did not stay running with a pid`);
}

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
