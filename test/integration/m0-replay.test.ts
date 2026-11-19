import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { startHarness } from "../harness/engine.js";
import { mismatches, parseTriggerJsonl, replayTriggers, type ReplayObservation } from "../harness/replay.js";

const m0Dir = path.resolve("test/fixtures/triggers/m0");
const jsonlFiles = readdirSync(m0Dir)
  .filter((name) => name.endsWith(".jsonl"))
  .sort();

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

async function replayM0(name: string, check: (observations: ReplayObservation[], decisions: number) => void) {
  const triggers = parseTriggerJsonl(readFileSync(path.join(m0Dir, name), "utf8"));
  const harness = await startHarness({ durationMs: 0 });
  roots.push(harness.root);
  try {
    const observations = await replayTriggers(harness.engine, harness.clock, triggers);
    check(observations, await harness.engine.routerDecisionCount());
  } finally {
    await harness.engine.close();
    await harness.store.close();
  }
}

function ignoredThatReachedRouter(observations: ReplayObservation[]): string[] {
  return observations
    .filter((observation) => observation.trigger.expect.filter === "ignore" && observation.router)
    .map((observation) => observation.trigger.id);
}

describe("m0 trigger fixtures", () => {
  it("replays every jsonl file under test/fixtures/triggers/m0", () => {
    expect(jsonlFiles).toEqual([
      "chatter-only.jsonl",
      "four-tasks.jsonl",
      "single-task.jsonl",
      "stop-request.jsonl",
      "stream-seed1.jsonl",
    ]);
  });

  for (const name of jsonlFiles) {
    it(`${name}: 0 mismatches at durationMs 0, and ignore never reaches the Router`, async () => {
      await replayM0(name, (observations) => {
        expect(observations.flatMap((observation) => mismatches(observation))).toEqual([]);
        expect(ignoredThatReachedRouter(observations)).toEqual([]);
      });
    }, 120_000);
  }

  it("chatter-only.jsonl makes 0 Router decisions and no model call", async () => {
    // startHarness does not set coordinatorRuntime and does not call
    // launchCoordinator, so the Router stays ScriptedRouter. A recorded
    // Router turn is the only path that would invoke a model.
    expect(defaultConfig().coordinatorRuntime).toBeUndefined();
    await replayM0("chatter-only.jsonl", (observations, decisions) => {
      expect(observations.every((observation) => observation.decisions === 0)).toBe(true);
      expect(observations.every((observation) => observation.router === false)).toBe(true);
      expect(decisions).toBe(0);
    });
  });

  it("generate.mjs --seed 1 --count 300 --work 20 matches stream-seed1.jsonl", () => {
    const script = path.join(m0Dir, "generate.mjs");
    const golden = readFileSync(path.join(m0Dir, "stream-seed1.jsonl"));
    const run = spawnSync(process.execPath, [script, "--seed", "1", "--count", "300", "--work", "20"], {
      encoding: "buffer",
    });
    expect(run.status, run.stderr?.toString("utf8")).toBe(0);
    expect(normalizeNewlines(run.stdout.toString("utf8"))).toBe(normalizeNewlines(golden.toString("utf8")));
  });
});
