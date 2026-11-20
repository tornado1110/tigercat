#!/usr/bin/env node
/**
 * Scripted ACP stub. Delays in the scenario descriptions are fake
 * milliseconds; this process never sleeps in real time. Hang waits on
 * an abort signal instead of a timer.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const scenario = process.env.TIGERCAT_STUB_SCENARIO ?? "ok";
const stubName = process.env.TIGERCAT_STUB_NAME ?? "tigercat-stub";

interface Session {
  pending: AbortController | null;
}

const sessions = new Map<string, Session>();

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

const connection = acp
  .agent({ name: stubName })
  .onRequest(acp.methods.agent.initialize, () => {
    if (scenario === "bad-handshake") {
      return {
        protocolVersion: 999,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: stubName, version: "0.0.0" },
      };
    }
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: scenario !== "no-session-load" },
      agentInfo: { name: stubName, version: "0.0.0" },
    };
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    if (scenario === "leak-child-process") {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1e9)"], { stdio: "ignore" });
      const pidFile = process.env.TIGERCAT_LEAK_PIDFILE;
      if (pidFile && child.pid) writeFileSync(pidFile, String(child.pid));
    }
    const sessionId = "stub-session";
    sessions.set(sessionId, { pending: null });
    void params;
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.load, () => {
    throw acp.RequestError.methodNotFound("session/load");
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal }) => {
    const session = sessions.get(params.sessionId) ?? { pending: null };
    sessions.set(params.sessionId, session);
    const pending = new AbortController();
    session.pending = pending;
    if (scenario !== "ignore-cancel") {
      signal.addEventListener("abort", () => pending.abort(), { once: true });
    }
    if (scenario === "garbage-stdout") {
      process.stdout.write("this is not json-rpc\n");
      await never(pending.signal);
    }
    if (scenario === "ignore-cancel") {
      // Stay in the turn until the process is killed. session/cancel is ignored above.
      await chunk(client, params.sessionId, "ignoring cancellation");
      await new Promise<void>(() => undefined);
    }
    if (scenario === "hang") {
      await chunk(client, params.sessionId, "hanging");
      await never(pending.signal);
    }
    if (scenario === "crash-mid-turn") {
      await chunk(client, params.sessionId, "partial");
      process.exit(1);
    }
    if (scenario === "ask-permission") {
      const response = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "call_1", title: "edit file", kind: "edit", status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      if (response.outcome.outcome !== "selected" || response.outcome.optionId !== "allow") {
        return { stopReason: "end_turn" as const };
      }
    }
    if (scenario === "huge-output") {
      await chunk(client, params.sessionId, "y".repeat(64 * 1024));
      return { stopReason: "end_turn" as const };
    }
    if (scenario === "slow-stream") {
      for (let i = 0; i < 4; i += 1) {
        if (pending.signal.aborted) return { stopReason: "cancelled" as const };
        await chunk(client, params.sessionId, `tick-${i} `);
        await Promise.resolve();
      }
    }
    if (scenario === "ask-input") {
      await chunk(client, params.sessionId, "Which file should I edit?");
      return { stopReason: "end_turn" as const };
    }
    if (pending.signal.aborted && scenario !== "ignore-cancel") {
      return { stopReason: "cancelled" as const };
    }
    await chunk(client, params.sessionId, okText(params.prompt));
    return { stopReason: "end_turn" as const };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    if (scenario === "ignore-cancel") return;
    sessions.get(params.sessionId)?.pending?.abort();
  })
  .connect(stream);

await connection.closed;

function okText(prompt: unknown): string {
  const text = promptText(prompt);
  const who = process.env.TIGERCAT_STUB_NAME ? ` [${process.env.TIGERCAT_STUB_NAME}]` : "";
  return `stub ok${who}${text ? `: ${text}` : ""}`;
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function chunk(client: acp.AgentContext, sessionId: string, text: string): Promise<void> {
  return client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

function never(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
