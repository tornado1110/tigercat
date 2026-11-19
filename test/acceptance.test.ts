import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveAwaitingInput } from "../src/awaiting.js";
import { FakeClock } from "../src/clock.js";
import { defaultConfig } from "../src/config.js";
import { admit } from "../src/filter.js";
import { assertNoShellOrEditTools, ROUTER_TOOL_NAMES } from "../src/tools.js";
import { startHarness } from "./harness/engine.js";
import { mismatches, parseTriggerJsonl, replayTriggers } from "./harness/replay.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const singleTask = `
{"id":"trg_single_01","ts":"2026-03-02T01:10:00.000Z","source":"feishu","kind":"im.message","thread_id":"feishu:eng:cli","author":"alice","is_bot":false,"text":"morning","reply_to":null,"expect":{"filter":"ignore","route":null,"spawns":false}}
{"id":"trg_single_02","ts":"2026-03-02T01:10:30.000Z","source":"feishu","kind":"im.message","thread_id":"feishu:eng:cli","author":"keith","is_bot":false,"text":"Please add a --json flag to tigercat list and document it in the README.","reply_to":null,"expect":{"filter":"respond","route":"router","spawns":true,"subscribe":["feishu:eng:cli"]}}
{"id":"trg_single_03","ts":"2026-03-02T01:11:10.000Z","source":"feishu","kind":"im.message","thread_id":"feishu:eng:cli","author":"keith","is_bot":false,"text":"Also handle the empty-list case: print [] and exit 0.","reply_to":"trg_single_02","expect":{"filter":"respond","route":"worker:feishu:eng:cli","spawns":false}}
{"id":"trg_single_04","ts":"2026-03-02T01:12:00.000Z","source":"feishu","kind":"im.message","thread_id":"feishu:eng:cli","author":"keith","is_bot":false,"text":"Put the tests next to the command, not in a new package.","reply_to":"trg_single_02","expect":{"filter":"respond","route":"worker:feishu:eng:cli","spawns":false}}
{"id":"trg_single_05","ts":"2026-03-02T01:12:40.000Z","source":"feishu","kind":"im.message","thread_id":"feishu:eng:cli","author":"tigercat-bot","is_bot":true,"text":"Working on it.","reply_to":"trg_single_02","expect":{"filter":"ignore","route":null,"spawns":false}}
{"id":"trg_single_06","ts":"2026-03-02T01:13:05.000Z","source":"feishu","kind":"im.message","thread_id":"feishu:eng:cli","author":"alice","is_bot":false,"text":"thanks","reply_to":"trg_single_02","expect":{"filter":"ignore","route":null,"spawns":false}}
`;

describe("week-1 gates", () => {
  it("router tool list contains no shell or edit tools", () => {
    expect([...ROUTER_TOOL_NAMES]).toEqual([
      "spawn",
      "list",
      "send",
      "read",
      "interrupt",
      "wait",
      "kill",
      "subscribe",
      "unsubscribe",
    ]);
    expect(() => assertNoShellOrEditTools(ROUTER_TOOL_NAMES)).not.toThrow();
  });

  it("2nd Trigger on a subscribed Thread yields 0 Router decisions", async () => {
    const harness = await startHarness();
    roots.push(harness.root);
    const triggers = parseTriggerJsonl(singleTask);
    const observations = await replayTriggers(harness.engine, harness.clock, triggers);
    expect(mismatches(observations[0])).toEqual([]);
    expect(mismatches(observations[1])).toEqual([]);
    const afterSpawn = observations[1].decisions;
    expect(afterSpawn).toBe(1);
    expect(mismatches(observations[2])).toEqual([]);
    expect(observations[2].decisions - afterSpawn).toBe(0);
    expect(observations[2].router).toBe(false);
    expect(observations[2].deliveredRoutes).toEqual(["worker:feishu:eng:cli"]);
  });

  it("spawn returns Started within 1s and the Router answers while a Worker runs", async () => {
    const harness = await startHarness({ durationMs: 60 * 60_000 });
    roots.push(harness.root);
    const startedAt = Date.now();
    const spawned = await harness.engine.spawn({
      runtime: "worker",
      prompt: "please fix the login bug",
      threads: ["feishu:eng:cli"],
    });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(spawned.status).toBe("started");
    await harness.engine.settle();
    const worker = (await harness.engine.workers()).find((item) => item.id === spawned.workerId);
    expect(worker?.state).toBe("running");
    const before = await harness.engine.routerDecisionCount();
    const reply = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:other",
      author: "keith",
      text: "Please investigate the flaky CI job.",
      kind: "im.message",
      isBot: false,
      timestamp: harness.clock.now() + 1_000,
    });
    await harness.engine.settle();
    expect(reply.router).toBe(true);
    expect(await harness.engine.routerDecisionCount()).toBe(before + 1);
    const still = await harness.engine.store.getSession(spawned.workerId);
    expect(still?.state).toBe("running");
    const events = await harness.engine.events();
    expect(events.some((event) => event.type === "worker.turn_end" && event.workerId === spawned.workerId)).toBe(
      false,
    );
  });

  it("a chit-chat Trigger dropped by the rule filter causes 0 Router calls", async () => {
    const harness = await startHarness();
    roots.push(harness.root);
    const before = await harness.engine.routerDecisionCount();
    const result = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "alice",
      text: "lol",
      kind: "im.message",
      isBot: false,
      timestamp: 1,
    });
    await harness.engine.settle();
    expect(result.action).toBe("ignore");
    expect(result.rule).toBe("chatter");
    expect(result.router).toBe(false);
    expect(await harness.engine.routerDecisionCount()).toBe(before);
    expect(await harness.engine.workers()).toHaveLength(0);
  });
});

describe("fixture filter policy", () => {
  const rules = defaultConfig().filter;

  function judge(partial: {
    source?: string;
    thread_id: string;
    kind?: string;
    is_bot?: boolean;
    text: string;
    has_subscriber?: boolean;
  }) {
    return admit(
      {
        source: partial.source ?? "feishu",
        thread_id: partial.thread_id,
        kind: partial.kind ?? "im.message",
        is_bot: partial.is_bot ?? false,
        text: partial.text,
        has_subscriber: partial.has_subscriber ?? false,
      },
      rules,
    );
  }

  it("matches the single-task labels from config", () => {
    const triggers = parseTriggerJsonl(singleTask);
    let subscribed = false;
    for (const trigger of triggers) {
      const admission = judge({
        source: trigger.source,
        thread_id: trigger.thread_id,
        kind: trigger.kind,
        is_bot: trigger.is_bot,
        text: trigger.text,
        has_subscriber: subscribed,
      });
      expect(admission.outcome).toBe(trigger.expect.filter);
      if (trigger.expect.spawns) subscribed = true;
    }
  });

  it("drops threads outside the allowlist and passes CI failures through", () => {
    expect(judge({ thread_id: "feishu:random:offtopic", text: "Please fix the build" }).outcome).toBe("ignore");
    expect(
      judge({
        source: "github",
        thread_id: "github:tornado1110/tigercat#12",
        kind: "ci.result",
        text: "CI failed",
        has_subscriber: false,
      }).outcome,
    ).toBe("candidate");
    expect(
      judge({
        source: "github",
        thread_id: "github:tornado1110/tigercat#12",
        kind: "ci.result",
        text: "CI success",
      }).outcome,
    ).toBe("ignore");
    expect(
      judge({
        source: "github",
        thread_id: "github:tornado1110/tigercat#12",
        kind: "pr.opened",
        text: "Opened the pull request",
      }).outcome,
    ).toBe("candidate");
  });
});

describe("stop keeps subscriptions; kill and crash release them", () => {
  it("a stop phrase interrupts and the follow-up still reaches the Worker", async () => {
    const harness = await startHarness({ durationMs: 60 * 60_000 });
    roots.push(harness.root);
    await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "keith",
      text: "Please fix the login bug",
      kind: "im.message",
      timestamp: 1_000,
    });
    await harness.engine.settle();
    const worker = (await harness.engine.workers())[0];
    const stop = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "keith",
      text: "stop, do the other approach instead",
      kind: "im.message",
      timestamp: 2_000,
    });
    expect(stop.action).toBe("respond");
    expect(stop.interrupt).toBe(true);
    expect(stop.router).toBe(false);
    expect(stop.deliveredTo).toEqual([worker.id]);
    const subs = await harness.engine.store.subscriptionsForWorker(worker.id);
    expect(subs).toHaveLength(1);
    const follow = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "keith",
      text: "The typo is in the install section, not the title.",
      kind: "im.message",
      timestamp: 3_000,
    });
    expect(follow.router).toBe(false);
    expect(follow.deliveredTo).toEqual([worker.id]);
    expect(await harness.engine.store.subscriptionsForWorker(worker.id)).toHaveLength(1);
  });

  it("kill releases subscriptions, keeps the worktree, and sends the Thread back to the Router", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "tigercat-kill-"));
    roots.push(root);
    const harness = await startHarness({ root, durationMs: 60 * 60_000 });
    const spawned = await harness.engine.spawn({
      runtime: "worker",
      task: "write a test",
      threads: ["feishu:eng:cli"],
    });
    await harness.engine.settle();
    const session = await harness.engine.store.getSession(spawned.workerId);
    expect(session?.cwd && existsSync(session.cwd)).toBe(true);
    const cwd = session?.cwd ?? "";
    await harness.engine.kill(spawned.workerId);
    expect(existsSync(cwd)).toBe(true);
    expect(await harness.engine.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(0);
    const next = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "keith",
      text: "Please update the README too",
      kind: "im.message",
      timestamp: harness.clock.now() + 10,
    });
    await harness.engine.settle();
    expect(next.router).toBe(true);
    expect(next.action).toBe("respond");
  });
});

describe("awaitingInput heuristic", () => {
  it("annotates a question without changing the ACP stop reason", () => {
    expect(deriveAwaitingInput("end_turn", "Which file should I edit?")).toBe(true);
    expect(deriveAwaitingInput("end_turn", "done")).toBe(false);
    expect(deriveAwaitingInput("cancelled", "Which file should I edit?")).toBe(false);
  });
});

describe("restart drops dead Worker subscriptions", () => {
  it("sends the Thread back through the Router when the process is gone", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "tigercat-restart-"));
    roots.push(root);
    const db = path.join(root, "state.sqlite");
    const clock = new FakeClock(0);
    const first = await startHarness({ clock, db, root, durationMs: 60 * 60_000 });
    await first.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "keith",
      text: "Please add a --json flag",
      kind: "im.message",
      timestamp: 1_000,
    });
    await first.engine.settle();
    const workerId = (await first.engine.workers())[0].id;
    await first.engine.close();
    await first.store.close();

    const secondClock = new FakeClock(1_000);
    const second = await startHarness({ clock: secondClock, db, root, durationMs: 60 * 60_000 });
    const thread = await second.engine.store.getThreadByKey("feishu:eng:cli");
    const subs = await second.engine.store.subscriptionsForThread(thread?.id ?? "");
    expect(subs.map((sub) => sub.workerId)).not.toContain(workerId);
    const dead = await second.engine.store.getSession(workerId);
    expect(dead?.state).toBe("interrupted");
    const follow = await second.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "keith",
      text: "Please fix the empty list.",
      kind: "im.message",
      timestamp: 2_000,
    });
    await second.engine.settle();
    expect(follow.router).toBe(true);
    expect(follow.action).toBe("respond");
    expect(follow.deliveredTo).not.toContain(workerId);
    await second.engine.close();
    await second.store.close();
  });
});
