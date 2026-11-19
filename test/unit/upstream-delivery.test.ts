import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerResultRelay, deliverViaCcConnect, planCcConnectDelivery } from "../../src/upstream-delivery.js";
import { startHarness } from "../harness/engine.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cc-connect delivery after the ACP prompt returns", () => {
  it("does not spawn when CC_SESSION_KEY is unset", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tigercat-send-"));
    roots.push(dir);
    const marker = path.join(dir, "ran");
    const script = writeSender(dir);
    const env = { TIGERCAT_CC_CONNECT_BIN: script, MARKER: marker };
    expect(planCcConnectDelivery(env).ok).toBe(false);
    const outcome = await deliverViaCcConnect("worker result", env);
    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toContain("CC_SESSION_KEY");
    expect(() => readFileSync(marker, "utf8")).toThrow();
  });

  it("posts the worker text on stdin with send --stdin", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tigercat-send-"));
    roots.push(dir);
    const marker = path.join(dir, "ran.json");
    const script = writeSender(dir);
    const outcome = await deliverViaCcConnect("finished text", {
      CC_SESSION_KEY: "feishu:chat:user",
      CC_PROJECT: "demo",
      TIGERCAT_CC_CONNECT_BIN: script,
      MARKER: marker,
    });
    expect(outcome).toEqual({ delivered: true, reason: "cc-connect send exited 0." });
    const recorded = JSON.parse(readFileSync(marker, "utf8")) as {
      argv: string[];
      stdin: string;
      session: string;
    };
    expect(recorded.argv).toEqual(["send", "--stdin"]);
    expect(recorded.stdin).toBe("finished text");
    expect(recorded.session).toBe("set");
    expect(JSON.stringify(recorded)).not.toContain("feishu:chat:user");
  });

  it("holds the result until the prompt is released, then a second thread can proceed", async () => {
    const harness = await startHarness({ durationMs: 60_000 });
    roots.push(harness.root);
    const first = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:other",
      author: "keith",
      text: "Please investigate the flaky CI job.",
      kind: "im.message",
      isBot: false,
      timestamp: 1_000,
    });
    await harness.engine.settle();
    expect(first.router).toBe(true);
    const firstWorker = (await harness.engine.workers())[0];
    expect(firstWorker).toBeDefined();
    const sent: string[] = [];
    const relay = createWorkerResultRelay(harness.engine, async (text) => {
      sent.push(text);
      return { delivered: true, reason: "test double" };
    });
    relay.watch([firstWorker!.id]);
    const second = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:cli",
      author: "keith",
      text: "Please add a --json flag",
      kind: "im.message",
      isBot: false,
      timestamp: 2_000,
    });
    await harness.engine.settle();
    expect(second.router).toBe(true);
    expect(sent).toEqual([]);
    harness.clock.advance(60_000);
    await harness.engine.settle();
    harness.clock.advance(0);
    expect(sent).toEqual([]);
    relay.release();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(firstWorker!.id);
    expect(sent[0]).toContain("done");
    relay.stop();
    await harness.engine.close();
    await harness.store.close();
  });
});

function writeSender(dir: string): string {
  const script = path.join(dir, "cc-connect.js");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  writeFileSync(process.env.MARKER, JSON.stringify({
    argv: process.argv.slice(2),
    stdin: Buffer.concat(chunks).toString(),
    session: process.env.CC_SESSION_KEY ? "set" : "unset",
  }));
});
`,
  );
  return script;
}
