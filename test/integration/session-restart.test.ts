import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { upstreamForwardsEvent } from "../../src/acp-agent.js";
import { builtinByName, CLAUDE_AGENT_ACP_VERSION, CLAUDE_AGENT_INFO_NAME, CODEX_ACP_VERSION, CODEX_AGENT_INFO_NAME, listRuntimes } from "../../src/builtins.js";
import { SystemClock } from "../../src/clock.js";
import { defaultConfig } from "../../src/config.js";
import { Engine } from "../../src/engine.js";
import { ImChannel } from "../../src/im-channel.js";
import { workerResultText } from "../../src/upstream-delivery.js";
import { pidAlive, ProcessRuntimeFactory, type RuntimeHandle } from "../../src/runtime.js";
import { SqliteStore } from "../../src/store.js";
import { startStdioEngine, stubRuntime, waitForEvent } from "../harness/stdio-engine.js";
import type { RuntimeConfig, TigerEvent } from "../../src/types.js";

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
      const lost = (await second.events()).filter((event) => event.type === "worker.lost" && event.workerId === spawned.workerId);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.payload.reason).toBe("in_flight_turn");
      expect(lost[0]?.payload).toMatchObject({
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
      const lost = (await second.events()).filter((event) => event.type === "worker.lost" && event.workerId === spawned.workerId);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.payload.reason).toBe("in_flight_turn");
      expect(lost[0]?.payload).toMatchObject({
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
    ["claude-code", CLAUDE_AGENT_INFO_NAME, CLAUDE_AGENT_ACP_VERSION],
    ["codex", CODEX_AGENT_INFO_NAME, CODEX_ACP_VERSION],
  ] as const)(
    "%s in running is lost with in_flight_turn even when the adapter identity is allowlisted",
    async (name, agentName, agentVersion) => {
      await expectRestartLost(name, "running", "session-load-hang", {
        reason: "in_flight_turn",
        message: "in-flight turn was lost on restart",
        agentName,
        agentVersion,
      });
    },
  );

  it.each([
    ["idle", CLAUDE_AGENT_INFO_NAME, "0.107.0"],
    ["awaiting_input", CODEX_AGENT_INFO_NAME, "2.6.0"],
  ] as const)(
    "built-in identity at a different version in %s is lost with builtin_no_restore and is not loaded",
    async (state, agentName, agentVersion) => {
      await expectRestartLost("claude-code", state, "session-load", {
        reason: "builtin_no_restore",
        message: "built-in runtime does not restore sessions yet",
        agentName,
        agentVersion,
        expectOverride: true,
      });
    },
  );

  it.each([
    [CLAUDE_AGENT_INFO_NAME, CLAUDE_AGENT_ACP_VERSION],
    [CODEX_AGENT_INFO_NAME, CODEX_ACP_VERSION],
  ] as const)("allowlisted identity %s %s restores the idle session", async (agentName, agentVersion) => {
    await expectIdentityRestored({ runtimeName: "restore-me", agentName, agentVersion });
  });

  it("a runtime named claude-code restores when its adapter reports an allowlisted identity", async () => {
    await expectIdentityRestored({
      runtimeName: "claude-code",
      agentName: CLAUDE_AGENT_INFO_NAME,
      agentVersion: CLAUDE_AGENT_ACP_VERSION,
      expectOverride: true,
    });
  });

  it("a runtime named claude-code restores when its adapter reports a non-built-in identity", async () => {
    await expectIdentityRestored({
      runtimeName: "claude-code",
      agentName: "custom-acp",
      agentVersion: "1.0.0",
      expectOverride: true,
    });
  });

  it("allowlisted identity with loadSession false is lost with load_unsupported", async () => {
    await expectCapabilityLost(CLAUDE_AGENT_INFO_NAME, CLAUDE_AGENT_ACP_VERSION);
  });

  it("session/load replay adds no rows and no channel deliveries across two restarts", async () => {
    const replay = 8;
    const scratch = mkdtempSync(path.join(tmpdir(), "tigercat-replay-"));
    roots.push(scratch);
    const logFile = path.join(scratch, "session-log");
    const env = {
      TIGERCAT_STUB_SESSION_FILE: path.join(scratch, "session-id"),
      TIGERCAT_STUB_SESSION_LOG: logFile,
      TIGERCAT_STUB_REPLAY: String(replay),
      TIGERCAT_STUB_AGENT_NAME: CLAUDE_AGENT_INFO_NAME,
      TIGERCAT_STUB_AGENT_VERSION: CLAUDE_AGENT_ACP_VERSION,
    };
    const runtime = { ...stubRuntime("session-load", env), name: "claude-code" };
    const feishuSent: string[] = [];
    const upstreamSent: string[] = [];
    const attachChannels = (engine: Engine) => {
      // Feishu delivers through ImChannel. The upstream hook uses the same
      // predicate as AcpDeliveryManager. worker.update is not one of those events.
      const channel = new ImChannel(engine, "feishu", "claude-code", {
        send: async ({ text }) => {
          feishuSent.push(text);
          return { disposition: "delivered", reason: "accepted" };
        },
      }, () => undefined);
      engine.addHook((event) => {
        if (!upstreamForwardsEvent(event)) return;
        upstreamSent.push(workerResultText(event));
      });
      return channel;
    };

    const first = await startNamedEngine("claude-code", runtime, scratch, undefined, false);
    roots.push(first.root);
    const db = path.join(first.root, "state.sqlite");
    const firstChannel = attachChannels(first.engine);
    let workerId = "";
    let sessionId = "";
    let storedCount = 0;
    let readCount = 0;
    try {
      await first.engine.start();
      await firstChannel.start();
      await firstChannel.receive({
        id: "m1",
        conversation: "eng",
        text: "finish before restart",
        replyTarget: { messageId: "m1" },
      });
      workerId = (await first.engine.list())[0]?.id ?? "";
      expect(workerId).not.toBe("");
      const before = await first.engine.store.getSession(workerId);
      sessionId = before?.acpSessionId ?? "";
      expect(sessionId).toMatch(/^stub-load-/);
      const stored = await first.engine.events();
      expect(stored.filter((event) => replayEvent(event))).toEqual([]);
      storedCount = stored.filter((event) => event.workerId === workerId).length;
      readCount = (await readWorker(first.engine, workerId)).events.length;
      expect(feishuSent).toHaveLength(1);
      expect(upstreamSent).toHaveLength(1);
      expect(feishuSent.some((text) => text.includes("REPLAY_"))).toBe(false);
      expect(upstreamSent.some((text) => text.includes("REPLAY_"))).toBe(false);
      expect(await first.engine.store.listDeliveries()).toHaveLength(1);
    } finally {
      await firstChannel.stop();
      await first.engine.close();
      await first.store.close();
    }

    for (let pass = 1; pass <= 2; pass += 1) {
      const restarted = await startNamedEngine("claude-code", runtime, first.root, db, false);
      const channel = attachChannels(restarted.engine);
      try {
        await restarted.engine.start();
        await channel.start();
        await flushHooks();
        const stored = await restarted.engine.events();
        const workerEvents = stored.filter((event) => event.workerId === workerId);
        expect(workerEvents.filter((event) => replayEvent(event))).toEqual([]);
        expect(workerEvents).toHaveLength(storedCount + 1);
        storedCount = workerEvents.length;
        const view = await readWorker(restarted.engine, workerId);
        expect(view.events).toHaveLength(readCount + 1);
        expect(view.events.some((event) => event.summary.includes("REPLAY_"))).toBe(false);
        readCount = view.events.length;
        const recovered = workerEvents.filter((event) => event.type === "worker.update" && event.payload.recovered === true && event.payload.nativeSession === "loaded");
        expect(recovered).toHaveLength(pass);
        expect((await restarted.engine.store.getSession(workerId))?.state).toBe("idle");
        expect((await restarted.engine.store.getSession(workerId))?.acpSessionId).toBe(sessionId);
        expect(feishuSent).toHaveLength(1);
        expect(upstreamSent).toHaveLength(1);
        expect(feishuSent.some((text) => text.includes("REPLAY_"))).toBe(false);
        expect(upstreamSent.some((text) => text.includes("REPLAY_"))).toBe(false);
        const deliveries = await restarted.engine.store.listDeliveries();
        expect(deliveries).toHaveLength(1);
        expect(deliveries.some((row) => row.text.includes("REPLAY_"))).toBe(false);
        expect(readFileSync(logFile, "utf8").match(new RegExp(`^replay ${replay}$`, "gm"))).toHaveLength(pass);
      } finally {
        await channel.stop();
        await restarted.engine.close();
        await restarted.store.close();
      }
    }

    const follow = await startNamedEngine("claude-code", runtime, first.root, db, false);
    const followChannel = attachChannels(follow.engine);
    try {
      await follow.engine.start();
      await followChannel.start();
      await followChannel.receive({
        id: "m2",
        conversation: "eng",
        text: "continue after restart",
        replyTarget: { messageId: "m2" },
      });
      await flushHooks();
      const stored = await follow.engine.events();
      expect(stored.filter((event) => replayEvent(event))).toEqual([]);
      const view = await readWorker(follow.engine, workerId);
      expect(view.events.filter((event) => event.summary.includes("REPLAY_"))).toEqual([]);
      const followChunks = stored.filter((event) => event.workerId === workerId && event.type === "worker.update" && String(event.payload.text ?? "").includes("continue after restart"));
      const ends = stored.filter((event) => event.workerId === workerId && event.type === "worker.turn_end" && String(event.payload.text ?? "").includes("continue after restart"));
      expect(followChunks).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(view.events.filter((event) => event.summary.includes("continue after restart"))).toHaveLength(followChunks.length + ends.length);
      expect(feishuSent.filter((text) => text.includes("continue after restart"))).toHaveLength(1);
      expect(upstreamSent.filter((text) => text.includes("continue after restart"))).toHaveLength(1);
      expect(feishuSent.filter((text) => text.includes("REPLAY_"))).toEqual([]);
      expect(upstreamSent.filter((text) => text.includes("REPLAY_"))).toEqual([]);
      expect((await follow.engine.store.listDeliveries()).filter((row) => row.text.includes("REPLAY_"))).toEqual([]);
    } finally {
      await followChannel.stop();
      await follow.engine.close();
      await follow.store.close();
    }
  });

  it("a session/update after the load response is stored and not delivered, across two restarts", async () => {
    const replay = 4;
    const scratch = mkdtempSync(path.join(tmpdir(), "tigercat-post-load-"));
    roots.push(scratch);
    const logFile = path.join(scratch, "session-log");
    const env = {
      TIGERCAT_STUB_SESSION_FILE: path.join(scratch, "session-id"),
      TIGERCAT_STUB_SESSION_LOG: logFile,
      TIGERCAT_STUB_REPLAY: String(replay),
      TIGERCAT_STUB_POST_LOAD: "1",
      TIGERCAT_STUB_AGENT_NAME: CLAUDE_AGENT_INFO_NAME,
      TIGERCAT_STUB_AGENT_VERSION: CLAUDE_AGENT_ACP_VERSION,
    };
    const runtime = { ...stubRuntime("session-load", env), name: "claude-code" };
    const feishuSent: string[] = [];
    const upstreamSent: string[] = [];
    const attachChannels = (engine: Engine) => {
      const channel = new ImChannel(engine, "feishu", "claude-code", {
        send: async ({ text }) => {
          feishuSent.push(text);
          return { disposition: "delivered", reason: "accepted" };
        },
      }, () => undefined);
      engine.addHook((event) => {
        if (!upstreamForwardsEvent(event)) return;
        upstreamSent.push(workerResultText(event));
      });
      return channel;
    };

    const first = await startNamedEngine("claude-code", runtime, scratch, undefined, false);
    roots.push(first.root);
    const db = path.join(first.root, "state.sqlite");
    const firstChannel = attachChannels(first.engine);
    let workerId = "";
    try {
      await first.engine.start();
      await firstChannel.start();
      await firstChannel.receive({
        id: "m1",
        conversation: "eng",
        text: "finish before restart",
        replyTarget: { messageId: "m1" },
      });
      workerId = (await first.engine.list())[0]?.id ?? "";
      expect(workerId).not.toBe("");
      expect((await first.engine.events()).filter((event) => replayEvent(event) || postLoadEvent(event))).toEqual([]);
      expect(feishuSent).toHaveLength(1);
      expect(upstreamSent).toHaveLength(1);
      expect(await first.engine.store.listDeliveries()).toHaveLength(1);
    } finally {
      await firstChannel.stop();
      await first.engine.close();
      await first.store.close();
    }

    for (let pass = 1; pass <= 2; pass += 1) {
      const restarted = await startNamedEngine("claude-code", runtime, first.root, db, false);
      const channel = attachChannels(restarted.engine);
      try {
        await restarted.engine.start();
        await channel.start();
        await waitForPostLoad(restarted.engine, workerId, pass);
        await flushHooks();
        const workerEvents = (await restarted.engine.events()).filter((event) => event.workerId === workerId);
        expect(workerEvents.filter((event) => replayEvent(event))).toEqual([]);
        const postLoad = workerEvents.filter((event) => postLoadEvent(event));
        expect(postLoad).toHaveLength(pass);
        expect(postLoad.every((event) => event.type === "worker.update" && event.payload.recovered !== true)).toBe(true);
        const recovered = workerEvents.filter((event) => event.type === "worker.update" && event.payload.recovered === true && event.payload.nativeSession === "loaded");
        expect(recovered).toHaveLength(pass);
        const view = await readWorker(restarted.engine, workerId);
        expect(view.events).toHaveLength(workerEvents.length);
        expect(view.events.some((event) => event.summary.includes("REPLAY_"))).toBe(false);
        expect(feishuSent).toHaveLength(1);
        expect(upstreamSent).toHaveLength(1);
        expect(feishuSent.some((text) => text.includes("REPLAY_") || text.includes("POST_LOAD_COMMANDS"))).toBe(false);
        expect(upstreamSent.some((text) => text.includes("REPLAY_") || text.includes("POST_LOAD_COMMANDS"))).toBe(false);
        const deliveries = await restarted.engine.store.listDeliveries();
        expect(deliveries).toHaveLength(1);
        expect(deliveries.some((row) => row.text.includes("REPLAY_") || row.text.includes("POST_LOAD_COMMANDS"))).toBe(false);
        const log = readFileSync(logFile, "utf8");
        expect(log.match(new RegExp(`^replay ${replay}$`, "gm"))).toHaveLength(pass);
        expect(log.match(/^post-load /gm)).toHaveLength(pass);
      } finally {
        await channel.stop();
        await restarted.engine.close();
        await restarted.store.close();
      }
    }
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

async function expectRestartLost(
  name: "claude-code" | "codex",
  state: "idle" | "awaiting_input" | "running",
  scenario: string,
  expected: {
    reason: "builtin_no_restore" | "in_flight_turn";
    message: string;
    agentName: string;
    agentVersion: string;
    expectOverride?: boolean;
  },
): Promise<void> {
  const scratch = mkdtempSync(path.join(tmpdir(), "tigercat-builtin-"));
  roots.push(scratch);
  const logFile = path.join(scratch, "session-log");
  const env = {
    TIGERCAT_STUB_SESSION_FILE: path.join(scratch, "session-id"),
    TIGERCAT_STUB_SESSION_LOG: logFile,
    TIGERCAT_STUB_AGENT_NAME: expected.agentName,
    TIGERCAT_STUB_AGENT_VERSION: expected.agentVersion,
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
    if (expected.expectOverride) {
      const listed = listRuntimes(second.engine.config).find((entry) => entry.name === name);
      expect(listed?.overridden).toBe(true);
      expect(listed?.command).toBe(process.execPath);
    }
    await second.engine.settle();
    await assertLostOnce(second.engine, spawned.workerId, expected.reason, expected.message, false);
    expect(readFileSync(logFile, "utf8")).not.toMatch(/^load /m);
    expect(readFileSync(logFile, "utf8")).not.toContain("load-request");
    const interrupted = (await second.engine.events()).filter((event) => event.workerId === spawned.workerId && event.payload.state === "interrupted");
    expect(interrupted).toEqual([]);
    expect((await second.engine.store.getSession(spawned.workerId))?.state).not.toBe("interrupted");
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
    expect(lost[0]?.payload.reason).toBe(expected.reason);
    expect(readFileSync(logFile, "utf8")).not.toMatch(/^load /m);
    expect(readFileSync(logFile, "utf8")).not.toContain("load-request");
  } finally {
    await third.engine.close();
    await third.store.close();
  }
}

async function expectIdentityRestored(options: {
  runtimeName: string;
  agentName: string;
  agentVersion: string;
  expectOverride?: boolean;
}): Promise<void> {
  const scratch = mkdtempSync(path.join(tmpdir(), "tigercat-identity-"));
  roots.push(scratch);
  const logFile = path.join(scratch, "session-log");
  const env = {
    TIGERCAT_STUB_SESSION_FILE: path.join(scratch, "session-id"),
    TIGERCAT_STUB_SESSION_LOG: logFile,
    TIGERCAT_STUB_AGENT_NAME: options.agentName,
    TIGERCAT_STUB_AGENT_VERSION: options.agentVersion,
  };
  const runtime = { ...stubRuntime("session-load", env), name: options.runtimeName };
  const first = await startNamedEngine(options.runtimeName, runtime, scratch);
  roots.push(first.root);
  const db = path.join(first.root, "state.sqlite");
  const spawned = await first.engine.spawn({
    runtime: options.runtimeName,
    prompt: "remember this session",
    threads: ["feishu:eng:cli"],
  });
  const ended = await waitForEvent(first.engine, (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end");
  const before = await first.engine.store.getSession(spawned.workerId);
  expect(before?.acpSessionId).toMatch(/^stub-load-/);
  expect(before?.state).toBe("idle");
  expect(await first.engine.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(1);
  await first.engine.close();
  await first.store.close();

  const second = await startNamedEngine(options.runtimeName, runtime, first.root, db);
  try {
    if (options.expectOverride) {
      const listed = listRuntimes(second.engine.config).find((entry) => entry.name === options.runtimeName);
      expect(listed?.overridden).toBe(true);
    }
    await second.engine.settle();
    const after = await second.engine.store.getSession(spawned.workerId);
    expect(after?.state).toBe("idle");
    expect(after?.acpSessionId).toBe(before?.acpSessionId);
    expect(await second.engine.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(1);
    expect((await second.engine.events()).some((event) => event.type === "worker.lost" && event.workerId === spawned.workerId)).toBe(false);
    expect((await second.engine.store.getSession(spawned.workerId))?.state).not.toBe("interrupted");
    const recovered = (await second.engine.events()).filter((event) => event.workerId === spawned.workerId && event.type === "worker.update" && event.payload.nativeSession === "loaded");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.payload.recovered).toBe(true);
    expect(readFileSync(logFile, "utf8")).toContain(`load ${before?.acpSessionId}`);
    const follow = await second.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "keith",
      text: "continue after restart",
      kind: "im.message",
      timestamp: Date.now(),
    });
    expect(follow.deliveredTo).toEqual([spawned.workerId]);
    expect(follow.router).toBe(false);
    await waitForEvent(second.engine, (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end" && event.id !== ended.id);
  } finally {
    await second.engine.close();
    await second.store.close();
  }
}

async function expectCapabilityLost(agentName: string, agentVersion: string): Promise<void> {
  const scratch = mkdtempSync(path.join(tmpdir(), "tigercat-capability-"));
  roots.push(scratch);
  const logFile = path.join(scratch, "session-log");
  const env = {
    TIGERCAT_STUB_SESSION_LOG: logFile,
    TIGERCAT_STUB_AGENT_NAME: agentName,
    TIGERCAT_STUB_AGENT_VERSION: agentVersion,
  };
  const runtime = { ...stubRuntime("no-session-load", env), name: "claude-code" };
  const first = await startNamedEngine("claude-code", runtime, scratch);
  roots.push(first.root);
  const db = path.join(first.root, "state.sqlite");
  const spawned = await first.engine.spawn({
    runtime: "claude-code",
    prompt: "finish before restart",
    threads: ["feishu:eng:cli"],
  });
  await waitForEvent(first.engine, (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end");
  expect((await first.engine.store.getSession(spawned.workerId))?.state).toBe("idle");
  await first.engine.close();
  await first.store.close();
  const second = await startNamedEngine("claude-code", runtime, first.root, db);
  try {
    await assertLostOnce(second.engine, spawned.workerId, "load_unsupported");
    let log = "";
    try {
      log = readFileSync(logFile, "utf8");
    } catch {
      log = "";
    }
    expect(log).not.toContain("load-request");
  } finally {
    await second.engine.close();
    await second.store.close();
  }
}

async function readWorker(engine: Engine, workerId: string): Promise<{ events: Array<{ summary: string }> }> {
  const cli = await engine.read(workerId);
  const router = await engine.tools.read(workerId);
  expect(router).toEqual(cli);
  return cli as { events: Array<{ summary: string }> };
}

function postLoadEvent(event: TigerEvent): boolean {
  return event.type === "worker.update" && event.payload.sessionUpdate === "available_commands_update";
}

async function waitForPostLoad(engine: Engine, workerId: string, count: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    const found = (await engine.events()).filter((event) => event.workerId === workerId && postLoadEvent(event)).length;
    if (found >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`post-load update count did not reach ${count}`);
}

function replayEvent(event: TigerEvent): boolean {
  const text = typeof event.payload.text === "string" ? event.payload.text : "";
  const kind = typeof event.payload.sessionUpdate === "string" ? event.payload.sessionUpdate : "";
  return text.startsWith("REPLAY_") || kind === "usage_update" || kind === "user_message_chunk" || kind === "agent_thought_chunk";
}

async function flushHooks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
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
  const stored = await engine.store.getSession(workerId);
  expect(stored?.state).toBe("lost");
  const lost = (await engine.events()).filter((event) => event.type === "worker.lost" && event.workerId === workerId);
  expect(lost).toHaveLength(1);
  expect(lost[0]?.payload.reason).toBe(reason);
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

async function startNamedEngine(name: string, runtime: RuntimeConfig, workspaceRoot: string, db?: string, autoStart = true) {
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
  if (autoStart) await engine.start();
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
