import { createHash } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { resolveRuntime } from "./builtins.js";
import { SystemClock } from "./clock.js";
import { configPath, loadConfig } from "./config.js";
import { DurableDeliveryService, type DurableDeliveryTarget, type DurableDeliveryTransport } from "./durable-delivery.js";
import { Engine } from "./engine.js";
import { TigerError } from "./errors.js";
import { ProcessRuntimeFactory } from "./runtime.js";
import { acceptsSend } from "./state.js";
import { SqliteStore } from "./store.js";
import type { TigerEvent } from "./types.js";
import { workerResultText } from "./upstream-delivery.js";

export interface ImMessage {
  id: string;
  conversation: string;
  text: string;
  /** Provider destination identifiers only. This object is stored in SQLite. */
  replyTarget: DurableDeliveryTarget;
}

export class ImChannel {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private readonly outbox: DurableDeliveryService;
  private deliveryQueue = Promise.resolve();

  constructor(
    private readonly engine: Engine,
    private readonly source: string,
    private readonly runtime: string,
    transport: DurableDeliveryTransport,
    private readonly report: (message: string) => void,
  ) {
    this.outbox = new DurableDeliveryService(engine.store, transport, {
      clock: engine.clock,
      onState: (delivery) => {
        if (delivery.status === "uncertain") this.report("IM 未确认消息送达，投递记录已保留。");
      },
    });
  }

  async start(): Promise<void> {
    await this.outbox.pump();
  }

  receive(message: ImMessage): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    const queue = this.queues.get(message.conversation) ?? Promise.resolve();
    const task = queue.then(() => this.handle(message)).catch(() => {
      this.report("IM 消息处理失败，请检查 TigerCat 状态。");
    }).finally(() => {
      if (this.queues.get(message.conversation) === task) this.queues.delete(message.conversation);
    });
    this.queues.set(message.conversation, task);
    return task;
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.all(this.queues.values());
    await this.outbox.stop();
  }

  private async handle(message: ImMessage): Promise<void> {
    if (this.abort.signal.aborted) return;
    const store = this.engine.store;
    // Claim before dispatching so duplicate provider messages never execute
    // the work twice, including after a process restart.
    const receipt = await store.claimIngress({
      source: this.source,
      externalId: message.id,
      fingerprint: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
      triggerId: `${this.source}:${message.id}`,
      createdAt: this.engine.clock.now(),
    });
    if (!receipt.claimed) return;

    let workerId = "";
    let text: string;
    try {
      const thread = await store.upsertThread(JSON.stringify([this.source, message.conversation]), this.source, this.engine.clock.now());
      const worker = (await store.listSessions("worker"))
        .findLast((session) => session.threadId === thread.id && session.runtime === this.runtime);
      if (this.abort.signal.aborted) return;
      let baseline = 0;
      if (worker && acceptsSend(worker.state)) {
        workerId = worker.id;
        baseline = worker.seq;
        await this.engine.send(workerId, message.text);
      } else {
        const spawned = await this.engine.spawn({ runtime: this.runtime, task: message.text, thread: thread.id });
        workerId = spawned.workerId;
      }
      const event = await this.waitForResult(workerId, baseline);
      if (!event) return;
      text = resultText(event);
    } catch (error) {
      if (this.abort.signal.aborted) return;
      text = error instanceof TigerError && error.code === "max_concurrency"
        ? "Worker 已满，请稍后重新发消息。"
        : "TigerCat 无法处理这条消息，请检查本地 Worker 配置。";
    }
    // Serialize enqueue-and-pump so an enqueue cannot miss the last
    // in-flight pump's snapshot of pending deliveries.
    const delivery = this.deliveryQueue.then(async () => {
      await this.outbox.enqueue({ eventId: receipt.receipt.triggerId, workerId, text, target: message.replyTarget });
      await this.outbox.pump();
    });
    this.deliveryQueue = delivery.catch(() => undefined);
    await delivery;
  }

  private async waitForResult(workerId: string, baseline: number): Promise<TigerEvent | undefined> {
    const signal = this.abort.signal;
    if (signal.aborted) return;
    let finish!: (event: TigerEvent | undefined) => void;
    const result = new Promise<TigerEvent | undefined>((resolve) => { finish = resolve; });
    const matches = (event: TigerEvent) => event.workerId === workerId && event.seq > baseline
      && (event.type === "worker.turn_end" || event.type === "worker.error" || event.type === "worker.stalled");
    const unsubscribe = this.engine.addHook((event) => {
      if (matches(event)) finish(event);
    });
    const onAbort = () => finish(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const existing = await this.engine.store.listEvents({ workerId, sinceSeq: baseline });
      return existing.find(matches) ?? await result;
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function resultText(event: TigerEvent): string {
  if (event.type === "worker.error") return "Worker 执行失败，请检查 TigerCat 日志。";
  if (event.type === "worker.stalled") return "Worker 长时间没有响应，请重新发消息。";
  if (event.payload.stopReason === "cancelled") return "Worker 本轮已取消。";
  return workerResultText(event);
}

export interface ImChannelHostOptions {
  cwd: string;
  configFile?: string;
  runtime?: string;
  report: (message: string) => void;
}

interface ImAdapter {
  source: string;
  databaseName: string;
  transport: DurableDeliveryTransport;
  secrets: Record<string, string>;
  connect: (receive: (message: ImMessage) => void, signal: AbortSignal) => Promise<void>;
}

export async function serveImChannel(options: ImChannelHostOptions, adapter: ImAdapter): Promise<void> {
  const file = configPath(options.configFile);
  const config = loadConfig(file);
  const runtime = options.runtime ?? config.defaultWorkerRuntime;
  if (resolveRuntime(config, runtime).permission === "ask") {
    throw new TigerError("invalid_args", "IM text sessions cannot answer ACP permission prompts. Configure the Worker with permission=deny or permission=auto.");
  }
  const workspace = await stat(options.cwd).catch(() => undefined);
  if (!workspace?.isDirectory()) throw new TigerError("invalid_args", "IM --cwd must be a directory");

  const db = path.join(path.dirname(file), adapter.databaseName);
  await mkdir(path.dirname(db), { recursive: true });
  const lockPath = `${db}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    throw new TigerError("im_already_running", "IM database is locked. Confirm the old channel process has exited before removing its .lock file.");
  });
  let store: SqliteStore | undefined;
  let engine: Engine | undefined;
  let channel: ImChannel | undefined;
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await lock.writeFile(`${process.pid}\n`);
    store = SqliteStore.open(db);
    engine = new Engine({ store, clock: new SystemClock(), config, factory: new ProcessRuntimeFactory(), workspaceRoot: options.cwd });
    for (const [name, secret] of Object.entries(adapter.secrets)) engine.noteSecret(name, secret);
    const active = new ImChannel(engine, adapter.source, runtime, adapter.transport, options.report);
    channel = active;
    await engine.start();
    await active.start();
    if (!abort.signal.aborted) {
      await adapter.connect((message) => { void active.receive(message); }, abort.signal);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      await channel?.stop();
    } finally {
      try {
        await engine?.close();
      } finally {
        try {
          await store?.close();
        } finally {
          try {
            await lock.close();
          } finally {
            await rm(lockPath, { force: true });
          }
        }
      }
    }
  }
}
