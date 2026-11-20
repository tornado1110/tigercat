import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { DurableDeliveryService } from "../../src/durable-delivery.js";
import { SqliteStore } from "../../src/store.js";

describe("durable delivery outbox", () => {
  it("dedupes the same event and keeps destinations independent", async () => {
    const store = SqliteStore.open(":memory:");
    const clock = new FakeClock(100);
    const sent: string[] = [];
    const service = new DurableDeliveryService(store, {
      send: async ({ target }) => {
        sent.push(target.session);
        return { disposition: "delivered", reason: "ok" };
      },
    }, { clock });
    const first = await service.enqueue({ eventId: "evt-1", workerId: "w", text: "hello", target: { session: "a" } });
    const duplicate = await service.enqueue({ eventId: "evt-1", workerId: "w", text: "changed", target: { session: "a" } });
    await service.enqueue({ eventId: "evt-1", workerId: "w", text: "hello", target: { session: "b" } });
    expect(duplicate.text).toBe(first.text);
    await service.pump();
    expect(sent.sort()).toEqual(["a", "b"]);
    expect((await service.snapshot()).every((row) => row.status === "delivered")).toBe(true);
    await store.close();
  });

  it("retries only a proven pre-dispatch failure with bounded attempts", async () => {
    const store = SqliteStore.open(":memory:");
    const clock = new FakeClock(0);
    let calls = 0;
    const service = new DurableDeliveryService(store, {
      send: async () => {
        calls += 1;
        return { disposition: "not_sent", reason: "socket unavailable" };
      },
    }, { clock, maxAttempts: 2, retryBaseMs: 10 });
    await service.enqueue({ eventId: "evt", workerId: "w", text: "x", target: { session: "a" } });
    await service.pump();
    expect(calls).toBe(1);
    expect((await service.snapshot())[0].status).toBe("retrying");
    clock.advance(10);
    await service.pump();
    expect(calls).toBe(2);
    expect((await service.snapshot())[0].status).toBe("failed");
    await store.close();
  });

  it("persists unknown side effects and does not resend after restart", async () => {
    const store = SqliteStore.open(":memory:");
    const clock = new FakeClock(0);
    let calls = 0;
    const service = new DurableDeliveryService(store, {
      send: async () => {
        calls += 1;
        return { disposition: "unknown", reason: "sender disconnected after write" };
      },
    }, { clock });
    await service.enqueue({ eventId: "evt", workerId: "w", text: "secret already redacted", target: { session: "a" } });
    await service.pump();
    expect(calls).toBe(1);
    expect((await service.snapshot())[0].status).toBe("uncertain");
    const restarted = new DurableDeliveryService(store, {
      send: async () => { calls += 1; return { disposition: "delivered", reason: "unexpected" }; },
    }, { clock });
    await restarted.start();
    await restarted.pump();
    expect(calls).toBe(1);
    expect((await restarted.snapshot())[0].text).toBe("secret already redacted");
    expect(await restarted.reconcile("evt", (await restarted.snapshot())[0].destinationId, "delivered")).toBe(true);
    expect((await restarted.snapshot())[0].status).toBe("delivered");
    await store.close();
  });

  it("turns an inflight row into uncertain on restart", async () => {
    const store = SqliteStore.open(":memory:");
    const clock = new FakeClock(50);
    await store.putDelivery({ eventId: "evt", destinationId: "dst", workerId: "w", text: "x", target: {}, createdAt: 0 });
    expect(await store.claimDelivery("evt", "dst", clock.now())).toBeDefined();
    const recovered = await store.recoverInflightDeliveries(clock.now());
    expect(recovered).toBe(1);
    expect((await store.getDelivery("evt", "dst"))?.status).toBe("uncertain");
    await store.close();
  });

  it("recovers a route binding after restart and atomically consumes it once", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "tigercat-binding-"));
    const db = path.join(root, "state.sqlite");
    const target = { CC_PROJECT: "saved-project", CC_SESSION_KEY: "saved-session", TIGERCAT_CC_CONNECT_BIN: "stub" };
    const first = SqliteStore.open(db);
    await first.putDeliveryBinding({ workerId: "worker", destinationId: "dst", target, baselineSeq: 3, createdAt: 1 });
    await first.close();

    const restarted = SqliteStore.open(db);
    const restored = await restarted.listDeliveryBindings("worker");
    expect(restored).toHaveLength(1);
    expect(restored[0].target).toEqual(target);
    const claimed = await restarted.claimDeliveryBinding("worker", 4);
    expect(claimed?.target).toEqual(target);
    expect(await restarted.claimDeliveryBinding("worker", 4)).toBeUndefined();

    await restarted.putDeliveryBinding({ workerId: "worker", destinationId: "dst", target, baselineSeq: 3, createdAt: 2 });
    const atomicallyStored = await restarted.claimDeliveryBindingAndPut({
      workerId: "worker",
      eventSeq: 4,
      eventId: "event-atomic",
      text: "atomic result",
      createdAt: 3,
    });
    expect(atomicallyStored?.delivery.target).toEqual(target);
    expect(await restarted.claimDeliveryBinding("worker", 4)).toBeUndefined();

    const sent: Array<{ target: Record<string, string>; text: string }> = [];
    const service = new DurableDeliveryService(restarted, {
      send: async ({ target: route, text }) => {
        sent.push({ target: route, text });
        return { disposition: "delivered", reason: "ok" };
      },
    });
    await service.enqueue({ eventId: "event-after-restart", workerId: "worker", text: "saved result", target: claimed!.target, destinationId: claimed!.destinationId });
    await service.pump();
    expect(sent.map((entry) => entry.text).sort()).toEqual(["atomic result", "saved result"]);
    expect(sent.every((entry) => JSON.stringify(entry.target) === JSON.stringify(target))).toBe(true);
    await restarted.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("claims multiple destinations for one Worker event in order", async () => {
    const store = SqliteStore.open(":memory:");
    await store.putDeliveryBinding({ workerId: "worker", destinationId: "a", target: { session: "a" }, baselineSeq: 0, createdAt: 1 });
    await store.putDeliveryBinding({ workerId: "worker", destinationId: "b", target: { session: "b" }, baselineSeq: 0, createdAt: 2 });
    const first = await store.claimDeliveryBinding("worker", 1);
    const second = await store.claimDeliveryBinding("worker", 1);
    expect([first?.destinationId, second?.destinationId]).toEqual(["a", "b"]);
    expect(await store.claimDeliveryBinding("worker", 1)).toBeUndefined();
    await store.close();
  });

  it("keeps same-destination concurrent route intents distinct", async () => {
    const store = SqliteStore.open(":memory:");
    const target = { session: "same" };
    const first = await store.putDeliveryBinding({ workerId: "worker", destinationId: "dst", target, baselineSeq: 0, createdAt: 1 });
    const second = await store.putDeliveryBinding({ workerId: "worker", destinationId: "dst", target, baselineSeq: 0, createdAt: 2 });
    expect(second.bindingId).not.toBe(first.bindingId);
    expect(await store.listDeliveryBindings("worker")).toHaveLength(2);
    await store.close();
  });

  it("migrates the pre-binding-id schema without losing route targets", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "tigercat-binding-migrate-"));
    const db = path.join(root, "state.sqlite");
    const raw = new DatabaseSync(db);
    raw.exec(`CREATE TABLE delivery_bindings (
      worker_id TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      target TEXT NOT NULL,
      baseline_seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (worker_id, destination_id, baseline_seq)
    );
    INSERT INTO delivery_bindings VALUES ('worker', 'dst', '{"session":"saved"}', 4, 10);`);
    raw.close();
    const store = SqliteStore.open(db);
    const rows = await store.listDeliveryBindings("worker");
    expect(rows).toHaveLength(1);
    expect(rows[0].bindingId).toMatch(/^bind_/);
    expect(rows[0].target).toEqual({ session: "saved" });
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });
});

