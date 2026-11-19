import type { FakeClock } from "../../src/clock.js";
import type { Engine } from "../../src/engine.js";

/**
 * Trigger JSONL schema from the test-engineer fixtures.
 * `expect` is an assertion label, not a production field.
 */
export interface FixtureExpect {
  filter: "ignore" | "candidate" | "respond";
  route: string | string[] | null;
  spawns: boolean;
  subscribe?: string[];
  interrupt?: boolean;
  batch?: string;
  fanout?: number;
}

export interface FixtureTrigger {
  id: string;
  ts: string;
  source: string;
  kind: string;
  thread_id: string;
  author: string;
  is_bot: boolean;
  text: string;
  reply_to: string | null;
  expect: FixtureExpect;
}

export interface ReplayObservation {
  trigger: FixtureTrigger;
  filter: FixtureExpect["filter"];
  rule: string | null;
  router: boolean;
  interrupt: boolean;
  spawnedHomes: string[];
  deliveredRoutes: string[];
  subscribedHomes: string[][];
  decisions: number;
}

const REQUIRED = ["id", "ts", "source", "kind", "thread_id", "author", "is_bot", "text", "reply_to", "expect"] as const;

export function parseTriggerJsonl(text: string): FixtureTrigger[] {
  const rows: FixtureTrigger[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line) as Record<string, unknown>;
    for (const key of REQUIRED) {
      if (!(key in raw)) throw new Error(`line ${index + 1} missing ${key}`);
    }
    const expect = raw.expect as FixtureExpect;
    if (!expect || typeof expect !== "object") throw new Error(`line ${index + 1} missing expect`);
    rows.push({
      id: String(raw.id),
      ts: String(raw.ts),
      source: String(raw.source),
      kind: String(raw.kind),
      thread_id: String(raw.thread_id),
      author: String(raw.author),
      is_bot: Boolean(raw.is_bot),
      text: String(raw.text),
      reply_to: raw.reply_to === null || raw.reply_to === undefined ? null : String(raw.reply_to),
      expect,
    });
  }
  return rows;
}

export async function replayTriggers(
  engine: Engine,
  clock: FakeClock,
  triggers: FixtureTrigger[],
): Promise<ReplayObservation[]> {
  const observations: ReplayObservation[] = [];
  for (const trigger of triggers) {
    const stamp = Date.parse(trigger.ts);
    if (Number.isNaN(stamp)) throw new Error(`bad ts ${trigger.ts}`);
    if (stamp < clock.now()) throw new Error(`clock cannot rewind for ${trigger.id}`);
    if (stamp > clock.now()) clock.advance(stamp - clock.now());
    const before = new Set((await engine.workers()).map((worker) => worker.id));
    const result = await engine.ingest({
      id: trigger.id,
      source: trigger.source,
      thread: trigger.thread_id,
      author: trigger.author,
      text: trigger.text,
      timestamp: stamp,
      kind: trigger.kind,
      isBot: trigger.is_bot,
      replyTo: trigger.reply_to,
    });
    await engine.settle();
    const after = await engine.workers();
    const spawned = after.filter((worker) => !before.has(worker.id));
    const spawnedHomes: string[] = [];
    const subscribedHomes: string[][] = [];
    for (const worker of spawned) {
      spawnedHomes.push(await homeKey(engine, worker.id));
      const subs = await engine.store.subscriptionsForWorker(worker.id);
      const keys: string[] = [];
      for (const sub of subs) {
        const thread = await engine.store.getThread(sub.threadId);
        if (thread) keys.push(thread.key);
      }
      subscribedHomes.push(keys.sort());
    }
    const deliveredRoutes: string[] = [];
    for (const workerId of result.deliveredTo) {
      deliveredRoutes.push(`worker:${await homeKey(engine, workerId)}`);
    }
    observations.push({
      trigger,
      filter: result.action,
      rule: result.rule,
      router: result.router,
      interrupt: result.interrupt,
      spawnedHomes,
      deliveredRoutes,
      subscribedHomes,
      decisions: await engine.routerDecisionCount(),
    });
  }
  return observations;
}

export function mismatches(observation: ReplayObservation): string[] {
  const expect = observation.trigger.expect;
  const problems: string[] = [];
  const id = observation.trigger.id;
  if (observation.filter !== expect.filter) {
    problems.push(`${id} filter ${observation.filter} != ${expect.filter} (rule ${observation.rule})`);
  }
  if (expect.filter === "ignore") {
    if (observation.router) problems.push(`${id} ignore reached the Router`);
    if (observation.spawnedHomes.length > 0) problems.push(`${id} ignore spawned a Worker`);
    if (expect.route !== null) problems.push(`${id} ignore route should be null`);
  }
  if (expect.spawns !== (observation.spawnedHomes.length > 0)) {
    problems.push(`${id} spawns ${observation.spawnedHomes.length > 0} != ${expect.spawns}`);
  }
  if (expect.route !== undefined) {
    const actual = expect.spawns ? "router" : routeActual(observation);
    if (!sameRoute(actual, expect.route)) {
      problems.push(`${id} route ${JSON.stringify(actual)} != ${JSON.stringify(expect.route)}`);
    }
  }
  if (expect.interrupt !== undefined && observation.interrupt !== expect.interrupt) {
    problems.push(`${id} interrupt ${observation.interrupt} != ${expect.interrupt}`);
  }
  if (expect.fanout !== undefined && observation.deliveredRoutes.length !== expect.fanout) {
    problems.push(`${id} fanout ${observation.deliveredRoutes.length} != ${expect.fanout}`);
  }
  if (expect.subscribe) {
    const homes = observation.subscribedHomes[0] ?? [];
    const wanted = [...expect.subscribe].sort();
    if (homes.join("|") !== wanted.join("|")) {
      problems.push(`${id} subscribe ${homes.join(",")} != ${wanted.join(",")}`);
    }
  }
  return problems;
}

function routeActual(observation: ReplayObservation): string | string[] | null {
  if (observation.filter === "ignore") return null;
  if (observation.router) return "router";
  if (observation.deliveredRoutes.length === 1) return observation.deliveredRoutes[0];
  if (observation.deliveredRoutes.length > 1) return observation.deliveredRoutes;
  return null;
}

function sameRoute(actual: string | string[] | null, expected: string | string[] | null): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    const left = (Array.isArray(actual) ? actual : actual ? [actual] : []).slice().sort();
    const right = (Array.isArray(expected) ? expected : expected ? [expected] : []).slice().sort();
    return left.join("|") === right.join("|");
  }
  return actual === expected;
}

async function homeKey(engine: Engine, workerId: string): Promise<string> {
  const session = await engine.store.getSession(workerId);
  if (!session?.threadId) return workerId;
  const thread = await engine.store.getThread(session.threadId);
  return thread?.key ?? workerId;
}
