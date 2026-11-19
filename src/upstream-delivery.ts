import { spawn } from "node:child_process";
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
    child.stdin?.end(message);
  });
}

export function workerResultText(event: TigerEvent): string {
  if (event.type === "worker.error") {
    const message = event.payload.message;
    return `Worker ${event.workerId} failed: ${typeof message === "string" && message.length > 0 ? message : "error"}`;
  }
  const summary = event.payload.summary;
  if (typeof summary === "string" && summary.length > 0) return summary;
  return `Worker ${event.workerId} finished with no text.`;
}

/**
 * Buffers Worker results until the ACP prompt handler has returned.
 * Delivery before release would still be inside session/prompt.
 */
export function createWorkerResultRelay(
  engine: Engine,
  deliver: (text: string) => Promise<DeliveryOutcome>,
): { watch(ids: string[]): void; release(): void; stop(): void } {
  const watched = new Set<string>();
  const buffered = new Map<string, string>();
  const sent = new Set<string>();
  let released = false;
  const stop = engine.addHook((event) => {
    if (event.type !== "worker.turn_end" && event.type !== "worker.error") return;
    const text = workerResultText(event);
    if (!released || !watched.has(event.workerId)) {
      buffered.set(event.workerId, text);
      return;
    }
    void send(event.workerId, text);
  });

  const send = (id: string, text: string): void => {
    if (sent.has(id)) return;
    sent.add(id);
    void deliver(text).catch(() => undefined);
    if ([...watched].every((watchedId) => sent.has(watchedId))) stop();
  };

  return {
    watch(ids: string[]) {
      for (const id of ids) watched.add(id);
    },
    release() {
      released = true;
      for (const id of watched) {
        const text = buffered.get(id);
        if (text !== undefined) send(id, text);
      }
    },
    stop,
  };
}
