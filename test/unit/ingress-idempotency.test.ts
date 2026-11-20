import { rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../../src/engine.js";
import { FakeTimeRuntimeFactory } from "../../src/runtime.js";
import { SqliteStore } from "../../src/store.js";
import type { TriggerInput } from "../../src/types.js";
import { startHarness } from "../harness/engine.js";

type Harness = Awaited<ReturnType<typeof startHarness>>;
const harnesses = new Set<Harness>();
const roots = new Set<string>();

async function harness(options?: Parameters<typeof startHarness>[0]): Promise<Harness> {
  const started = await startHarness(options);
  harnesses.add(started);
  roots.add(started.root);
  return started;
}

async function close(started: Harness): Promise<void> {
  if (!harnesses.delete(started)) return;
  await started.engine.close();
  await started.store.close();
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const started of harnesses) await close(started);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

const message: TriggerInput = {
  id: "external-message-1",
  source: "feishu",
  thread: "feishu:eng:ingress",
  author: "alice",
  text: "Please fix the build",
  timestamp: 1,
};

describe("external trigger identity", () => {
  it("returns the first receipt after subscriptions change, without spawning twice", async () => {
    const { engine, store } = await harness();
    const first = await engine.ingest(message);
    await engine.settle();
    expect((await engine.workers()).length).toBe(1);

    const replay = await engine.ingest(message);
    await engine.settle();
    expect(replay).toEqual(first);
    expect(await engine.workers()).toHaveLength(1);
    expect(await store.listTriggers(first.threadId)).toHaveLength(1);
    expect(await engine.routerDecisionCount()).toBe(1);
    expect((await engine.events()).filter((event) => event.type === "trigger.ingested")).toHaveLength(1);
  });

  it("coalesces concurrent duplicate deliveries", async () => {
    const { engine, store } = await harness();
    const receipts = await Promise.all(Array.from({ length: 20 }, () => engine.ingest({ ...message })));
    await engine.settle();
    expect(receipts.every((receipt) => receipt.triggerId === receipts[0].triggerId)).toBe(true);
    expect(await engine.workers()).toHaveLength(1);
    expect(await store.listTriggers(receipts[0].threadId)).toHaveLength(1);
    expect(await engine.routerDecisionCount()).toBe(1);
  });

  it("does not repeat a stop or its follow-up delivery", async () => {
    const { engine } = await harness();
    const worker = await engine.spawn({ runtime: "worker", task: "work", threads: [message.thread] });
    await engine.settle();
    const interrupt = vi.spyOn(engine, "interrupt");
    const stop = { ...message, text: "stop, do another task instead" };
    const first = await engine.ingest(stop);
    const duplicate = await engine.ingest(stop);
    expect(first.interrupt).toBe(true);
    expect(duplicate).toEqual(first);
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(worker.workerId);
    expect((await engine.events()).filter((event) => event.type === "trigger.delivered")).toHaveLength(1);
  });

  it("does not emit duplicate events for ignored messages", async () => {
    const { engine } = await harness();
    const chatter = { ...message, text: "morning" };
    const first = await engine.ingest(chatter);
    const second = await engine.ingest(chatter);
    expect(first.action).toBe("ignore");
    expect(second).toEqual(first);
    expect((await engine.events()).map((event) => event.type)).toEqual(["trigger.ingested", "trigger.ignored"]);
  });

  it.each([
    { thread: "feishu:eng:other" },
    { author: "bob" },
    { text: "changed content" },
    { timestamp: 2 },
    { kind: "pr.comment" },
    { isBot: true },
    { replyTo: "another-message" },
  ])("rejects identity reuse when content changes: %j", async (change) => {
    const { engine } = await harness();
    await engine.ingest({ ...message, text: "morning" });
    await expect(engine.ingest({ ...message, text: "morning", ...change })).rejects.toMatchObject({ code: "ingest_identity_conflict" });
    expect((await engine.events()).filter((event) => event.type === "trigger.ingested")).toHaveLength(1);
  });

  it("rejects conflicting content while the original delivery is in flight", async () => {
    const { engine } = await harness();
    const original = engine.ingest(message);
    await expect(engine.ingest({ ...message, text: "Please remove all files" })).rejects.toMatchObject({ code: "ingest_identity_conflict" });
    await original;
    await engine.settle();
    expect(await engine.workers()).toHaveLength(1);
  });

  it("treats explicit protocol defaults as the same content", async () => {
    const { engine } = await harness();
    const original = { ...message, text: "morning" };
    const first = await engine.ingest(original);
    expect(await engine.ingest({ ...original, kind: "im.message", isBot: false, replyTo: null })).toEqual(first);
  });

  it("scopes external identities by source", async () => {
    const { engine, store } = await harness();
    const receipts = await Promise.all([
      engine.ingest({ ...message, text: "morning" }),
      engine.ingest({ ...message, source: "github", text: "morning" }),
    ]);
    expect(receipts[0].triggerId).not.toBe(receipts[1].triggerId);
    expect(await store.listTriggers(receipts[0].threadId)).toHaveLength(2);
  });

  it("keeps submissions without an external ID independent", async () => {
    const { engine, store } = await harness();
    const input = { ...message, id: undefined, text: "morning" };
    const receipts = await Promise.all([engine.ingest(input), engine.ingest(input)]);
    expect(receipts[0].triggerId).not.toBe(receipts[1].triggerId);
    expect(await store.listTriggers(receipts[0].threadId)).toHaveLength(2);
  });

  it("rejects an empty external ID instead of deduplicating unrelated messages", async () => {
    const { engine } = await harness();
    await expect(engine.ingest({ ...message, id: "" })).rejects.toMatchObject({ code: "invalid_args" });
    expect(await engine.events()).toEqual([]);
  });

  it("replays a completed receipt from SQLite after restart", async () => {
    const initial = await harness();
    const db = path.join(initial.root, "restart.sqlite");
    await close(initial);
    const firstProcess = await harness({ root: initial.root, db });
    const first = await firstProcess.engine.ingest(message);
    await firstProcess.engine.settle();
    await close(firstProcess);

    const restarted = await harness({ root: initial.root, db });
    expect(await restarted.engine.ingest(message)).toEqual(first);
    await restarted.engine.settle();
    expect(await restarted.engine.workers()).toHaveLength(1);
    expect(await restarted.engine.routerDecisionCount()).toBe(1);
    expect((await restarted.engine.events()).filter((event) => event.type === "trigger.ingested")).toHaveLength(1);
  });

  it("does not blindly replay a dispatch that failed after its identity was claimed", async () => {
    const { engine, store } = await harness();
    const enqueue = vi.spyOn(store, "enqueueRouter").mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(engine.ingest(message)).rejects.toThrow("queue unavailable");
    await expect(engine.ingest(message)).rejects.toMatchObject({ code: "ingest_incomplete" });
    await expect(engine.ingest({ ...message, text: "different" })).rejects.toMatchObject({ code: "ingest_identity_conflict" });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((await engine.events()).filter((event) => event.type === "trigger.ingested")).toHaveLength(1);
  });

  it("fences concurrent claims through separate SQLite connections", async () => {
    const initial = await harness();
    const db = path.join(initial.root, "claims.sqlite");
    await close(initial);
    const owner = await harness({ root: initial.root, db });
    const otherStore = SqliteStore.open(db);
    const other = new Engine({ store: otherStore, clock: owner.clock, config: owner.engine.config, factory: new FakeTimeRuntimeFactory(owner.clock, 1000), workspaceRoot: owner.root });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const inserting = new Promise<void>((resolve) => { entered = resolve; });
    const insert = owner.store.insertTrigger.bind(owner.store);
    vi.spyOn(owner.store, "insertTrigger").mockImplementation(async (trigger) => {
      entered();
      await blocked;
      await insert(trigger);
    });
    const chatter = { ...message, text: "morning" };
    const original = owner.engine.ingest(chatter);
    try {
      await inserting;
      await expect(other.ingest(chatter)).rejects.toMatchObject({ code: "ingest_incomplete" });
      release();
      const receipt = await original;
      expect(await other.ingest(chatter)).toEqual(receipt);
      expect(await owner.store.listTriggers(receipt.threadId)).toHaveLength(1);
    } finally {
      release();
      await original;
      await other.close();
      await otherStore.close();
    }
  });

  it("preserves legacy event identities without inventing safe replay receipts", async () => {
    const initial = await harness();
    const db = path.join(initial.root, "legacy.sqlite");
    await close(initial);
    const legacy = await harness({ root: initial.root, db });
    const thread = await legacy.store.upsertThread(message.thread, message.source, 1);
    await legacy.store.insertTrigger({ ...message, id: "trg_legacy", externalId: message.id!, threadId: thread.id, kind: "im.message", isBot: false, replyTo: null, action: "respond", rule: "explicit-work", interrupt: false, createdAt: 1 });
    await close(legacy);
    const database = new DatabaseSync(db);
    database.prepare("DELETE FROM meta WHERE key = 'ingress_receipts_migrated'").run();
    database.close();

    const upgraded = await harness({ root: initial.root, db });
    await expect(upgraded.engine.ingest(message)).rejects.toMatchObject({ code: "ingest_incomplete" });
    await expect(upgraded.engine.ingest({ ...message, text: "changed" })).rejects.toMatchObject({ code: "ingest_identity_conflict" });
    expect(await upgraded.store.listTriggers(thread.id)).toHaveLength(1);
    expect(await upgraded.engine.workers()).toHaveLength(0);
  });
});
