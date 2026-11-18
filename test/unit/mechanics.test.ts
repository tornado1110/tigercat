import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { decidePermission } from "../../src/permissions.js";
import { SecretRegistry } from "../../src/redact.js";
import { assertTransition } from "../../src/state.js";
import { TigerError } from "../../src/errors.js";
import { startHarness } from "../harness/engine.js";

describe("permissions", () => {
  const options = [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ];

  it("ask never auto-allows", () => {
    expect(decidePermission("worker", "ask", { options, toolTitle: "tigercat.read", toolKind: "read" })).toEqual({
      type: "forward",
    });
  });

  it("denies shell and edit tools for the Router", () => {
    expect(
      decidePermission("router", "auto", { options, toolTitle: "bash", toolKind: "execute" }).type,
    ).not.toBe("forward");
    const decision = decidePermission("router", "auto", { options, toolTitle: "bash", toolKind: "execute" });
    expect(decision).toEqual({ type: "selected", optionId: "reject" });
  });
});

describe("state machine", () => {
  it("rejects an illegal transition", () => {
    expect(() => assertTransition("killed", "running")).toThrow(TigerError);
    expect(() => assertTransition("running", "idle")).not.toThrow();
  });
});

describe("events and read(since)", () => {
  it("is monotonic and does not skip or repeat", async () => {
    const harness = await startHarness({ durationMs: 1_000 });
    const spawned = await harness.engine.spawn({
      runtime: "worker",
      task: "count",
      threads: ["feishu:eng:cli"],
    });
    await harness.engine.settle();
    harness.clock.advance(1_000);
    await harness.engine.settle();
    const first = (await harness.engine.read(spawned.workerId, 0)) as { events: Array<{ seq: number }> };
    const seqs = first.events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const last = seqs[seqs.length - 1];
    const rest = (await harness.engine.read(spawned.workerId, last)) as { events: unknown[] };
    expect(rest.events).toEqual([]);
    const again = (await harness.engine.read(spawned.workerId, 0)) as { events: Array<{ seq: number }> };
    expect(again.events.map((event) => event.seq)).toEqual(seqs);
    await harness.engine.close();
    await harness.store.close();
  });
});

describe("stall timer", () => {
  it("fires worker.stalled from the fake clock", async () => {
    const clock = new FakeClock(0);
    const harness = await startHarness({ clock, durationMs: 60 * 60_000 });
    harness.engine.config.idleTimeoutMs = 10 * 60_000;
    const spawned = await harness.engine.spawn({
      runtime: "worker",
      task: "hang",
      threads: ["feishu:eng:cli"],
    });
    await harness.engine.settle();
    clock.advance(10 * 60_000);
    await harness.engine.settle();
    const events = await harness.engine.events();
    expect(events.some((event) => event.type === "worker.stalled" && event.workerId === spawned.workerId)).toBe(true);
    await harness.engine.close();
    await harness.store.close();
  });
});

describe("secrets and hooks", () => {
  it("redacts secret env values before they are stored", async () => {
    const secrets = new SecretRegistry();
    secrets.noteEnv({ API_KEY: "super-secret-value" });
    expect(JSON.stringify(secrets.redactValue({ task: "use super-secret-value" }))).not.toContain("super-secret-value");
  });

  it("a throwing hook does not block ingest", async () => {
    const harness = await startHarness();
    harness.engine.addHook(() => {
      throw new Error("hook failed");
    });
    const result = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "alice",
      text: "morning",
      timestamp: 1,
    });
    expect(result.action).toBe("ignore");
    await harness.engine.close();
    await harness.store.close();
  });
});

describe("double interrupt", () => {
  it("returns a typed error", async () => {
    const harness = await startHarness({ durationMs: 60 * 60_000 });
    const spawned = await harness.engine.spawn({
      runtime: "worker",
      task: "run",
      threads: ["feishu:eng:cli"],
    });
    await harness.engine.settle();
    const first = harness.engine.interrupt(spawned.workerId);
    await expect(harness.engine.interrupt(spawned.workerId)).rejects.toMatchObject({ code: "double_interrupt" });
    await first;
    await harness.engine.close();
    await harness.store.close();
  });
});
