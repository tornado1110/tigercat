import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { defaultConfig } from "../../src/config.js";
import { Engine } from "../../src/engine.js";
import type { LaunchContext, PromptResult, RuntimeFactory, RuntimeHandle } from "../../src/runtime.js";
import { SqliteStore } from "../../src/store.js";
import type { RuntimeConfig } from "../../src/types.js";
import * as worktree from "../../src/worktree.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

class ControlledHandle implements RuntimeHandle {
  readonly pid = undefined;
  readonly acpSessionId = "controlled-session";
  readonly prompts: string[] = [];
  private readonly pending: Array<ReturnType<typeof deferred<PromptResult>>> = [];
  active = 0;
  maximumActive = 0;
  kills = 0;
  cancels = 0;
  cancelAcknowledgement: Promise<void> = Promise.resolve();

  prompt(text: string): Promise<PromptResult> {
    this.prompts.push(text);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    const result = deferred<PromptResult>();
    this.pending.push(result);
    return result.promise;
  }

  complete(stopReason = "end_turn", text = "done"): void {
    const result = this.pending.shift();
    if (!result) throw new Error("No native prompt is pending");
    this.active -= 1;
    result.resolve({ stopReason, text, awaitingInput: false });
  }

  async cancel(): Promise<void> {
    this.cancels += 1;
    if (this.pending.length) this.complete("cancelled", "");
    await this.cancelAcknowledgement;
  }

  async kill(): Promise<void> {
    this.kills += 1;
    while (this.pending.length) this.complete("cancelled", "");
  }
}

class ControlledFactory implements RuntimeFactory {
  readonly launchStarted = deferred<void>();
  readonly launching = deferred<RuntimeHandle>();
  readonly handle = new ControlledHandle();
  context?: LaunchContext;

  constructor(delayedLaunch: boolean) {
    if (!delayedLaunch) this.launching.resolve(this.handle);
  }

  async launch(_runtime: RuntimeConfig, context: LaunchContext): Promise<RuntimeHandle> {
    this.context = context;
    this.launchStarted.resolve();
    return this.launching.promise;
  }
}

const fixtures: Array<{ engine: Engine; store: SqliteStore; root: string }> = [];
const closedStores = new Set<SqliteStore>();

async function fixture(delayedLaunch = false, spawnInitial = true) {
  const root = mkdtempSync(path.join(tmpdir(), "tigercat-races-"));
  const clock = new FakeClock();
  const store = SqliteStore.open(":memory:");
  const config = defaultConfig();
  config.defaultWorkerRuntime = "worker";
  config.runtimes = [{ name: "worker", command: "controlled", args: [], env: { WORKER_API_KEY: "private-test-api-key" }, tags: [], description: "test", permission: "ask" }];
  const factory = new ControlledFactory(delayedLaunch);
  const engine = new Engine({ store, clock, config, factory, workspaceRoot: root });
  fixtures.push({ engine, store, root });
  await engine.start();
  const workerId = spawnInitial ? (await engine.spawn({ runtime: "worker", task: "initial task", threads: ["feishu:eng:races"] })).workerId : "";
  if (spawnInitial) await factory.launchStarted.promise;
  return { engine, store, clock, factory, handle: factory.handle, workerId, root };
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Controlled runtime did not reach its expected boundary");
}

afterEach(async () => {
  vi.restoreAllMocks();
  const stores = new Set<SqliteStore>();
  for (const { engine, store, root } of fixtures.splice(0)) {
    await engine.close();
    if (!stores.has(store) && !closedStores.has(store)) {
      await store.close();
      stores.add(store);
    }
    rmSync(root, { recursive: true, force: true });
  }
  closedStores.clear();
});

describe("Worker launch and prompt races", () => {
  it("admits only one concurrent spawn when maxConcurrency is one", async () => {
    const { engine, store, handle } = await fixture(false, false);
    engine.config.maxConcurrency = 1;
    const results = await Promise.allSettled(Array.from({ length: 3 }, (_, index) => engine.spawn({ runtime: "worker", task: `task ${index}` })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(2);
    expect(rejected.every((result) => result.reason.code === "max_concurrency")).toBe(true);
    await engine.settle();
    expect(await store.listSessions("worker")).toHaveLength(1);
    expect(handle.prompts).toHaveLength(1);
  });

  it("resumes an interrupted Worker with its existing worktree and ID", async () => {
    const first = await fixture();
    await until(() => first.handle.prompts.length === 1);
    const cwd = (await first.store.getSession(first.workerId))!.cwd;
    await first.engine.close();
    const replacementFactory = new ControlledFactory(false);
    const replacement = new Engine({ store: first.store, clock: first.clock, config: first.engine.config, factory: replacementFactory, workspaceRoot: path.dirname(cwd!) });
    fixtures.push({ engine: replacement, store: first.store, root: path.dirname(cwd!) });
    await replacement.start();
    expect((await first.store.getSession(first.workerId))?.state).toBe("interrupted");
    const resumed = await replacement.resume(first.workerId, "new recovery input");
    expect(resumed.workerId).toBe(first.workerId);
    expect((await first.store.getSession(first.workerId))?.cwd).toBe(cwd);
    await replacement.settle();
    await until(() => replacementFactory.handle.prompts.length === 1);
    expect(replacementFactory.handle.prompts).toEqual(["new recovery input"]);
    await expect(replacement.resume(first.workerId, "duplicate recovery")).rejects.toMatchObject({ code: "not_resumable" });
  });

  it("enforces concurrency and shutdown while resuming", async () => {
    const first = await fixture();
    await until(() => first.handle.prompts.length === 1);
    await first.engine.close();
    const replacementFactory = new ControlledFactory(false);
    const replacement = new Engine({ store: first.store, clock: first.clock, config: first.engine.config, factory: replacementFactory, workspaceRoot: first.root });
    fixtures.push({ engine: replacement, store: first.store, root: first.root });
    await replacement.start();
    replacement.config.maxConcurrency = 0;
    await expect(replacement.resume(first.workerId, "recovery")).rejects.toMatchObject({ code: "max_concurrency" });
    await replacement.close();
    await expect(replacement.resume(first.workerId, "after close")).rejects.toMatchObject({ code: "engine_closed" });
  });

  it("releases spawn admission after persistence fails", async () => {
    const { engine, store, handle } = await fixture(false, false);
    engine.config.maxConcurrency = 1;
    vi.spyOn(store, "insertSession").mockRejectedValueOnce(new Error("session insert unavailable"));
    const failed = engine.spawn({ runtime: "worker", task: "failed admission" });
    const next = engine.spawn({ runtime: "worker", task: "next admission" });
    await expect(failed).rejects.toThrow("session insert unavailable");
    expect((await next).status).toBe("started");
    await engine.settle();
    expect(await store.listSessions("worker")).toHaveLength(1);
    expect(handle.prompts).toEqual(["next admission"]);
  });

  it("rejects active and queued admission when shutdown closes the Store during workspace preparation", async () => {
    const { engine, store } = await fixture(false, false);
    const prepared = deferred<void>();
    const release = deferred<void>();
    const prepare = worktree.prepareWorkspace;
    vi.spyOn(worktree, "prepareWorkspace").mockImplementationOnce(async (base, id) => {
      const workspace = await prepare(base, id);
      prepared.resolve();
      await release.promise;
      return workspace;
    });
    const insert = vi.spyOn(store, "insertSession");
    const spawning = engine.spawn({ runtime: "worker", task: "preparing workspace" });
    const queued = engine.spawn({ runtime: "worker", task: "waiting for admission" });
    const results = Promise.allSettled([spawning, queued]);
    try {
      await prepared.promise;
      await engine.close();
      await store.close();
      closedStores.add(store);
      release.resolve();
      expect((await results).every((result) => result.status === "rejected" && result.reason.code === "engine_closed")).toBe(true);
      expect(insert).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
  });

  it("skips an initial task stopped during launch and preserves follow-up routing", async () => {
    const { engine, store, factory, handle, workerId } = await fixture(true);
    expect((await store.getSession(workerId))?.state).toBe("starting");
    expect(await engine.interrupt(workerId)).toEqual({ status: "cancelled" });
    factory.launching.resolve(handle);
    await engine.settle();
    await until(async () => (await store.getSession(workerId))?.state === "idle");
    expect(handle.prompts).toEqual([]);
    expect(handle.kills).toBe(0);
    expect(await store.subscriptionsForWorker(workerId)).toHaveLength(1);
    expect((await engine.events()).find((event) => event.type === "worker.turn_end")?.payload.stopReason).toBe("cancelled");

    await engine.send(workerId, "new task after stop");
    await until(() => handle.prompts.length === 1);
    expect(handle.prompts).toEqual(["new task after stop"]);
  });

  it("kills a handle returned after the Worker was already killed", async () => {
    const { engine, store, factory, handle, workerId } = await fixture(true);
    await engine.kill(workerId);
    expect((await store.getSession(workerId))?.state).toBe("killed");
    factory.launching.resolve(handle);
    await engine.settle();
    expect(handle.prompts).toEqual([]);
    expect(handle.kills).toBe(1);
    expect((await store.getSession(workerId))?.state).toBe("killed");
    expect(await store.subscriptionsForWorker(workerId)).toEqual([]);
    expect((await engine.events()).filter((event) => event.type === "worker.error")).toEqual([]);
  });

  it("reaps a late handle even after shutdown has closed the Store", async () => {
    const { engine, store, factory, handle } = await fixture(true);
    await engine.close();
    await store.close();
    closedStores.add(store);
    factory.launching.resolve(handle);
    await until(() => handle.kills === 1);
    expect(handle.prompts).toEqual([]);
  });

  it("serializes concurrent follow-ups on one native session", async () => {
    const { engine, store, handle, workerId } = await fixture();
    await until(() => handle.prompts.length === 1);
    handle.complete();
    await until(async () => (await store.getSession(workerId))?.state === "idle");
    await engine.settle();
    await Promise.all([
      engine.send(workerId, "first follow-up"),
      engine.send(workerId, "second follow-up"),
    ]);
    await until(() => handle.prompts.length === 2);
    // Let both pump callers cross their storage awaits while the native
    // prompt is blocked. The second input must remain queued.
    for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
    expect(handle.active).toBe(1);
    expect(handle.maximumActive).toBe(1);
    expect(handle.prompts).toHaveLength(2);

    handle.complete();
    await until(() => handle.prompts.length === 3);
    expect(handle.prompts.slice(1)).toEqual(["first follow-up", "second follow-up"]);
    expect(handle.maximumActive).toBe(1);
    handle.complete();
    await until(async () => (await store.getSession(workerId))?.state === "idle");
    expect((await engine.events()).filter((event) => event.type === "worker.turn_end")).toHaveLength(3);
  });

  it("does not let a late cancel acknowledgement arm a timer against the next turn", async () => {
    const { engine, store, clock, handle, workerId } = await fixture();
    await until(() => handle.prompts.length === 1);
    const acknowledged = deferred<void>();
    handle.cancelAcknowledgement = acknowledged.promise;
    const stopping = engine.interrupt(workerId);
    await until(async () => (await store.getSession(workerId))?.state === "idle");
    await engine.send(workerId, "continue with another task");
    await until(() => handle.prompts.length === 2);
    acknowledged.resolve();
    await stopping;
    clock.advance(engine.config.cancelGraceMs);
    await engine.settle();
    expect(handle.kills).toBe(0);
    expect(handle.active).toBe(1);
    expect((await store.getSession(workerId))?.state).toBe("running");
  });

  it("keeps an enqueue wakeup that races the pump's empty inbox read", async () => {
    const { engine, store, handle, workerId } = await fixture();
    await until(() => handle.prompts.length === 1);
    const read = deferred<void>();
    const release = deferred<void>();
    const claim = store.claimInbox.bind(store);
    vi.spyOn(store, "claimInbox").mockImplementationOnce(async (id) => {
      const empty = await claim(id);
      expect(empty).toBeUndefined();
      read.resolve();
      await release.promise;
      return empty;
    });
    handle.complete();
    try {
      await read.promise;
      await engine.send(workerId, "arrived during the empty read");
      release.resolve();
      await until(() => handle.prompts.length === 2);
      expect(handle.prompts[1]).toBe("arrived during the empty read");
      expect(handle.maximumActive).toBe(1);
    } finally {
      release.resolve();
    }
  });

  it("lets an accepted stop override a late native success", async () => {
    const { engine, handle, workerId } = await fixture();
    await until(() => handle.prompts.length === 1);
    vi.spyOn(handle, "cancel").mockResolvedValue();
    await engine.interrupt(workerId);
    handle.complete("end_turn", "late success after stop");
    await until(async () => (await engine.events()).some((event) => event.type === "worker.turn_end"));
    const ended = (await engine.events()).find((event) => event.type === "worker.turn_end")!;
    expect(ended.payload.stopReason).toBe("cancelled");
    expect(ended.payload.text).toBe("");
    expect(ended.payload.summary).not.toContain("late success after stop");
  });

  it("settles pending waits and removes their timers before the Store closes", async () => {
    const { engine, store, clock, handle, workerId } = await fixture();
    await until(() => handle.prompts.length === 1);
    const baseline = clock.pending();
    const waiting = engine.wait([workerId], "all", 30000);
    await until(() => clock.pending() > baseline);
    await engine.close();
    await store.close();
    closedStores.add(store);
    expect(await waiting).toEqual({ status: "closed", done: [] });
    expect(clock.pending()).toBe(0);
    clock.advance(30000);
    expect(await engine.wait([workerId], "all", 30000)).toEqual({ status: "closed", done: [] });
  });

  it("does not register a wait timer if shutdown races its initial snapshot", async () => {
    const { engine, store, clock, handle, workerId } = await fixture();
    await until(() => handle.prompts.length === 1);
    const waiting = engine.wait([workerId, workerId], "all", 30000);
    await engine.close();
    await store.close();
    closedStores.add(store);
    expect(await waiting).toEqual({ status: "closed", done: [] });
    expect(clock.pending()).toBe(0);
  });

  it("ignores late native updates after shutdown closes the Store", async () => {
    const { engine, store, clock, factory, handle } = await fixture();
    await until(() => handle.prompts.length === 1);
    await engine.close();
    await store.close();
    closedStores.add(store);
    const append = vi.spyOn(store, "appendEvent");
    const observe = vi.spyOn(engine, "observePath");
    factory.context!.onUpdate({ sessionUpdate: "agent_message_chunk", text: "late native output", paths: ["late.txt"] });
    await Promise.resolve();
    expect(clock.pending()).toBe(0);
    expect(append).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it("ignores updates from a killed Worker without recreating its stall timer", async () => {
    const { engine, store, clock, factory, handle, workerId } = await fixture();
    await until(() => handle.prompts.length === 1);
    await engine.kill(workerId);
    const append = vi.spyOn(store, "appendEvent");
    factory.context!.onUpdate({ sessionUpdate: "agent_message_chunk", text: "output after kill" });
    await Promise.resolve();
    expect(clock.pending()).toBe(0);
    expect(append).not.toHaveBeenCalled();
  });

  it("does not let an in-flight turn transition replace a kill", async () => {
    const { engine, store, handle, workerId } = await fixture();
    await until(() => handle.prompts.length === 1);
    const readSession = store.getSession.bind(store);
    const release = deferred<void>();
    const reading = deferred<void>();
    let runningReads = 0;
    vi.spyOn(store, "getSession").mockImplementation(async (id) => {
      const session = await readSession(id);
      // The turn loads its current row, then yields before writing the next
      // state. Hold that loaded row so kill can commit first.
      if (id === workerId && session?.state === "running") {
        runningReads += 1;
        if (runningReads === 2) {
          reading.resolve();
          await release.promise;
          return session;
        }
      }
      return session;
    });
    handle.complete("end_turn", "finished the task");
    try {
      await reading.promise;
      await engine.kill(workerId);
      expect((await readSession(workerId))?.state).toBe("killed");
      release.resolve();
      await engine.settle();
      expect((await readSession(workerId))?.state).toBe("killed");
      expect(runningReads).toBeGreaterThanOrEqual(2);
    } finally {
      release.resolve();
    }
  });

  it("clears a kill request so a later resume can leave interrupted", async () => {
    const first = await fixture();
    await until(() => first.handle.prompts.length === 1);
    const cwd = (await first.store.getSession(first.workerId))!.cwd;
    await first.engine.close();
    const replacementFactory = new ControlledFactory(false);
    const replacement = new Engine({
      store: first.store,
      clock: first.clock,
      config: first.engine.config,
      factory: replacementFactory,
      workspaceRoot: path.dirname(cwd!),
    });
    fixtures.push({ engine: replacement, store: first.store, root: path.dirname(cwd!) });
    await replacement.start();
    expect((await first.store.getSession(first.workerId))?.state).toBe("interrupted");
    vi.spyOn(first.store, "updateSession").mockImplementationOnce(() => {
      throw new Error("killed write failed");
    });
    await expect(replacement.kill(first.workerId)).rejects.toThrow("killed write failed");
    expect((await first.store.getSession(first.workerId))?.state).toBe("interrupted");
    vi.mocked(first.store.updateSession).mockRestore();

    const resumed = await replacement.resume(first.workerId, "continue after the abandoned kill");
    expect(resumed.workerId).toBe(first.workerId);
    await until(async () => (await first.store.getSession(first.workerId))?.state === "running");
    expect(replacementFactory.handle.prompts).toEqual(["continue after the abandoned kill"]);
    expect((await first.store.getSession(first.workerId))?.state).toBe("running");
  });
});

describe("Worker result recall", () => {
  it("retains full redacted text behind a budgeted event summary", async () => {
    const { engine, handle } = await fixture();
    await until(() => handle.prompts.length === 1);
    const text = `private-test-api-key ${"result ".repeat(300)}the final detail`;
    handle.complete("end_turn", text);
    await until(async () => (await engine.events()).some((event) => event.type === "worker.turn_end"));
    const ended = (await engine.events()).find((event) => event.type === "worker.turn_end")!;
    const recalled = await engine.read(ended.id) as { payload: { text: string; summary: string } };
    expect(recalled.payload.text).toBe(text.replace("private-test-api-key", "[REDACTED]"));
    expect(recalled.payload.text).toContain("the final detail");
    expect(recalled.payload.summary).toContain("[spilled]");
    expect(recalled.payload.summary).not.toContain("the final detail");
    expect(JSON.stringify(recalled)).not.toContain("private-test-api-key");
  });
});
