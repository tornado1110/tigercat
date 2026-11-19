import { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as acp from "@agentclientprotocol/sdk";
import type { Engine, IngestResult } from "./engine.js";
import { VERSION } from "./version.js";

interface UpstreamSession {
  pending: AbortController | null;
  mcp: Client[];
}

/**
 * TigerCat as an upstream ACP agent on stdio (`tigercat acp`).
 * Each prompt becomes a Trigger. The default rules treat `source=acp`
 * as respond; fixture channels keep their own policy.
 */
export async function serveUpstream(engine: Engine): Promise<void> {
  const sessions = new Map<string, UpstreamSession>();
  process.stdin.resume();
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const connection = acp
    .agent({ name: "tigercat" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      authMethods: [],
      agentInfo: { name: "tigercat", version: VERSION },
    }))
    .onRequest(acp.methods.agent.authenticate, () => ({}))
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      if (!isAbsolute(params.cwd)) {
        throw acp.RequestError.invalidParams({ cwd: params.cwd }, "cwd must be an absolute path");
      }
      const sessionId = globalThis.crypto.randomUUID();
      const mcp = await connectProvidedMcp(params.mcpServers);
      sessions.set(sessionId, { pending: null, mcp });
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal }) => {
      const session = sessions.get(params.sessionId);
      if (!session) throw acp.RequestError.sessionNotFound(params.sessionId);
      session.pending?.abort();
      const pending = new AbortController();
      session.pending = pending;
      const onAbort = () => pending.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const text = params.prompt
          .map((block) => (block.type === "text" ? block.text : ""))
          .filter(Boolean)
          .join("\n");
        const meta = (params._meta ?? {}) as { thread_id?: string; author?: string; kind?: string; is_bot?: boolean };
        const startedAt = Date.now();
        const result = await engine.ingest({
          source: "acp",
          thread: typeof meta.thread_id === "string" ? meta.thread_id : `acp:${params.sessionId}`,
          author: typeof meta.author === "string" ? meta.author : "user",
          kind: typeof meta.kind === "string" ? meta.kind : "im.message",
          isBot: meta.is_bot === true,
          text: text || "(empty)",
          timestamp: startedAt,
          replyTo: null,
        });
        await engine.settle();
        if (pending.signal.aborted) return { stopReason: "cancelled" as const };
        const reply = await formatUpstreamReply(engine, result, startedAt);
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: reply },
          },
        });
        if (pending.signal.aborted) return { stopReason: "cancelled" as const };
        return { stopReason: "end_turn" as const };
      } finally {
        if (session.pending === pending) session.pending = null;
      }
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.pending?.abort();
    })
    .onRequest("*", (ctx) => {
      throw acp.RequestError.methodNotFound(ctx.method);
    })
    .connect(stream);

  // acp-tck v0.4.0 kills a leftover agent with os.killpg, which does not
  // exist on Windows. Exit ourselves when the client closes stdin, and
  // drop MCP children first so they cannot keep the process alive.
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      resolve();
      const force = setTimeout(() => process.exit(0), 500);
      if (typeof force.unref === "function") force.unref();
      void closeSessions(sessions).finally(() => process.exit(0));
    };
    process.stdin.once("end", stop);
    process.stdin.once("close", stop);
    void connection.closed.then(stop);
  });
}

/**
 * Text returned on the still-open ACP prompt. A Router error is the text.
 * A Worker that has not finished is named as unfinished. Nothing here
 * invents a model result. Set TIGERCAT_UPSTREAM_WAIT_MS to wait for the
 * Worker turn before the prompt returns; 0 does not wait.
 */
export async function formatUpstreamReply(
  engine: Engine,
  result: IngestResult,
  startedAt: number,
): Promise<string> {
  if (result.action === "ignore") return "Ignored by the admission rules.";
  const events = await engine.events();
  const end = [...events].reverse().find((event) => event.type === "coordinator.turn_end");
  let text: string;
  if (end?.payload.stopReason === "error") {
    text = `Router failed: ${String(end.payload.message ?? "unknown error")}`;
  } else if (typeof end?.payload.reply === "string" && end.payload.reply.length > 0) {
    text = end.payload.reply;
  } else if (result.router) {
    text = "Routed to the resident Router.";
  } else {
    text = `Delivered to ${result.deliveredTo.length} worker(s).`;
  }
  const waitMs = Number(process.env.TIGERCAT_UPSTREAM_WAIT_MS ?? "0");
  const workers = (await engine.workers()).filter((worker) => worker.createdAt >= startedAt - 50);
  const ids = [...new Set([...result.deliveredTo, ...workers.map((worker) => worker.id)])];
  if (ids.length > 0 && Number.isFinite(waitMs) && waitMs > 0) {
    await engine.wait(ids, "all", waitMs);
  }
  if (ids.length === 0) return text;
  const fresh = await engine.events();
  const notes = ids.map((id) => {
    const turn = [...fresh].reverse().find((event) => event.type === "worker.turn_end" && event.workerId === id);
    const failure = [...fresh].reverse().find((event) => event.type === "worker.error" && event.workerId === id);
    if (turn) return `Worker ${id} finished: ${workerNote(turn.payload)}`;
    if (failure) return `Worker ${id} failed: ${workerNote(failure.payload)}`;
    return `Worker ${id} has not finished. No result was invented.`;
  });
  return [text, ...notes].join("\n");
}

function workerNote(payload: Record<string, unknown>): string {
  const message = payload.message ?? payload.text ?? payload.summary ?? payload.stopReason;
  return typeof message === "string" && message.length > 0 ? message : "no text";
}

async function closeSessions(sessions: Map<string, UpstreamSession>): Promise<void> {
  const closers: Array<Promise<unknown>> = [];
  for (const session of sessions.values()) {
    for (const client of session.mcp) closers.push(client.close().catch(() => undefined));
  }
  await Promise.all(closers);
}

async function connectProvidedMcp(servers: acp.McpServer[]): Promise<Client[]> {
  const clients: Client[] = [];
  for (const server of servers) {
    if (!("command" in server) || typeof server.command !== "string") continue;
    try {
      const env = { ...getDefaultEnvironment() };
      for (const variable of server.env ?? []) env[variable.name] = variable.value;
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env,
        stderr: "ignore",
      });
      const client = new Client({ name: "tigercat", version: VERSION });
      await client.connect(transport);
      clients.push(client);
    } catch {
      // session/new must still succeed if one MCP server cannot be reached
    }
  }
  return clients;
}

function isAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}
