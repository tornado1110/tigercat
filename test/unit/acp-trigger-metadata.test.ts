import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { triggerFromAcpPrompt } from "../../src/acp-agent.js";

const prompt: PromptRequest = {
  sessionId: "session-1",
  prompt: [{ type: "text", text: "Please fix the build" }],
};

describe("ACP trigger metadata", () => {
  it("uses stable event identity and an explicit external timestamp", () => {
    expect(triggerFromAcpPrompt({ ...prompt, _meta: { event_id: "feishu:message-1", timestamp: 123, thread_id: "feishu:eng:cli", author: "alice" } }, 999)).toMatchObject({
      id: "feishu:message-1", source: "acp", timestamp: 123, thread: "feishu:eng:cli", author: "alice", text: "Please fix the build",
    });
  });

  it("keeps identified retries stable when the host omits timestamp", () => {
    const identified = { ...prompt, _meta: { event_id: "feishu:message-1" } };
    expect(triggerFromAcpPrompt(identified, 100)).toEqual(triggerFromAcpPrompt(identified, 200));
    expect(triggerFromAcpPrompt(identified, 100).timestamp).toBe(0);
  });

  it("preserves receipt time and no external identity for ordinary ACP prompts", () => {
    const trigger = triggerFromAcpPrompt(prompt, 200);
    expect(trigger.timestamp).toBe(200);
    expect(trigger.thread).toBe("acp:session-1");
    expect(trigger).not.toHaveProperty("id");
    expect(triggerFromAcpPrompt({ ...prompt, _meta: { timestamp: 0 } }, 200).timestamp).toBe(0);
  });

  it.each(["", "   ", 1, false, null, {}, []])("rejects invalid event_id %j as invalid params", (event_id) => {
    expect(() => triggerFromAcpPrompt({ ...prompt, _meta: { event_id } }, 100)).toThrowError(expect.objectContaining({ code: -32602 }));
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "123", null, false, {}])("rejects invalid timestamp %j as invalid params", (timestamp) => {
    expect(() => triggerFromAcpPrompt({ ...prompt, _meta: { timestamp } }, 100)).toThrowError(expect.objectContaining({ code: -32602 }));
  });

  it("deduplicates real ACP stdio retries and rejects malformed metadata before ingest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tigercat-acp-identity-"));
    const databasePath = path.join(root, "state.sqlite");
    const hostPath = path.join(root, "host.mjs");
    const source = (name: string) => JSON.stringify(pathToFileURL(path.resolve("src", name)).href);
    await writeFile(hostPath, `
      import { serveUpstream } from ${source("acp-agent.ts")};
      import { SystemClock } from ${source("clock.ts")};
      import { defaultConfig } from ${source("config.ts")};
      import { Engine } from ${source("engine.ts")};
      import { FakeTimeRuntimeFactory } from ${source("runtime.ts")};
      import { SqliteStore } from ${source("store.ts")};
      const config = defaultConfig();
      config.defaultWorkerRuntime = "worker";
      config.runtimes = [{ name: "worker", command: "fake", args: [], env: {}, tags: [], description: "stdio test", permission: "deny" }];
      const clock = new SystemClock();
      const store = SqliteStore.open(process.env.TIGERCAT_DB);
      const engine = new Engine({ store, clock, config, factory: new FakeTimeRuntimeFactory(clock, 100000), workspaceRoot: ${JSON.stringify(root)} });
      await engine.start();
      await serveUpstream(engine);
      await engine.close();
      await store.close();
    `);
    const proc = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), hostPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TIGERCAT_DB: databasePath },
      windowsHide: true,
    });
    type Response = { result?: { sessionId?: string; stopReason?: string }; error?: { code: number } };
    const pending = new Map<number, { resolve: (response: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let sequence = 0;
    let buffered = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => { stderr += chunk; });
    proc.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const response = JSON.parse(line) as Response & { id?: number };
        const waiter = response.id === undefined ? undefined : pending.get(response.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          pending.delete(response.id!);
          waiter.resolve(response);
        }
        newline = buffered.indexOf("\n");
      }
    });
    const exited = new Promise<number | null>((resolve) => {
      proc.once("exit", (code) => {
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`ACP test host exited ${code}: ${stderr}`));
        }
        pending.clear();
        resolve(code);
      });
    });
    const request = (method: string, params: unknown): Promise<Response> => {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ACP test request ${method} timed out: ${stderr}`));
        }, 8000);
        pending.set(id, { resolve, reject, timer });
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    };
    try {
      expect((await request("initialize", { protocolVersion: 1, clientCapabilities: {} })).error).toBeUndefined();
      const created = await request("session/new", { cwd: root, mcpServers: [] });
      const params = { ...prompt, sessionId: created.result!.sessionId, _meta: { event_id: "feishu:stable-message", thread_id: "feishu:eng:transport" } };
      expect((await request("session/prompt", params)).result?.stopReason).toBe("end_turn");
      expect((await request("session/prompt", params)).result?.stopReason).toBe("end_turn");
      expect((await request("session/prompt", { ...params, _meta: { event_id: 123 } })).error?.code).toBe(-32602);
      expect((await request("session/prompt", { ...params, _meta: { event_id: "bad-timestamp", timestamp: -1 } })).error?.code).toBe(-32602);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("SELECT COUNT(*) AS count FROM triggers").get()).toMatchObject({ count: 1 });
        expect(database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE role = 'worker'").get()).toMatchObject({ count: 1 });
        expect(database.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'trigger.ingested'").get()).toMatchObject({ count: 1 });
        expect(database.prepare("SELECT external_id, timestamp FROM triggers").get()).toMatchObject({ external_id: "feishu:stable-message", timestamp: 0 });
      } finally {
        database.close();
      }
    } finally {
      proc.stdin.end();
      const kill = setTimeout(() => proc.kill(), 2000);
      await exited;
      clearTimeout(kill);
      await rm(root, { recursive: true, force: true });
    }
  });
});
