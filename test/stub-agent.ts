#!/usr/bin/env node
/**
 * Scripted ACP stub. Delays in the scenario descriptions are fake
 * milliseconds; this process never sleeps in real time. Hang waits on
 * an abort signal instead of a timer.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const scenario = process.env.TIGERCAT_STUB_SCENARIO ?? "ok";
const stubName = process.env.TIGERCAT_STUB_NAME ?? "tigercat-stub";
const agentName = process.env.TIGERCAT_STUB_AGENT_NAME ?? stubName;
const agentVersion = process.env.TIGERCAT_STUB_AGENT_VERSION ?? "0.0.0";

interface Session {
  pending: AbortController | null;
}

let acceptSteer: ((text: string) => void) | undefined;
let steerAttempts = 0;
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
        agentInfo: { name: agentName, version: agentVersion },
      };
    }
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      _meta: scenario === "steer" ? { steering: { supported: true } } : undefined,
      agentCapabilities: { loadSession: scenario !== "no-session-load" },
      agentInfo: { name: agentName, version: agentVersion },
    };
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    if (scenario === "leak-child-process") {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1e9)"], { stdio: "ignore" });
      const pidFile = process.env.TIGERCAT_LEAK_PIDFILE;
      if (pidFile && child.pid) writeFileSync(pidFile, String(child.pid));
    }
    const sessionId = scenario === "session-load" || scenario === "session-load-hang" ? mintLoadableSession() : "stub-session";
    sessions.set(sessionId, { pending: null });
    void params;
    return { sessionId, configOptions: [{ id: "model", name: "Model", category: "model", type: "select" as const, currentValue: "test-model", options: [{ value: "test-model", name: "Test Model" }] }] };
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    sessionNote(`load-request ${params.sessionId}`);
    if (scenario === "session-load-fail") throw acp.RequestError.invalidParams(undefined, "session load failed");
    if (scenario !== "session-load" && scenario !== "session-load-hang") throw acp.RequestError.methodNotFound("session/load");
    const expected = persistedSessionId();
    if (!expected || params.sessionId !== expected) {
      throw acp.RequestError.invalidParams(undefined, "unknown session");
    }
    sessions.set(params.sessionId, { pending: null });
    const count = replayCount();
    for (let index = 0; index < count; index += 1) {
      await replayUpdate(client, params.sessionId, index);
    }
    sessionNote(`replay ${count}`);
    sessionNote(`load ${params.sessionId}`);
    if (process.env.TIGERCAT_STUB_POST_LOAD === "1") {
      const sessionId = params.sessionId;
      // After this handler returns, the SDK writes the session/load response.
      // setImmediate runs after that write is queued, matching an adapter that
      // emits fresh session state once load has completed.
      setImmediate(() => {
        sessionNote(`post-load ${sessionId}`);
        void client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "post-load", description: "POST_LOAD_COMMANDS" }],
          },
        });
      });
    }
    return {};
  })
  .onRequest("_session/steering", (raw) => raw as {
    sessionId: string; prompt: unknown; _meta?: { steering?: { idleBehavior?: string } };
  }, ({ params }) => {
    if (params.sessionId !== "stub-session" || params._meta?.steering?.idleBehavior !== "promptRequired") {
      throw acp.RequestError.invalidParams();
    }
    if (!acceptSteer || steerAttempts++ === 0) return { outcome: "promptRequired", reason: "noRunningTurn" };
    acceptSteer(promptText(params.prompt));
    acceptSteer = undefined;
    return { outcome: "injected" };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal }) => {
    const session = sessions.get(params.sessionId) ?? { pending: null };
    sessions.set(params.sessionId, session);
    const pending = new AbortController();
    session.pending = pending;
    if (scenario !== "ignore-cancel") {
      signal.addEventListener("abort", () => pending.abort(), { once: true });
    }
    if (scenario === "steer") {
      const addition = await new Promise<string>((resolve) => { acceptSteer = resolve; });
      await chunk(client, params.sessionId, `${promptText(params.prompt)} + ${addition}`);
      return { stopReason: addition === "cancel" ? "cancelled" as const : "end_turn" as const };
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
    if (scenario === "hang" || scenario === "session-load-hang") {
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

function mintLoadableSession(): string {
  const sessionId = `stub-load-${randomUUID()}`;
  const file = process.env.TIGERCAT_STUB_SESSION_FILE;
  if (file) writeFileSync(file, sessionId);
  sessionNote(`new ${sessionId}`);
  return sessionId;
}

function persistedSessionId(): string | undefined {
  const file = process.env.TIGERCAT_STUB_SESSION_FILE;
  if (!file) return undefined;
  try {
    const id = readFileSync(file, "utf8").trim();
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function sessionNote(line: string): void {
  const file = process.env.TIGERCAT_STUB_SESSION_LOG;
  if (file) appendFileSync(file, `${line}\n`);
}

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

function replayCount(): number {
  const count = Number(process.env.TIGERCAT_STUB_REPLAY ?? "0");
  return Number.isInteger(count) && count > 0 ? count : 0;
}

function replayUpdate(client: acp.AgentContext, sessionId: string, index: number): Promise<void> {
  const text = `REPLAY_${index}`;
  const update = index % 4 === 0
    ? { sessionUpdate: "user_message_chunk" as const, content: { type: "text" as const, text } }
    : index % 4 === 1
      ? { sessionUpdate: "agent_message_chunk" as const, content: { type: "text" as const, text } }
      : index % 4 === 2
        ? { sessionUpdate: "agent_thought_chunk" as const, content: { type: "text" as const, text } }
        : { sessionUpdate: "usage_update" as const, used: index, size: 128 };
  return client.notify(acp.methods.client.session.update, { sessionId, update });
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
