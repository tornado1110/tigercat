import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { builtinByName, listRuntimes } from "../../src/builtins.js";
import { SystemClock } from "../../src/clock.js";
import { defaultConfig } from "../../src/config.js";
import { Engine } from "../../src/engine.js";
import { pidAlive, ProcessRuntimeFactory, type RuntimeHandle } from "../../src/runtime.js";
import { SqliteStore } from "../../src/store.js";
import { startStdioEngine, stubRuntime, waitForEvent } from "../harness/stdio-engine.js";
import type { RuntimeConfig } from "../../src/types.js";

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

  it.each([
    ["claude-code", "idle", "session-load"],
    ["codex", "idle", "session-load"],
    ["claude-code", "awaiting_input", "session-load"],
    ["codex", "awaiting_input", "session-load"],
    ["claude-code", "running", "session-load-hang"],
    ["codex", "running", "session-load-hang"],
  ] as const)(
    "%s in %s is lost once on restart and a second restart adds no events",
    async (name, state, scenario) => {
      await expectBuiltinNameLost(name, state, scenario);
    },
  );

  it("a configured override named claude-code is not loaded and goes lost", async () => {
    await expectBuiltinNameLost("claude-code", "idle", "session-load", true);
  });

  it.each([
    ["load_failed", "session-load-fail"],
    ["load_unsupported", "no-session-load"],
  ] as const)("non-built-in restart with %s releases the subscription", async (reason, scenario) => {
    await expectNonBuiltinLost(scenario, reason);
  });

  it("no_session when restart finds no recorded ACP session id", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "tigercat-no-session-"));
    roots.push(scratch);
    const env = {
      TIGERCAT_STUB_SESSION_FILE: path.join(scratch, "session-id"),
      TIGERCAT_STUB_SESSION_LOG: path.join(scratch, "session-log"),
    };
    const first = await startStdioEngine("session-load", env);
    roots.push(first.root);
    const db = path.join(first.root, "state.sqlite");
    const spawned = await first.engine.spawn({
      runtime: "session-load",
      prompt: "finish before restart",
      threads: ["feishu:eng:cli"],
    });
    await waitForEvent(first.engine, (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end");
    expect((await first.engine.store.getSession(spawned.workerId))?.acpSessionId).toMatch(/^stub-load-/);
    await first.engine.close();
    await first.store.close();
    clearAcpSessionId(db, spawned.workerId);
    const second = openRecoveredEngine(first.root, db, "session-load", env);
    try {
      await second.engine.start();
      await assertLostOnce(second.engine, spawned.workerId, "no_session");
    } finally {
      await second.engine.close();
      await second.store.close();
    }
  });

  it("session_mismatch when session/load reports a different session id", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "tigercat-mismatch-"));
    roots.push(scratch);
    const env = {
      TIGERCAT_STUB_SESSION_FILE: path.join(scratch, "session-id"),
      TIGERCAT_STUB_SESSION_LOG: path.join(scratch, "session-log"),
    };
    const first = await startStdioEngine("session-load", env);
    roots.push(first.root);
    const db = path.join(first.root, "state.sqlite");
    const spawned = await first.engine.spawn({
      runtime: "session-load",
      prompt: "finish before restart",
      threads: ["feishu:eng:cli"],
    });
    await waitForEvent(first.engine, (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end");
    const saved = (await first.engine.store.getSession(spawned.workerId))?.acpSessionId;
    expect(saved).toMatch(/^stub-load-/);
    await first.engine.close();
    await first.store.close();
    const second = openRecoveredEngine(first.root, db, "session-load", env, new MismatchFactory("stub-other-session"));
    try {
      await second.engine.start();
      await assertLostOnce(second.engine, spawned.workerId, "session_mismatch");
      expect(readFileSync(env.TIGERCAT_STUB_SESSION_LOG, "utf8")).toContain(`load ${saved}`);
    } finally {
      await second.engine.close();
      await second.store.close();
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

class MismatchFactory extends ProcessRuntimeFactory {
  constructor(private readonly reportedSessionId: string) {
    super({ handshakeTimeoutMs: 8_000 });
  }

  override async loadSession(runtime: RuntimeConfig, ctx: Parameters<ProcessRuntimeFactory["loadSession"]>[1], acpSessionId: string): Promise<RuntimeHandle> {
    const handle = await super.loadSession(runtime, ctx, acpSessionId);
    const reportedSessionId = this.reportedSessionId;
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (prop === "acpSessionId") return reportedSessionId;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

async function expectBuiltinNameLost(name: "claude-code" | "codex", state: "idle" | "awaiting_input" | "running", scenario: string, expectOverride = false): Promise<void> {
  const scratch = mkdtempSync(path.join(tmpdir(), "tigercat-builtin-"));
  roots.push(scratch);
  const logFile = path.join(scratch, "session-log");
  const env = {
    TIGERCAT_STUB_SESSION_FILE: path.join(scratch, "session-id"),
    TIGERCAT_STUB_SESSION_LOG: logFile,
  };
  const runtime = { ...stubRuntime(scenario, env), name };
  expect(builtinByName(name)?.name).toBe(name);
  expect(runtime.command).toBe(process.execPath);
  const first = await startNamedEngine(name, runtime, scratch);
  roots.push(first.root);
  const db = path.join(first.root, "state.sqlite");
  const prompt = state === "awaiting_input" ? "Which file?" : state === "running" ? "stay in the turn" : "finish before restart";
  const spawned = await first.engine.spawn({
    runtime: name,
    prompt,
    threads: ["feishu:eng:cli"],
  });
  if (state === "running") {
    await waitForRunning(first.engine, spawned.workerId);
  } else {
    const ended = await waitForEvent(first.engine, (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end");
    if (state === "awaiting_input") expect(ended.payload.awaitingInput).toBe(true);
  }
  expect((await first.engine.store.getSession(spawned.workerId))?.state).toBe(state);
  expect(await first.engine.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(1);
  await first.engine.close();
  await first.store.close();

  const second = await startNamedEngine(name, runtime, first.root, db);
  let eventIds: string[] = [];
  try {
    if (expectOverride) {
      const listed = listRuntimes(second.engine.config).find((entry) => entry.name === name);
      expect(listed?.overridden).toBe(true);
      expect(listed?.command).toBe(process.execPath);
    }
    await second.engine.settle();
    await assertLostOnce(second.engine, spawned.workerId, "builtin_no_restore", "built-in runtime does not restore sessions yet", false);
    expect(readFileSync(logFile, "utf8")).not.toMatch(/^load /m);
    eventIds = (await second.engine.events()).map((event) => event.id);
  } finally {
    await second.engine.close();
    await second.store.close();
  }

  const third = await startNamedEngine(name, runtime, first.root, db);
  try {
    await third.engine.settle();
    expect((await third.engine.events()).map((event) => event.id)).toEqual(eventIds);
    expect((await third.engine.store.getSession(spawned.workerId))?.state).toBe("lost");
    const follow = await third.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "keith",
      text: "continue after restart",
      kind: "im.message",
      timestamp: Date.now(),
    });
    expect(follow.deliveredTo).not.toContain(spawned.workerId);
    expect(follow.router).toBe(true);
    const lost = (await third.engine.events()).filter((event) => event.type === "worker.lost" && event.workerId === spawned.workerId);
    expect(lost).toHaveLength(1);
    expect(readFileSync(logFile, "utf8")).not.toMatch(/^load /m);
  } finally {
    await third.engine.close();
    await third.store.close();
  }
}

async function expectNonBuiltinLost(scenario: string, reason: string): Promise<void> {
  const first = await startStdioEngine(scenario);
  roots.push(first.root);
  const db = path.join(first.root, "state.sqlite");
  const spawned = await first.engine.spawn({
    runtime: scenario,
    prompt: "finish before restart",
    threads: ["feishu:eng:cli"],
  });
  await waitForEvent(first.engine, (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end");
  expect((await first.engine.store.getSession(spawned.workerId))?.state).toBe("idle");
  await first.engine.close();
  await first.store.close();
  const second = openRecoveredEngine(first.root, db, scenario, {});
  try {
    await second.engine.start();
    await assertLostOnce(second.engine, spawned.workerId, reason);
  } finally {
    await second.engine.close();
    await second.store.close();
  }
}

function openRecoveredEngine(root: string, db: string, scenario: string, env: Record<string, string>, factory?: ProcessRuntimeFactory) {
  const store = SqliteStore.open(db);
  const config = defaultConfig();
  config.defaultWorkerRuntime = scenario;
  config.runtimes = [stubRuntime(scenario, env)];
  const engine = new Engine({
    store,
    clock: new SystemClock(),
    config,
    factory: factory ?? new ProcessRuntimeFactory({ handshakeTimeoutMs: 8_000 }),
    workspaceRoot: root,
  });
  return { engine, store };
}

async function assertLostOnce(engine: Engine, workerId: string, reason: string, message = "worker session could not be restored after restart", ingest = true): Promise<void> {
  expect((await engine.store.getSession(workerId))?.state).toBe("lost");
  const lost = (await engine.events()).filter((event) => event.type === "worker.lost" && event.workerId === workerId);
  expect(lost).toHaveLength(1);
  expect(lost[0]?.payload).toMatchObject({ code: "lost", reason, message });
  expect(await engine.store.subscriptionsForWorker(workerId)).toHaveLength(0);
  if (!ingest) return;
  const follow = await engine.ingest({
    source: "feishu",
    thread: "feishu:eng:cli",
    author: "keith",
    text: "continue after restart",
    kind: "im.message",
    timestamp: Date.now(),
  });
  expect(follow.deliveredTo).not.toContain(workerId);
  expect(follow.router).toBe(true);
}

function clearAcpSessionId(file: string, workerId: string): void {
  const db = new DatabaseSync(file);
  try {
    db.prepare("UPDATE sessions SET acp_session_id = NULL WHERE id = ?").run(workerId);
  } finally {
    db.close();
  }
}

async function startNamedEngine(name: string, runtime: RuntimeConfig, workspaceRoot: string, db?: string) {
  const root = db ? workspaceRoot : mkdtempSync(path.join(tmpdir(), "tigercat-stdio-"));
  const store = SqliteStore.open(db ?? path.join(root, "state.sqlite"));
  const config = defaultConfig();
  config.defaultWorkerRuntime = name;
  config.runtimes = [runtime];
  const engine = new Engine({
    store,
    clock: new SystemClock(),
    config,
    factory: new ProcessRuntimeFactory({ handshakeTimeoutMs: 8_000 }),
    workspaceRoot: root,
  });
  await engine.start();
  return { engine, store, root };
}

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
