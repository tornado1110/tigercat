import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startStdioEngine, waitForEvent } from "../harness/stdio-engine.js";

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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("real stdio stub-agent", () => {
  it("ok: handshake, agent_message_chunk, and end_turn", async () => {
    const harness = await startStdioEngine("ok");
    roots.push(harness.root);
    const spawned = await harness.engine.spawn({
      runtime: "ok",
      prompt: "say hello",
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
    await waitForEvent(harness.engine, (event) => event.type === "worker.spawned");
    await new Promise((resolve) => setTimeout(resolve, 150));
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
    await harness.engine.close();
    await harness.store.close();
  });

  it("leak-child-process: kill reaps the child", async () => {
    const pidFile = path.join(tmpdir(), `tigercat-leak-${process.pid}.pid`);
    const harness = await startStdioEngine("leak-child-process", { TIGERCAT_LEAK_PIDFILE: pidFile });
    roots.push(harness.root);
    const spawned = await harness.engine.spawn({
      runtime: "leak-child-process",
      prompt: "leak",
      threads: ["feishu:eng:cli"],
    });
    await waitForEvent(harness.engine, (event) => event.type === "worker.spawned");
    const started = Date.now();
    let pid = 0;
    while (Date.now() - started < 5_000) {
      try {
        pid = Number(readFileSync(pidFile, "utf8"));
        if (pid > 0) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);
    await harness.engine.kill(spawned.workerId);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && alive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(alive(pid)).toBe(false);
    await harness.engine.close();
    await harness.store.close();
  });

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
});
