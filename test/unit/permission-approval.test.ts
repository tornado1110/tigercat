import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { defaultConfig } from "../../src/config.js";
import { Engine, type PendingPermission } from "../../src/engine.js";
import type { LaunchContext, RuntimeFactory, RuntimeHandle } from "../../src/runtime.js";
import { SqliteStore } from "../../src/store.js";
import type { RuntimeConfig } from "../../src/types.js";

class ApprovalHandle implements RuntimeHandle {
  readonly pid = undefined;
  readonly acpSessionId = "approval-session";
  constructor(private readonly context: LaunchContext) {}
  async prompt(): Promise<{ stopReason: string; text: string; awaitingInput: boolean }> {
    const response = await this.context.onPermission({
      sessionId: "approval-session",
      toolCall: { toolCallId: "secret-call", title: "Run private command", kind: "execute", rawInput: { token: "should-not-leak" } },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject once", kind: "reject_once" },
      ],
    });
    return { stopReason: "end_turn", text: response.outcome.outcome === "selected" ? `selected ${response.outcome.optionId}` : "cancelled", awaitingInput: false };
  }
  async cancel(): Promise<void> { return undefined; }
  async kill(): Promise<void> { return undefined; }
}

class ApprovalFactory implements RuntimeFactory {
  async launch(_runtime: RuntimeConfig, context: LaunchContext): Promise<RuntimeHandle> { return new ApprovalHandle(context); }
}

const running: Array<{ engine: Engine; store: SqliteStore }> = [];
async function fixture(permissionTimeoutMs = 10_000) {
  const clock = new FakeClock(100);
  const store = SqliteStore.open(":memory:");
  const config = defaultConfig();
  config.defaultWorkerRuntime = "approval";
  config.runtimes = [{ name: "approval", command: "fake", args: [], env: {}, tags: [], description: "approval", permission: "ask" }];
  const engine = new Engine({ store, clock, config, factory: new ApprovalFactory(), workspaceRoot: process.cwd(), permissionTimeoutMs });
  running.push({ engine, store });
  await engine.start();
  return { engine, store, clock, worker: await engine.spawn({ runtime: "approval", task: "ask for approval" }) };
}

async function settleMicrotasks(): Promise<void> { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }

afterEach(async () => {
  for (const { engine, store } of running.splice(0)) { await engine.close(); await store.close(); }
});

describe("host-mediated permission approval", () => {
  it("exposes a unique redacted request and accepts an exact option", async () => {
    const { engine, worker } = await fixture();
    let request: PendingPermission | undefined;
    engine.addPermissionHandler((pending) => { request = pending; });
    await settleMicrotasks();
    const pending = engine.pendingPermissions(worker.workerId);
    expect(pending).toHaveLength(1);
    expect(request?.permissionId).toBe(pending[0]!.permissionId);
    expect(pending[0]).toMatchObject({ workerId: worker.workerId, title: "Run private command", kind: "execute" });
    expect(pending[0]!.options).toEqual([
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject once", kind: "reject_once" },
    ]);
    expect(JSON.stringify(pending)).not.toContain("should-not-leak");
    expect(engine.respondPermission({ workerId: worker.workerId, permissionId: pending[0]!.permissionId, decision: { outcome: "selected", optionId: "allow", optionKind: "allow_once" } })).toMatchObject({ status: "resolved" });
    await settleMicrotasks();
    expect(engine.pendingPermissions()).toEqual([]);
    await engine.settle();
  });

  it("rejects wrong worker, wrong kind, stale and duplicate answers", async () => {
    const { engine, worker } = await fixture();
    await settleMicrotasks();
    const permissionId = engine.pendingPermissions()[0]!.permissionId;
    expect(() => engine.respondPermission({ workerId: "wrk_other", permissionId, decision: { outcome: "cancelled" } })).toThrowError(expect.objectContaining({ code: "permission_worker_mismatch" }));
    expect(() => engine.respondPermission({ workerId: worker.workerId, permissionId, decision: { outcome: "selected", optionId: "allow", optionKind: "reject_once" } })).toThrowError(expect.objectContaining({ code: "invalid_permission_option" }));
    engine.respondPermission({ workerId: worker.workerId, permissionId, decision: { outcome: "cancelled" } });
    expect(() => engine.respondPermission({ workerId: worker.workerId, permissionId, decision: { outcome: "cancelled" } })).toThrowError(expect.objectContaining({ code: "permission_not_pending" }));
  });

  it("expires as cancelled and never auto-allows", async () => {
    const { engine, worker, clock } = await fixture(10);
    await settleMicrotasks();
    expect(engine.pendingPermissions(worker.workerId)).toHaveLength(1);
    clock.advance(10);
    await settleMicrotasks();
    expect(engine.pendingPermissions()).toEqual([]);
    await engine.settle();
    const event = (await engine.events()).find((item) => item.type === "worker.turn_end");
    expect(event?.payload.text).toBe("cancelled");
  });

  it("cancels pending approval when interrupted, killed, or closed", async () => {
    const first = await fixture();
    await settleMicrotasks();
    await first.engine.interrupt(first.worker.workerId);
    expect(first.engine.pendingPermissions()).toEqual([]);
    const second = await fixture();
    await settleMicrotasks();
    await second.engine.kill(second.worker.workerId);
    expect(second.engine.pendingPermissions()).toEqual([]);
    const third = await fixture();
    await settleMicrotasks();
    await third.engine.close();
    expect(third.engine.pendingPermissions()).toEqual([]);
  });

  it("keeps ask from selecting an option before the host responds", async () => {
    const { engine, worker } = await fixture();
    await settleMicrotasks();
    expect(engine.pendingPermissions(worker.workerId)).toHaveLength(1);
    expect((await engine.events()).find((event) => event.type === "worker.permission_request")?.payload.decision).toBe("forward");
  });
});
