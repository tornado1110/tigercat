import { spawn } from "node:child_process";
import type { Clock, ClockTimer } from "./clock.js";
import type { Engine } from "./engine.js";
import type { TigerEvent } from "./types.js";

export interface DeliveryOutcome {
  delivered: boolean;
  reason: string;
}

export interface DeliveryPlan {
  ok: boolean;
  command?: string;
  args?: string[];
  reason: string;
}

export interface WorkerDeliveryContext {
  eventId: string;
  workerId: string;
  attempt: number;
}

export interface WorkerDeliveryState extends WorkerDeliveryContext {
  status: "buffered" | "pending" | "delivering" | "retrying" | "delivered" | "failed";
  reason?: string;
  nextAttemptAt?: number;
}

export interface WorkerResultRelayOptions {
  clock?: Clock;
  /** Keep watching later turns. Use one persistent relay per destination. */
  persistent?: boolean;
  /** Total automatic attempts, including the first send. */
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Diagnostic observer. Its failure never changes a delivery outcome. */
  onOutcome?: (state: WorkerDeliveryState) => void | Promise<void>;
}

export interface WorkerResultRelay {
  watch(ids: string[]): void;
  release(): void;
  stop(): void;
  /** Failed notices remain visible and can be retried explicitly. */
  retry(eventId: string): boolean;
  snapshot(): WorkerDeliveryState[];
}

/**
 * cc-connect posts to the chat with `cc-connect send`, which reads
 * CC_PROJECT and CC_SESSION_KEY from the environment and POSTs to the
 * daemon's unix socket `/send`. That socket calls platform.Send.
 * A session/update after session/prompt has returned does not: the
 * unsolicited reader holds EventText until EventResult, and the ACP
 * adapter emits EventResult only when session/prompt returns.
 */
export const CC_CONNECT_DELIVERY_GAP =
  "CC_SESSION_KEY is unset. cc-connect injects it when it starts the ACP agent. " +
  "A session/update after session/prompt returns is not a Feishu send: " +
  "cc-connect buffers that text until an EventResult, and its ACP adapter emits EventResult only when session/prompt returns.";

export function planCcConnectDelivery(env: NodeJS.ProcessEnv): DeliveryPlan {
  const session = env.CC_SESSION_KEY?.trim() ?? "";
  if (!session) return { ok: false, reason: CC_CONNECT_DELIVERY_GAP };
  const command = env.TIGERCAT_CC_CONNECT_BIN?.trim() || "cc-connect";
  return {
    ok: true,
    command,
    args: ["send", "--stdin"],
    reason: "cc-connect send --stdin inherits CC_SESSION_KEY and does not put the message on the command line.",
  };
}

export function deliverViaCcConnect(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeliveryOutcome> {
  const plan = planCcConnectDelivery(env);
  if (!plan.ok || !plan.command || !plan.args) return Promise.resolve({ delivered: false, reason: plan.reason });
  const script = plan.command.endsWith(".js");
  const command = script ? process.execPath : plan.command;
  const args = script ? [plan.command, ...plan.args] : plan.args;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: DeliveryOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const child = spawn(command, args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        delivered: false,
        reason: `cc-connect send could not start (${error.code ?? error.name}).`,
      });
    });
    child.on("close", (code) => {
      finish({
        delivered: code === 0,
        reason: code === 0 ? "cc-connect send exited 0." : `cc-connect send exited ${code ?? "null"}.`,
      });
    });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      finish({ delivered: false, reason: `cc-connect send stdin failed (${error.code ?? error.name}).` });
    });
    child.stdin?.end(message);
  });
}

export function workerResultText(event: TigerEvent): string {
  if (event.type === "worker.error") {
    const message = event.payload.message;
    return `Worker ${event.workerId} failed: ${typeof message === "string" && message.length > 0 ? message : "error"}`;
  }
  const text = event.payload.text;
  if (typeof text === "string" && text.length > 0) return `Worker ${event.workerId} finished: ${text}`;
  const summary = event.payload.summary;
  if (typeof summary === "string" && summary.length > 0) return summary;
  return `Worker ${event.workerId} finished with no text.`;
}

/**
 * Buffers Worker results until the caller releases delivery.
 * By default it detaches once each watched Worker has a delivered result.
 * A persistent relay observes later turns until stop(); callers must own one
 * persistent relay per delivery destination rather than one per prompt.
 *
 * Event ids, not Worker ids, identify notices. Only successful sends are
 * acknowledged; failures retry with bounded backoff and remain inspectable
 * after exhaustion. This is an in-memory, at-least-once relay: restart recovery
 * needs a durable outbox, and a transport must dedupe eventId if a send can be
 * accepted before its acknowledgement is lost.
 */
export function createWorkerResultRelay(
  engine: Pick<Engine, "addHook" | "clock">,
  deliver: (text: string, context: WorkerDeliveryContext) => Promise<DeliveryOutcome>,
  options: WorkerResultRelayOptions = {},
): WorkerResultRelay {
  const clock = options.clock ?? engine.clock;
  const maxAttempts = options.maxAttempts ?? 5;
  const retryBaseMs = options.retryBaseMs ?? 1_000;
  const retryMaxMs = options.retryMaxMs ?? 60_000;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new RangeError("maxAttempts must be an integer between 1 and 100");
  }
  if (!Number.isFinite(retryBaseMs) || retryBaseMs <= 0 || !Number.isFinite(retryMaxMs) || retryMaxMs < retryBaseMs) {
    throw new RangeError("retry delays must be finite, positive, and retryMaxMs must be at least retryBaseMs");
  }
  const watched = new Set<string>();
  const notices = new Map<string, { state: WorkerDeliveryState; text: string; timer?: ClockTimer }>();
  let released = false;
  let stopped = false;

  const detachIfComplete = (): void => {
    if (options.persistent || watched.size === 0) return;
    const states = [...notices.values()]
      .filter((notice) => watched.has(notice.state.workerId))
      .map((notice) => notice.state);
    if ([...watched].some((id) => !states.some((state) => state.workerId === id && state.status === "delivered"))) return;
    if (states.some((state) => state.status !== "delivered")) return;
    stopped = true;
    removeHook();
  };

  const observe = (state: WorkerDeliveryState): void => {
    try {
      const observation = options.onOutcome?.({ ...state });
      if (observation) void observation.catch(() => undefined);
    } catch {
      // An observer must never turn a successful send into a retry.
    }
  };

  const send = async (eventId: string): Promise<void> => {
    const notice = notices.get(eventId);
    if (stopped || !released || !notice || !watched.has(notice.state.workerId)) return;
    if (notice.state.status !== "pending") return;
    notice.state = {
      ...notice.state,
      status: "delivering",
      attempt: notice.state.attempt + 1,
      nextAttemptAt: undefined,
    };
    const context = { eventId, workerId: notice.state.workerId, attempt: notice.state.attempt };
    let outcome: DeliveryOutcome;
    try {
      outcome = await deliver(notice.text, context);
    } catch (error) {
      // Transport error bodies can contain credentials; retain only the class.
      outcome = { delivered: false, reason: `Delivery failed (${error instanceof Error ? error.name : "unknown error"}).` };
    }
    if (outcome.delivered) {
      notice.state = { ...notice.state, status: "delivered", reason: outcome.reason };
    } else if (stopped || notice.state.attempt >= maxAttempts) {
      notice.state = { ...notice.state, status: "failed", reason: outcome.reason };
    } else {
      const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** (notice.state.attempt - 1));
      notice.state = {
        ...notice.state,
        status: "retrying",
        reason: outcome.reason,
        nextAttemptAt: clock.now() + delay,
      };
      notice.timer = clock.setTimeout(() => {
        notice.timer = undefined;
        notice.state = { ...notice.state, status: "pending", nextAttemptAt: undefined };
        void send(eventId);
      }, delay);
    }
    observe(notice.state);
    detachIfComplete();
  };

  const dispatch = (): void => {
    if (stopped || !released) return;
    for (const [eventId, notice] of notices) {
      if (!watched.has(notice.state.workerId) || notice.state.status !== "buffered") continue;
      notice.state = { ...notice.state, status: "pending" };
      void send(eventId);
    }
  };

  const removeHook = engine.addHook((event) => {
    if (stopped) return;
    if (event.type !== "worker.turn_end" && event.type !== "worker.error") return;
    if (notices.has(event.id)) return;
    notices.set(event.id, {
      state: { eventId: event.id, workerId: event.workerId, attempt: 0, status: "buffered" },
      text: workerResultText(event),
    });
    dispatch();
  });

  return {
    watch(ids: string[]) {
      if (stopped) return;
      for (const id of ids) watched.add(id);
      dispatch();
    },
    release() {
      if (stopped) return;
      released = true;
      dispatch();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      removeHook();
      for (const notice of notices.values()) {
        if (notice.timer) clock.clearTimeout(notice.timer);
        notice.timer = undefined;
        if (notice.state.status !== "delivered" && notice.state.status !== "delivering") {
          notice.state = {
            ...notice.state,
            status: "failed",
            reason: notice.state.reason ?? "Relay stopped before delivery.",
            nextAttemptAt: undefined,
          };
        }
      }
    },
    retry(eventId) {
      const notice = notices.get(eventId);
      if (stopped || !released || !notice || notice.state.status !== "failed" || !watched.has(notice.state.workerId)) return false;
      notice.state = { ...notice.state, status: "pending" };
      void send(eventId);
      return true;
    },
    snapshot() {
      return [...notices.values()].map((notice) => ({ ...notice.state }));
    },
  };
}
