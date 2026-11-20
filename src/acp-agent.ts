import { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as acp from "@agentclientprotocol/sdk";
import type { Engine, IngestResult } from "./engine.js";
import type { DeliveryBindingRecord } from "./store.js";
import type { TriggerInput } from "./types.js";
import {
  CC_CONNECT_DELIVERY_GAP,
  deliverViaCcConnect,
  planCcConnectDelivery,
  workerResultText,
} from "./upstream-delivery.js";
import { destinationIdentity, DurableDeliveryService, type DurableDeliveryTarget } from "./durable-delivery.js";
import { VERSION } from "./version.js";

interface UpstreamSession {
  pending: AbortController | null;
  mcp: Client[];
}

interface DeliveryBinding {
  bindingId: string;
  destinationId: string;
  target: DurableDeliveryTarget;
  baseline: number;
}

/** Process-local hook feeding a SQLite outbox. The target is captured when a
 * prompt is accepted, so a later restart cannot accidentally use new env. */
class AcpDeliveryManager {
  private readonly bindings = new Map<string, DeliveryBinding[]>();
  private readonly handledEvents = new Set<string>();
  private readonly consumedBindings = new Set<string>();
  private readonly outbox: DurableDeliveryService;
  private readonly unsubscribe: () => void;

  constructor(private readonly engine: Engine) {
    this.outbox = new DurableDeliveryService(engine.store, {
      send: async ({ text, target }) => {
        const env: NodeJS.ProcessEnv = {
          ...target,
        };
        const plan = planCcConnectDelivery(env);
        if (!plan.ok) return { disposition: "not_sent", reason: plan.reason };
        const outcome = await deliverViaCcConnect(text, env);
        // cc-connect's non-zero exit can happen after it accepted the body;
        // preserve that uncertainty instead of blindly sending a duplicate.
        return {
          disposition: outcome.delivered ? "delivered" : "unknown",
          reason: outcome.reason,
        };
      },
    }, { clock: engine.clock });
    this.unsubscribe = engine.addHook((event) => {
      if (event.type !== "worker.turn_end" && event.type !== "worker.error") return;
      void this.routeEvent(event).catch(() => undefined);
    });
  }

  async start(): Promise<void> {
    await this.outbox.start();
    // Restore route watches before replaying terminal events. This covers a
    // process that died after a prompt was accepted but before its result.
    for (const binding of await this.engine.store.listDeliveryBindings()) this.remember(binding);
    for (const event of await this.engine.events()) {
      if (event.type === "worker.turn_end" || event.type === "worker.error") await this.routeEvent(event, false);
    }
    // Pending sends have their destination snapshot in SQLite, so reconnect
    // recovery can retry proven-not-sent work without consulting new env.
    await this.outbox.pump();
  }

  async bind(workerIds: string[], target: DurableDeliveryTarget, baseline: Map<string, number>, intentId: string): Promise<void> {
    const destinationId = Object.keys(target).length === 0 ? "dst_unconfigured" : destinationIdentity(target);
    for (const workerId of workerIds) {
      const baselineSeq = baseline.get(workerId) ?? 0;
      const bindingId = `route_${intentId}_${workerId}`;
      const key = bindingKey(bindingId);
      if (this.consumedBindings.has(key)) continue;
      const binding = await this.engine.store.putDeliveryBinding({
        bindingId,
        workerId,
        destinationId,
        target: { ...target },
        baselineSeq,
        createdAt: this.engine.clock.now(),
      });
      this.remember(binding);
    }
  }

  async replay(
    events: Awaited<ReturnType<Engine["events"]>>,
    workerIds: string[],
    target: DurableDeliveryTarget,
    baseline: Map<string, number>,
    intentId: string,
    dispatch = true,
  ): Promise<void> {
    await this.bind(workerIds, target, baseline, intentId);
    const ids = new Set(workerIds);
    for (const event of events) {
      if (!ids.has(event.workerId) || (event.type !== "worker.turn_end" && event.type !== "worker.error")) continue;
      if (event.seq <= (baseline.get(event.workerId) ?? 0)) continue;
      await this.routeEvent(event, false);
    }
    if (dispatch) await this.outbox.pump();
  }

  private async routeEvent(event: Awaited<ReturnType<Engine["events"]>>[number], dispatch = true): Promise<void> {
    if (this.handledEvents.has(event.id)) return;
    let claimed = false;
    for (;;) {
      const consumed = await this.engine.store.claimDeliveryBindingAndPut({
        workerId: event.workerId,
        eventSeq: event.seq,
        eventId: event.id,
        text: workerResultText(event),
        createdAt: event.createdAt,
      });
      if (!consumed) break;
      const { binding } = consumed;
      claimed = true;
      this.forget(binding);
      this.consumedBindings.add(bindingKey(binding.bindingId));
    }
    if (claimed) {
      this.handledEvents.add(event.id);
      if (dispatch) await this.outbox.pump();
    }
  }

  private remember(binding: DeliveryBindingRecord): void {
    const entries = this.bindings.get(binding.workerId) ?? [];
    if (!entries.some((entry) => entry.bindingId === binding.bindingId)) {
      entries.push({ bindingId: binding.bindingId, destinationId: binding.destinationId, target: { ...binding.target }, baseline: binding.baselineSeq });
      entries.sort((a, b) => a.baseline - b.baseline);
    }
    this.bindings.set(binding.workerId, entries);
  }

  private forget(binding: DeliveryBindingRecord): void {
    const entries = this.bindings.get(binding.workerId);
    if (!entries) return;
    const remaining = entries.filter((entry) => entry.bindingId !== binding.bindingId);
    if (remaining.length === 0) this.bindings.delete(binding.workerId);
    else this.bindings.set(binding.workerId, remaining);
  }

  async stop(): Promise<void> {
    this.unsubscribe();
    await this.outbox.stop();
  }

  async outboxPump(): Promise<void> {
    await this.outbox.pump();
  }
}

function bindingKey(bindingId: string): string {
  return bindingId;
}

function captureCcTarget(env: NodeJS.ProcessEnv = process.env): DurableDeliveryTarget {
  const target: DurableDeliveryTarget = {};
  for (const key of ["CC_PROJECT", "CC_SESSION_KEY"]) {
    const value = env[key]?.trim();
    if (value) target[key] = value;
  }
  // Persist the executable choice too; a restart must not silently resolve a
  // different cc-connect binary from a changed PATH.
  target.TIGERCAT_CC_CONNECT_BIN = env.TIGERCAT_CC_CONNECT_BIN?.trim() || "cc-connect";
  return target;
}

/** Stable optional provider identity carried by the ACP host. */
export function triggerFromAcpPrompt(params: acp.PromptRequest, receivedAt: number): TriggerInput {
  const meta = params._meta ?? {};
  const eventId = meta.event_id;
  const timestamp = meta.timestamp;
  if (eventId !== undefined && (typeof eventId !== "string" || eventId.trim() === "")) {
    throw acp.RequestError.invalidParams({ field: "_meta.event_id" }, "_meta.event_id must be a non-empty string");
  }
  if (timestamp !== undefined && (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0)) {
    throw acp.RequestError.invalidParams({ field: "_meta.timestamp" }, "_meta.timestamp must be a finite non-negative number");
  }
  const text = params.prompt
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
  return {
    ...(typeof eventId === "string" ? { id: eventId } : {}),
    source: "acp",
    thread: typeof meta.thread_id === "string" ? meta.thread_id : `acp:${params.sessionId}`,
    author: typeof meta.author === "string" ? meta.author : "user",
    kind: typeof meta.kind === "string" ? meta.kind : "im.message",
    isBot: meta.is_bot === true,
    text: text || "(empty)",
    // A stable event without an external timestamp must remain identical on
    // retry. receivedAt is only an identity-free submission's default.
    timestamp: timestamp ?? (eventId === undefined ? receivedAt : 0),
    replyTo: null,
  };
}

/**
 * TigerCat as an upstream ACP agent on stdio (`tigercat acp`).
 * Each prompt becomes a Trigger. The default rules treat `source=acp`
 * as respond; fixture channels keep their own policy.
 */
export async function serveUpstream(engine: Engine): Promise<void> {
  const sessions = new Map<string, UpstreamSession>();
  const deliveries = new AcpDeliveryManager(engine);
  await deliveries.start();
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
      const startedAt = Date.now();
      const input = triggerFromAcpPrompt(params, startedAt);
      const deliveryIntentId = input.id ?? globalThis.crypto.randomUUID();
      const target = captureCcTarget();
      const beforeEvents = await engine.events();
      const baseline = new Map<string, number>();
      for (const event of beforeEvents) baseline.set(event.workerId, Math.max(baseline.get(event.workerId) ?? 0, event.seq));
      session.pending?.abort();
      const pending = new AbortController();
      session.pending = pending;
      const onAbort = () => pending.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await engine.ingest(input);
        // Persist the route watch before waiting for Worker execution. If the
        // process dies before turn_end, restart can still claim the eventual
        // error/result with this prompt's original target.
        await deliveries.bind(result.deliveredTo, target, baseline, deliveryIntentId);
        await engine.settle();
        if (pending.signal.aborted) {
          return { stopReason: "cancelled" as const };
        }
        const afterEvents = await engine.events();
        const relevantWorkers = relevantWorkerIds(result, afterEvents, baseline);
        await deliveries.replay(afterEvents, relevantWorkers, target, baseline, deliveryIntentId, false);
        const reply = await formatUpstreamReply(engine, result, startedAt, target, baseline);
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: reply },
          },
        });
        // Return the ACP prompt before cc-connect performs its separate send.
        // Hook-delivered future results are already dispatched asynchronously.
        setTimeout(() => { void deliveries.outboxPump(); }, 0);
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
      void closeSessions(sessions).finally(() => deliveries.stop()).finally(() => process.exit(0));
    };
    process.stdin.once("end", stop);
    process.stdin.once("close", stop);
    void connection.closed.then(stop);
  });
}

/**
 * Text for the still-open ACP prompt. A Worker that already finished is
 * included here, which cc-connect forwards as this turn's Feishu reply.
 * A Worker that has not finished is not invented. Its later result is
 * not part of this prompt.
 */
export async function formatUpstreamReply(
  engine: Engine,
  result: IngestResult,
  startedAt: number,
  env: NodeJS.ProcessEnv = process.env,
  baseline?: Map<string, number>,
): Promise<string> {
  if (result.action === "ignore") return "Ignored by the admission rules.";
  const events = await engine.events();
  const end = [...events].reverse().find((event) => event.type === "coordinator.turn_end" && event.seq > (baseline?.get(event.workerId) ?? -1));
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
  const ids = relevantWorkerIds(result, events, baseline);
  if (ids.length === 0) return text;
  const notes = ids.map((id) => {
    const turn = [...events].reverse().find((event) => event.type === "worker.turn_end" && event.workerId === id && event.seq > (baseline?.get(id) ?? -1));
    const failure = [...events].reverse().find((event) => event.type === "worker.error" && event.workerId === id && event.seq > (baseline?.get(id) ?? -1));
    if (turn) return `Worker ${id} finished: ${workerNote(turn.payload)}`;
    if (failure) return `Worker ${id} failed: ${workerNote(failure.payload)}`;
    const plan = planCcConnectDelivery(env);
    if (plan.ok) {
      return `Worker ${id} is still running. This prompt is returning so another message can be accepted. The result is sent afterwards with cc-connect send.`;
    }
    return `Worker ${id} is still running. This prompt is returning. The result will not reach Feishu. ${CC_CONNECT_DELIVERY_GAP}`;
  });
  return [text, ...notes].join("\n");
}

function relevantWorkerIds(result: IngestResult, events: Awaited<ReturnType<Engine["events"]>>, baseline?: Map<string, number>): string[] {
  const ids = new Set(result.deliveredTo);
  for (const event of events) {
    if (event.type !== "worker.spawned") continue;
    if (event.seq > (baseline?.get(event.workerId) ?? -1)) ids.add(event.workerId);
  }
  return [...ids];
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
