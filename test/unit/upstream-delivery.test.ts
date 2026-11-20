import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.js";
import type { TigerEvent } from "../../src/types.js";
import { createWorkerResultRelay, deliverViaCcConnect, planCcConnectDelivery, type DeliveryOutcome, type WorkerDeliveryContext } from "../../src/upstream-delivery.js";
import { startHarness } from "../harness/engine.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Worker result delivery acknowledgements", () => {
  it("delivers every buffered result before a one-shot relay detaches", async () => {
    const source = deliverySource();
    const sent: string[] = [];
    const relay = createWorkerResultRelay(source, async (_text, context) => {
      sent.push(context.eventId);
      return { delivered: true, reason: "accepted" };
    }, { onOutcome: () => { throw new Error("observer failed"); } });
    relay.watch(["worker-a"]);
    source.emit(resultEvent("event-1"));
    source.emit(resultEvent("event-2"));
    relay.release();
    await flushDelivery();
    expect(sent).toEqual(["event-1", "event-2"]);
    expect(source.hooks.size).toBe(0);
    expect(relay.snapshot().map((entry) => entry.status)).toEqual(["delivered", "delivered"]);
  });

  it("keeps separate results from one Worker before release and watches later turns explicitly", async () => {
    const source = deliverySource();
    const sent: WorkerDeliveryContext[] = [];
    const relay = createWorkerResultRelay(source, async (_text, context) => {
      sent.push(context);
      return { delivered: true, reason: "accepted" };
    }, { persistent: true });
    relay.watch(["worker-a"]);
    source.emit(resultEvent("event-1"));
    source.emit(resultEvent("event-2"));
    source.emit(resultEvent("event-1"));
    expect(sent).toEqual([]);
    relay.release();
    await flushDelivery();
    source.emit(resultEvent("event-3"));
    await flushDelivery();
    expect(sent.map((entry) => entry.eventId)).toEqual(["event-1", "event-2", "event-3"]);
    expect(relay.snapshot().map((entry) => entry.status)).toEqual(["delivered", "delivered", "delivered"]);
    relay.stop();
    expect(source.hooks.size).toBe(0);
  });

  it("does not acknowledge an in-flight send or start duplicate sends", async () => {
    const source = deliverySource();
    let finish!: (outcome: DeliveryOutcome) => void;
    let attempts = 0;
    const relay = createWorkerResultRelay(source, async () => {
      attempts += 1;
      return new Promise((resolve) => { finish = resolve; });
    });
    relay.watch(["worker-a"]);
    relay.release();
    source.emit(resultEvent("event-1"));
    source.emit(resultEvent("event-1"));
    relay.release();
    expect(attempts).toBe(1);
    expect(relay.snapshot()[0]!.status).toBe("delivering");
    expect(source.hooks.size).toBe(1);
    finish({ delivered: true, reason: "accepted" });
    await flushDelivery();
    expect(relay.snapshot()[0]!.status).toBe("delivered");
    expect(source.hooks.size).toBe(0);
  });

  it("retries negative acknowledgements and concurrent failures independently with the same event ids", async () => {
    const source = deliverySource();
    const sent: WorkerDeliveryContext[] = [];
    const outcomes: string[] = [];
    const relay = createWorkerResultRelay(source, async (_text, context) => {
      sent.push(context);
      return { delivered: context.attempt > 1, reason: context.attempt > 1 ? "accepted" : "unavailable" };
    }, {
      maxAttempts: 3,
      retryBaseMs: 100,
      retryMaxMs: 200,
      onOutcome: (state) => { outcomes.push(`${state.eventId}:${state.status}`); },
    });
    relay.watch(["worker-a", "worker-b"]);
    relay.release();
    source.emit(resultEvent("event-1"));
    source.emit(resultEvent("event-2", "worker-b"));
    await flushDelivery();
    expect(relay.snapshot().map((entry) => entry.status)).toEqual(["retrying", "retrying"]);
    expect(source.hooks.size).toBe(1);
    source.clock.advance(99);
    expect(sent).toHaveLength(2);
    source.clock.advance(1);
    await flushDelivery();
    expect(sent).toEqual([
      { eventId: "event-1", workerId: "worker-a", attempt: 1 },
      { eventId: "event-2", workerId: "worker-b", attempt: 1 },
      { eventId: "event-1", workerId: "worker-a", attempt: 2 },
      { eventId: "event-2", workerId: "worker-b", attempt: 2 },
    ]);
    expect(outcomes).toEqual(["event-1:retrying", "event-2:retrying", "event-1:delivered", "event-2:delivered"]);
    expect(source.clock.pending()).toBe(0);
    expect(source.hooks.size).toBe(0);
  });

  it("bounds thrown-error retries, retains failure and permits an explicit retry", async () => {
    const source = deliverySource();
    let available = false;
    let attempts = 0;
    const relay = createWorkerResultRelay(source, async () => {
      attempts += 1;
      if (!available) throw new Error("secret=must-not-appear");
      return { delivered: true, reason: "accepted" };
    }, { maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 150 });
    relay.watch(["worker-a"]);
    relay.release();
    source.emit(resultEvent("event-1"));
    await flushDelivery();
    source.clock.advance(100);
    await flushDelivery();
    source.clock.advance(149);
    expect(attempts).toBe(2);
    source.clock.advance(1);
    await flushDelivery();
    source.clock.advance(60_000);
    expect(attempts).toBe(3);
    expect(relay.snapshot()[0]).toMatchObject({ status: "failed", attempt: 3, reason: "Delivery failed (Error)." });
    expect(JSON.stringify(relay.snapshot())).not.toContain("must-not-appear");
    available = true;
    expect(relay.retry("missing")).toBe(false);
    expect(relay.retry("event-1")).toBe(true);
    await flushDelivery();
    expect(relay.snapshot()[0]).toMatchObject({ status: "delivered", attempt: 4 });
    expect(relay.retry("event-1")).toBe(false);
  });

  it("clears retry timers when stopped and ignores hooks already queued by the engine", async () => {
    const source = deliverySource();
    let attempts = 0;
    const relay = createWorkerResultRelay(source, async () => {
      attempts += 1;
      return { delivered: false, reason: "unavailable" };
    });
    const queuedHook = [...source.hooks][0]!;
    relay.watch(["worker-a"]);
    relay.release();
    source.emit(resultEvent("event-1"));
    await flushDelivery();
    expect(source.clock.pending()).toBe(1);
    relay.stop();
    relay.stop();
    queuedHook(resultEvent("event-2"));
    source.clock.advance(60_000);
    await flushDelivery();
    expect(attempts).toBe(1);
    expect(source.hooks.size).toBe(0);
    expect(source.clock.pending()).toBe(0);
    expect(relay.snapshot()).toHaveLength(1);
    expect(relay.snapshot()[0]).toMatchObject({ status: "failed", reason: "unavailable", nextAttemptAt: undefined });
    expect(relay.retry("event-1")).toBe(false);
  });

  it("records an in-flight failure after stop without creating a retry", async () => {
    const source = deliverySource();
    let finish!: (outcome: DeliveryOutcome) => void;
    const relay = createWorkerResultRelay(source, async () => new Promise((resolve) => { finish = resolve; }));
    relay.watch(["worker-a"]);
    relay.release();
    source.emit(resultEvent("event-1"));
    relay.stop();
    finish({ delivered: false, reason: "disconnected" });
    await flushDelivery();
    expect(relay.snapshot()[0]).toMatchObject({ status: "failed", reason: "disconnected" });
    expect(source.clock.pending()).toBe(0);
  });
});

function deliverySource() {
  const clock = new FakeClock();
  const hooks = new Set<(event: TigerEvent) => void | Promise<void>>();
  return {
    clock,
    hooks,
    addHook(hook: (event: TigerEvent) => void | Promise<void>) {
      hooks.add(hook);
      return () => { hooks.delete(hook); };
    },
    emit(event: TigerEvent) {
      for (const hook of hooks) void hook(event);
    },
  };
}

function resultEvent(id: string, workerId = "worker-a"): TigerEvent {
  return { id, workerId, seq: 1, type: "worker.turn_end", payload: { summary: `result ${id}` }, createdAt: 0 };
}

async function flushDelivery(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

describe("cc-connect delivery after the ACP prompt returns", () => {
  it("does not spawn when CC_SESSION_KEY is unset", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tigercat-send-"));
    roots.push(dir);
    const marker = path.join(dir, "ran");
    const script = writeSender(dir);
    const env = { TIGERCAT_CC_CONNECT_BIN: script, MARKER: marker };
    expect(planCcConnectDelivery(env).ok).toBe(false);
    const outcome = await deliverViaCcConnect("worker result", env);
    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toContain("CC_SESSION_KEY");
    expect(() => readFileSync(marker, "utf8")).toThrow();
  });

  it("posts the worker text on stdin with send --stdin", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tigercat-send-"));
    roots.push(dir);
    const marker = path.join(dir, "ran.json");
    const script = writeSender(dir);
    const outcome = await deliverViaCcConnect("finished text", {
      CC_SESSION_KEY: "feishu:chat:user",
      CC_PROJECT: "demo",
      TIGERCAT_CC_CONNECT_BIN: script,
      MARKER: marker,
    });
    expect(outcome).toEqual({ delivered: true, reason: "cc-connect send exited 0." });
    const recorded = JSON.parse(readFileSync(marker, "utf8")) as {
      argv: string[];
      stdin: string;
      session: string;
    };
    expect(recorded.argv).toEqual(["send", "--stdin"]);
    expect(recorded.stdin).toBe("finished text");
    expect(recorded.session).toBe("set");
    expect(JSON.stringify(recorded)).not.toContain("feishu:chat:user");
  });

  it("reports a sender that exits before reading stdin as a failed delivery", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tigercat-send-"));
    roots.push(dir);
    const script = path.join(dir, "failed-sender.js");
    writeFileSync(script, "process.exit(1);\n");
    const outcome = await deliverViaCcConnect("x".repeat(2_000_000), {
      CC_SESSION_KEY: "feishu:chat:user",
      TIGERCAT_CC_CONNECT_BIN: script,
    });
    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toMatch(/stdin failed|exited 1/);
  });

  it("holds the result until the prompt is released, then a second thread can proceed", async () => {
    const harness = await startHarness({ durationMs: 60_000 });
    roots.push(harness.root);
    const first = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:other",
      author: "keith",
      text: "Please investigate the flaky CI job.",
      kind: "im.message",
      isBot: false,
      timestamp: 1_000,
    });
    await harness.engine.settle();
    expect(first.router).toBe(true);
    const firstWorker = (await harness.engine.workers())[0];
    expect(firstWorker).toBeDefined();
    const sent: string[] = [];
    const relay = createWorkerResultRelay(harness.engine, async (text) => {
      sent.push(text);
      return { delivered: true, reason: "test double" };
    });
    relay.watch([firstWorker!.id]);
    const second = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "keith",
      text: "Please add a --json flag",
      kind: "im.message",
      isBot: false,
      timestamp: 2_000,
    });
    await harness.engine.settle();
    expect(second.router).toBe(true);
    expect(sent).toEqual([]);
    harness.clock.advance(60_000);
    await harness.engine.settle();
    harness.clock.advance(0);
    expect(sent).toEqual([]);
    relay.release();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(firstWorker!.id);
    expect(sent[0]).toContain("done");
    relay.stop();
    await harness.engine.close();
    await harness.store.close();
  });
});

function writeSender(dir: string): string {
  const script = path.join(dir, "cc-connect.js");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  writeFileSync(process.env.MARKER, JSON.stringify({
    argv: process.argv.slice(2),
    stdin: Buffer.concat(chunks).toString(),
    session: process.env.CC_SESSION_KEY ? "set" : "unset",
  }));
});
`,
  );
  return script;
}
