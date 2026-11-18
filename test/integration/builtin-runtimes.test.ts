import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { SystemClock } from "../../src/clock.js";
import { defaultConfig, saveConfig } from "../../src/config.js";
import { Engine } from "../../src/engine.js";
import { ProcessRuntimeFactory } from "../../src/runtime.js";
import { SqliteStore } from "../../src/store.js";
import type { RuntimeConfig } from "../../src/types.js";
import { waitForEvent } from "../harness/stdio-engine.js";

const roots: string[] = [];
const scrubbed = [
  "TIGERCAT_RUNTIME_LIVE",
  "TIGERCAT_CLAUDE_BIN",
  "TIGERCAT_CODEX_BIN",
  "TIGERCAT_CLAUDE_CODE_ACP",
  "TIGERCAT_CODEX_ACP",
  "CLAUDE_CODE_EXECUTABLE",
  "CODEX_PATH",
];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTree(root);
});

function profile(name: string, scenario = "ok"): RuntimeConfig {
  return {
    name,
    command: process.execPath,
    args: [path.resolve("test/stub-agent.ts")],
    env: { TIGERCAT_STUB_SCENARIO: scenario, TIGERCAT_STUB_NAME: name },
    tags: ["worker"],
    description: `${name} backed by the stdio stub`,
    permission: "ask",
  };
}

async function startProfiles(runtimes: RuntimeConfig[]) {
  const root = mkdtempSync(path.join(tmpdir(), "tigercat-profiles-"));
  roots.push(root);
  const store = SqliteStore.open(path.join(root, "state.sqlite"));
  const config = defaultConfig();
  config.runtimes = runtimes;
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

function scrubEnv(): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of [...scrubbed, "PATH", "Path"]) previous.set(key, process.env[key]);
  for (const key of scrubbed) delete process.env[key];
  process.env.PATH = "/usr/bin:/bin";
  delete process.env.Path;
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

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

describe("claude-code and codex profiles", () => {
  it("sends the same prompt to both stub-backed profiles and reads the result", async () => {
    const prompt = "task: add a --json flag to tigercat list";
    const harness = await startProfiles([profile("claude-code"), profile("codex")]);
    const claude = await harness.engine.spawn({
      runtime: "claude-code",
      prompt,
      threads: ["feishu:eng:cli"],
    });
    const codex = await harness.engine.spawn({
      runtime: "codex",
      prompt,
      threads: ["feishu:eng:cli"],
    });
    expect(claude.status).toBe("started");
    expect(codex.status).toBe("started");

    for (const spawned of [claude, codex]) {
      const profileName = spawned.workerId === claude.workerId ? "claude-code" : "codex";
      const update = await waitForEvent(
        harness.engine,
        (event) =>
          event.workerId === spawned.workerId &&
          event.type === "worker.update" &&
          String(event.payload.text ?? "").includes(`stub ok [${profileName}]: ${prompt}`),
      );
      expect(update.payload.sessionUpdate).toBe("agent_message_chunk");
      const end = await waitForEvent(
        harness.engine,
        (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end",
      );
      expect(end.payload.stopReason).toBe("end_turn");
      expect(end.payload.awaitingInput).toBe(false);
      const session = await harness.engine.store.getSession(spawned.workerId);
      expect(session?.runtime).toBe(profileName);
      expect(session?.acpSessionId).toBe("stub-session");
      expect(session?.state).toBe("idle");
      expect(await harness.engine.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(1);
      const read = (await harness.engine.read(spawned.workerId)) as {
        events: Array<{ type: string; summary: string }>;
      };
      expect(read.events.map((event) => event.type)).toEqual([
        "worker.spawned",
        "worker.update",
        "worker.turn_end",
      ]);
      expect(read.events.some((event) => event.type === "worker.turn_end" && event.summary.includes(prompt))).toBe(
        true,
      );
    }
    await harness.engine.close();
    await harness.store.close();
  });

  it("releases subscriptions when a profile process exits on its own", async () => {
    const harness = await startProfiles([profile("claude-code")]);
    const spawned = await harness.engine.spawn({
      runtime: "claude-code",
      prompt: "task: exit after the turn",
      threads: ["feishu:eng:cli"],
    });
    await waitForEvent(
      harness.engine,
      (event) => event.workerId === spawned.workerId && event.type === "worker.turn_end",
    );
    const session = await harness.engine.store.getSession(spawned.workerId);
    expect(session?.state).toBe("idle");
    expect(session?.pid).toBeTruthy();
    process.kill(session?.pid ?? 0, "SIGKILL");
    const error = await waitForEvent(
      harness.engine,
      (event) => event.workerId === spawned.workerId && event.type === "worker.error",
    );
    expect(error.payload.code).toBe("worker_exited");
    const after = await harness.engine.store.getSession(spawned.workerId);
    expect(after?.state).toBe("error");
    expect(await harness.engine.store.subscriptionsForWorker(spawned.workerId)).toHaveLength(0);
    await harness.engine.close();
    await harness.store.close();
  });
});

describe("tigercat runtime list and test", () => {
  it("lists the built-ins and dry-runs both handshakes", async () => {
    const restore = scrubEnv();
    const root = mkdtempSync(path.join(tmpdir(), "tigercat-cli-"));
    roots.push(root);
    const config = path.join(root, "missing.toml");
    try {
      let listed = "";
      const listCode = await main(["runtime", "list", "--json", "--config", config], {
        stdout: (text) => {
          listed += text;
        },
        stderr: () => undefined,
      });
      expect(listCode).toBe(0);
      const runtimes = JSON.parse(listed) as Array<{ name: string; testMode?: string; adapter?: { version: string } }>;
      expect(runtimes.map((runtime) => runtime.name)).toEqual(["claude-code", "codex"]);
      expect(runtimes.every((runtime) => runtime.testMode === "dry-run")).toBe(true);
      expect(runtimes[0]?.adapter?.version).toBe("0.108.0");
      expect(runtimes[1]?.adapter?.version).toBe("2.7.0");

      for (const name of ["claude-code", "codex"]) {
        let out = "";
        const code = await main(["runtime", "test", name, "--config", config], {
          stdout: (text) => {
            out += text;
          },
          stderr: () => undefined,
        });
        const report = JSON.parse(out) as {
          ok: boolean;
          mode: string;
          vendorExecuted: boolean;
          stopReason: string;
          preview?: string;
          message: string;
          acpSessionId: string;
        };
        expect(code).toBe(0);
        expect(report.ok).toBe(true);
        expect(report.mode).toBe("dry-run");
        expect(report.vendorExecuted).toBe(false);
        expect(report.stopReason).toBe("end_turn");
        expect(report.preview).toContain(`dry-run ${name}: ping`);
        expect(report.message).toContain("was not executed");
        expect(report.acpSessionId).toBe(`dry-run-${name}`);
      }
    } finally {
      restore();
    }
  });

  it("tests a configured claude-code command instead of the dry-run agent", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "tigercat-cli-override-"));
    roots.push(root);
    const file = path.join(root, "config.toml");
    const config = defaultConfig();
    config.runtimes = [profile("claude-code")];
    saveConfig(config, file);
    let out = "";
    const code = await main(["runtime", "test", "claude-code", "--config", file], {
      stdout: (text) => {
        out += text;
      },
      stderr: () => undefined,
    });
    const report = JSON.parse(out) as { ok: boolean; mode: string; vendorExecuted: boolean; stopReason: string };
    expect(code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.mode).toBe("command");
    expect(report.vendorExecuted).toBe(false);
    expect(report.stopReason).toBe("end_turn");
  });
});
