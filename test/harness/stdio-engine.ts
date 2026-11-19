import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SystemClock } from "../../src/clock.js";
import { defaultConfig } from "../../src/config.js";
import { Engine } from "../../src/engine.js";
import { ProcessRuntimeFactory } from "../../src/runtime.js";
import { SqliteStore } from "../../src/store.js";
import type { RuntimeConfig, TigerEvent } from "../../src/types.js";

export function stubRuntime(scenario: string, env: Record<string, string> = {}): RuntimeConfig {
  return {
    name: scenario,
    command: process.execPath,
    args: [path.resolve("test/stub-agent.ts")],
    env: { TIGERCAT_STUB_SCENARIO: scenario, ...env },
    tags: [],
    description: `stdio stub ${scenario}`,
    permission: "ask",
  };
}

export async function startStdioEngine(scenario: string, env: Record<string, string> = {}, cancelGraceMs = 5_000) {
  const root = mkdtempSync(path.join(tmpdir(), "tigercat-stdio-"));
  const store = SqliteStore.open(path.join(root, "state.sqlite"));
  const config = defaultConfig();
  config.cancelGraceMs = cancelGraceMs;
  config.defaultWorkerRuntime = scenario;
  config.runtimes = [stubRuntime(scenario, env)];
  const engine = new Engine({
    store,
    clock: new SystemClock(),
    config,
    factory: new ProcessRuntimeFactory({ handshakeTimeoutMs: 8_000 }),
    workspaceRoot: root,
  });
  await engine.start();
  return { engine, store, root };
}

export async function waitForEvent(
  engine: Engine,
  predicate: (event: TigerEvent) => boolean,
  timeoutMs = 8_000,
): Promise<TigerEvent> {
  const started = Date.now();
  for (;;) {
    const found = (await engine.events()).find(predicate);
    if (found) return found;
    if (Date.now() - started > timeoutMs) {
      const types = (await engine.events()).map((event) => event.type).join(",");
      throw new Error(`timed out waiting for event; saw ${types || "(none)"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
