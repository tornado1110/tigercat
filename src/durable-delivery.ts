import { createHash } from "node:crypto";
import type { Clock, ClockTimer } from "./clock.js";
import { SystemClock } from "./clock.js";
import type { DeliveryRecord, Store } from "./store.js";

export type TransportDisposition = "delivered" | "not_sent" | "unknown";

export interface DurableDeliveryTarget {
  /** Values are captured by the trusted host process; model/user text never supplies these. */
  [key: string]: string;
}

export interface DurableDeliveryTransport {
  send(input: {
    text: string;
    target: DurableDeliveryTarget;
    eventId: string;
    workerId: string;
    attempt: number;
  }): Promise<{ disposition: TransportDisposition; reason: string }>;
}

export interface DurableDeliveryOptions {
  clock?: Clock;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Called after every state transition; errors are ignored. */
  onState?: (record: DeliveryRecord) => void | Promise<void>;
}

/**
 * SQLite-backed at-least-once delivery with an explicit unknown outcome.
 * An `unknown` transport result is persisted as `uncertain` and is never
 * retried automatically: callers must reconcile it with the provider.
 */
export class DurableDeliveryService {
  private readonly clock: Clock;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly onState?: DurableDeliveryOptions["onState"];
  private started = false;
  private pumping: Promise<void> | null = null;
  private timer: ClockTimer | null = null;

  constructor(private readonly store: Store, private readonly transport: DurableDeliveryTransport, options: DurableDeliveryOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
    this.retryBaseMs = Math.max(1, Math.floor(options.retryBaseMs ?? 1_000));
    this.retryMaxMs = Math.max(this.retryBaseMs, Math.floor(options.retryMaxMs ?? 60_000));
    this.onState = options.onState;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // A process that died after claiming a row cannot prove whether the
    // provider observed it. Keep the fact instead of silently duplicating it.
    await this.store.recoverInflightDeliveries(this.clock.now());
  }

  async enqueue(input: {
    eventId: string;
    workerId: string;
    text: string;
    target: DurableDeliveryTarget;
    destinationId?: string;
    createdAt?: number;
  }): Promise<DeliveryRecord> {
    await this.start();
    const destinationId = input.destinationId ?? destinationIdentity(input.target);
    return this.store.putDelivery({
      eventId: input.eventId,
      destinationId,
      workerId: input.workerId,
      text: input.text,
      target: input.target,
      createdAt: input.createdAt ?? this.clock.now(),
    });
  }

  async pump(): Promise<void> {
    await this.start();
    if (this.pumping) return this.pumping;
    this.pumping = this.pumpLoop().finally(() => { this.pumping = null; });
    return this.pumping;
  }

  async retry(eventId: string, destinationId: string): Promise<boolean> {
    const row = await this.store.getDelivery(eventId, destinationId);
    if (!row || row.status !== "failed") return false;
    await this.store.updateDelivery({
      eventId,
      destinationId,
      status: "retrying",
      nextAttemptAt: this.clock.now(),
      lastError: null,
      updatedAt: this.clock.now(),
    });
    await this.pump();
    return true;
  }

  async reconcile(eventId: string, destinationId: string, disposition: "delivered" | "not_sent"): Promise<boolean> {
    const row = await this.store.getDelivery(eventId, destinationId);
    if (!row || row.status !== "uncertain") return false;
    if (disposition === "delivered") {
      await this.store.updateDelivery({ eventId, destinationId, status: "delivered", nextAttemptAt: null, updatedAt: this.clock.now() });
      return true;
    }
    await this.store.updateDelivery({ eventId, destinationId, status: "retrying", nextAttemptAt: this.clock.now(), updatedAt: this.clock.now() });
    await this.pump();
    return true;
  }

  async snapshot(): Promise<DeliveryRecord[]> {
    return this.store.listDeliveries();
  }

  async stop(): Promise<void> {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    await this.pumping;
  }

  private async pumpLoop(): Promise<void> {
    const due = await this.store.listDeliveries({ statuses: ["pending", "retrying"], dueAt: this.clock.now() });
    for (const candidate of due) {
      const row = await this.store.claimDelivery(candidate.eventId, candidate.destinationId, this.clock.now());
      if (!row) continue;
      await this.emit(row);
      let outcome: { disposition: TransportDisposition; reason: string };
      try {
        outcome = await this.transport.send({
          text: row.text,
          target: row.target,
          eventId: row.eventId,
          workerId: row.workerId,
          attempt: row.attempts,
        });
      } catch (error) {
        outcome = { disposition: "unknown", reason: safeReason(error) };
      }
      const now = this.clock.now();
      if (outcome.disposition === "delivered") {
        await this.store.updateDelivery({ eventId: row.eventId, destinationId: row.destinationId, status: "delivered", nextAttemptAt: null, lastError: null, updatedAt: now });
      } else if (outcome.disposition === "not_sent" && row.attempts < this.maxAttempts) {
        const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, row.attempts - 1));
        await this.store.updateDelivery({ eventId: row.eventId, destinationId: row.destinationId, status: "retrying", nextAttemptAt: now + delay, lastError: safeReason(outcome.reason), updatedAt: now });
      } else if (outcome.disposition === "not_sent") {
        await this.store.updateDelivery({ eventId: row.eventId, destinationId: row.destinationId, status: "failed", nextAttemptAt: null, lastError: safeReason(outcome.reason), updatedAt: now });
      } else {
        await this.store.updateDelivery({ eventId: row.eventId, destinationId: row.destinationId, status: "uncertain", nextAttemptAt: null, lastError: safeReason(outcome.reason), updatedAt: now });
      }
      const changed = await this.store.getDelivery(row.eventId, row.destinationId);
      if (changed) await this.emit(changed);
    }
    const next = await this.store.listDeliveries({ statuses: ["retrying"], dueAt: Number.MAX_SAFE_INTEGER });
    const future = next
      .map((row) => row.nextAttemptAt)
      .filter((at): at is number => at !== null && at > this.clock.now())
      .sort((a, b) => a - b)[0];
    if (future !== undefined && !this.timer) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        void this.pump();
      }, Math.max(0, future - this.clock.now()));
    }
  }

  private async emit(record: DeliveryRecord): Promise<void> {
    try { await this.onState?.(record); } catch { /* observers cannot affect delivery */ }
  }
}

export function destinationIdentity(target: DurableDeliveryTarget): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(target).sort(([a], [b]) => a.localeCompare(b))));
  return `dst_${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}

function safeReason(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/((?:token|secret|password|api[_-]?key|session[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 500) || "unknown delivery error";
}

