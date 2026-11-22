import { createHash } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discoverRuntimes, resolveRuntime } from "./builtins.js";
import { SystemClock } from "./clock.js";
import { configPath, loadConfig } from "./config.js";
import { DurableDeliveryService, type DurableDeliveryTarget, type DurableDeliveryTransport } from "./durable-delivery.js";
import { Engine } from "./engine.js";
import { TigerError } from "./errors.js";
import { ProcessRuntimeFactory } from "./runtime.js";
import { acceptsSend } from "./state.js";
import { SqliteStore } from "./store.js";
import type { TigerEvent } from "./types.js";

export interface ImMessage {
  id: string;
  conversation: string;
  text: string;
  /** Provider destination identifiers only. This object is stored in SQLite. */
  replyTarget: DurableDeliveryTarget;
}

interface ActiveTurn {
  workerId: string;
  result: Promise<TigerEvent | undefined>;
}

interface ImLiveTurns {
  working(target: DurableDeliveryTarget): Promise<(success: boolean) => Promise<void>>;
}

export class ImChannel {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly pending = new Set<Promise<void>>();
  private readonly admissions = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private readonly outbox: DurableDeliveryService;
  private deliveryQueue = Promise.resolve();

  constructor(
    private readonly engine: Engine,
    private readonly source: string,
    private readonly runtime: string,
    transport: DurableDeliveryTransport,
    private readonly report: (message: string) => void,
    private readonly liveTurns?: ImLiveTurns,
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
    const key = message.conversation;
    // Only admission is ordered. Each message observes its own turn outside this lock.
    const previous = this.admissions.get(key) ?? Promise.resolve();
    let finish: Promise<((success: boolean) => Promise<void>) | undefined> | undefined;
    const receipt = this.engine.store.claimIngress({
      source: this.source,
      externalId: message.id,
      fingerprint: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
      triggerId: `${this.source}:${message.id}`,
      createdAt: this.engine.clock.now(),
    }).then(({ claimed, receipt }) => {
      if (!claimed) return;
      // Start the receipt immediately, even if admission or Worker startup takes time.
      // The provider's reaction API must not hold up execution.
      finish = this.liveTurns?.working(message.replyTarget).catch(() => {
        this.report("IM 处理状态更新失败。");
        return undefined;
      });
      return receipt.triggerId;
    });
    const admitted = Promise.all([previous, receipt]).then(([, id]) => id ? this.admit(message, id) : undefined);
    const release = admitted.then(() => {}, () => {}).finally(() => {
      if (this.admissions.get(key) === release) this.admissions.delete(key);
    });
    this.admissions.set(key, release);
    const task = admitted.then((deliver) => deliver?.()).catch(() => {
      this.report("IM 消息处理失败，请检查 TigerCat 状态。");
      return false;
    }).then(async (success) => {
      const update = await finish;
      await update?.(success === true);
    }).catch(() => this.report("IM 处理状态更新失败。")).finally(() => this.pending.delete(task));
    this.pending.add(task);
    return task;
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.all(this.pending);
    await this.outbox.stop();
  }

  private async admit(message: ImMessage, eventId: string): Promise<(() => Promise<boolean>) | undefined> {
    if (this.abort.signal.aborted) return;
    const store = this.engine.store;
    let workerId = "";
    const reply = (text: string) => this.deliver(eventId, workerId, message.replyTarget, text);
    try {
      const turn = this.active.get(message.conversation);
      if (turn) {
        workerId = turn.workerId;
        if (this.liveTurns && await this.joinTurn(message, turn)) {
          return async () => turnSucceeded(await turn.result);
        }
        await turn.result;
        if (this.abort.signal.aborted) return;
      }
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
      const result = this.waitForResult(workerId, baseline).finally(() => {
        this.active.delete(message.conversation);
      });
      this.active.set(message.conversation, { workerId, result });
      return async () => {
        const event = await result;
        if (event) await reply(resultText(event));
        return turnSucceeded(event);
      };
    } catch (error) {
      if (this.abort.signal.aborted) return;
      const text = error instanceof TigerError && error.code === "max_concurrency"
        ? "Worker 已满，请稍后重新发消息。"
        : "TigerCat 未能确认这条消息的处理状态，请检查本地 Worker。";
      return async () => {
        await reply(text);
        return false;
      };
    }
  }

  private async joinTurn(message: ImMessage, turn: ActiveTurn): Promise<boolean> {
    // The Worker or its native prompt may still be starting. Only retry an
    // explicit no-running-turn response; a lost acknowledgement may mean it ran.
    const deadline = Date.now() + 45_000;
    let retryMs = 100;
    while (this.active.get(message.conversation) === turn && !this.abort.signal.aborted) {
      const outcome = await this.engine.steer(turn.workerId, message.text, this.abort.signal);
      if (outcome === "injected") return true;
      if (outcome === "unsupported" || Date.now() >= deadline) break;
      await delay(retryMs, undefined, { signal: this.abort.signal });
      retryMs = Math.min(retryMs * 2, 1_500);
    }
    return false;
  }

  private async deliver(eventId: string, workerId: string, target: DurableDeliveryTarget, text: string): Promise<void> {
    // Serialize enqueue-and-pump so an enqueue cannot miss the last
    // in-flight pump's snapshot of pending deliveries.
    const delivery = this.deliveryQueue.then(async () => {
      await this.outbox.enqueue({ eventId, workerId, text, target });
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
      && (event.type === "worker.turn_end" || event.type === "worker.error" || event.type === "worker.stalled"
        || (event.type === "worker.update" && event.payload.state === "killed"));
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

function turnSucceeded(event: TigerEvent | undefined): boolean {
  return event?.type === "worker.turn_end" && event.payload.stopReason === "end_turn";
}

function resultText(event: TigerEvent): string {
  if (event.type === "worker.error") return "Worker 执行失败，请检查 TigerCat 日志。";
  if (event.type === "worker.stalled") return "Worker 长时间没有响应，请重新发消息。";
  if (event.type === "worker.update" || event.payload.stopReason === "cancelled") return "Worker 本轮已取消。";
  const text = event.payload.text;
  return typeof text === "string" && text.trim() ? text : "Worker 本轮没有返回文本。";
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
  localWorkerDefault?: boolean;
  transport: DurableDeliveryTransport;
  liveTurns?: ImLiveTurns;
  secrets: Record<string, string>;
  connect: (receive: (message: ImMessage) => void, signal: AbortSignal) => Promise<void>;
}

export async function serveImChannel(options: ImChannelHostOptions, adapter: ImAdapter): Promise<void> {
  const file = configPath(options.configFile);
  const config = loadConfig(file);
  let runtime = options.runtime ?? config.defaultWorkerRuntime;
  if (adapter.localWorkerDefault && !options.runtime && runtime === "worker" && !config.runtimes.some((r) => r.name === runtime)) {
    const available = discoverRuntimes(config).filter((r) => r.builtin && r.vendorFound);
    const selected = available.find((r) => r.name === "codex") ?? available[0];
    if (!selected) throw new TigerError("unknown_runtime", "请安装 Codex 或 Claude Code，或通过 --runtime 指定 ACP Worker。");
    runtime = selected.name;
  }
  if (adapter.localWorkerDefault) {
    const selected = resolveRuntime(config, runtime);
    if (selected.permission === "ask") {
      config.runtimes = [{ ...selected, permission: "deny" }, ...config.runtimes];
    }
  }
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
    const active = new ImChannel(engine, adapter.source, runtime, adapter.transport, options.report, adapter.liveTurns);
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
