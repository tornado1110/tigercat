import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeClock } from "../../src/clock.js";
import { defaultConfig } from "../../src/config.js";
import { Engine } from "../../src/engine.js";
import { FakeTimeRuntimeFactory } from "../../src/runtime.js";
import { SqliteStore } from "../../src/store.js";

export async function startHarness(options?: {
  clock?: FakeClock;
  durationMs?: number;
  root?: string;
  db?: string;
}): Promise<{ engine: Engine; clock: FakeClock; store: SqliteStore; root: string }> {
  const clock = options?.clock ?? new FakeClock(0);
  const root = options?.root ?? mkdtempSync(path.join(tmpdir(), "tigercat-"));
  const store = SqliteStore.open(options?.db ?? ":memory:");
  const config = defaultConfig();
  config.defaultWorkerRuntime = "worker";
  config.runtimes = [
    {
      name: "worker",
      command: "fake",
      args: [],
      env: {},
      tags: [],
      description: "in-process fake worker",
      permission: "ask",
    },
  ];
  const engine = new Engine({
    store,
    clock,
    config,
    factory: new FakeTimeRuntimeFactory(clock, options?.durationMs ?? 30 * 60_000),
    workspaceRoot: root,
  });
  await engine.start();
  return { engine, clock, store, root };
}
