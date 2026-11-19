#!/usr/bin/env node
/**
 * Local ACP agent used by `tigercat runtime test` when the vendor binary
 * is absent. It speaks initialize, session/new, session/prompt, and
 * session/cancel. It does not start Claude Code or Codex.
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const runtime = process.env.TIGERCAT_DRY_RUN_RUNTIME ?? "dry-run";
const sessionId = `dry-run-${runtime}`;

interface Session {
  pending: AbortController | null;
}

const sessions = new Map<string, Session>();

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

const connection = acp
  .agent({ name: `tigercat-dry-run-${runtime}` })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: `tigercat-dry-run-${runtime}`, version: "0.0.0" },
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    sessions.set(sessionId, { pending: null });
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
    signal.addEventListener("abort", () => pending.abort(), { once: true });
    if (pending.signal.aborted) return { stopReason: "cancelled" as const };
    const text = promptText(params.prompt);
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `dry-run ${runtime}: ${text}` },
      },
    });
    if (pending.signal.aborted) return { stopReason: "cancelled" as const };
    return { stopReason: "end_turn" as const };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.pending?.abort();
  })
  .connect(stream);

await connection.closed;

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
