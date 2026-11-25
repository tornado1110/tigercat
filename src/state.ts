import { TigerError } from "./errors.js";
import type { SessionState } from "./types.js";

const LEGAL: Record<SessionState, readonly SessionState[]> = {
  starting: ["running", "error", "killed", "cancelled", "interrupted", "lost"],
  running: [
    "idle",
    "awaiting_input",
    "stalled",
    "cancelled",
    "error",
    "killed",
    "finished",
    "interrupted",
    "lost",
  ],
  idle: ["running", "killed", "finished", "error", "interrupted", "cancelled", "lost"],
  awaiting_input: ["running", "killed", "error", "cancelled", "interrupted", "idle", "lost"],
  stalled: ["killed", "error", "cancelled", "interrupted"],
  cancelled: ["killed", "finished"],
  error: ["killed"],
  killed: [],
  finished: ["killed"],
  interrupted: ["killed", "running", "starting"],
  lost: ["killed", "starting"],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return LEGAL[from].includes(to);
}

export function assertTransition(from: SessionState, to: SessionState): void {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw new TigerError(
      "illegal_transition",
      `illegal session transition ${from} -> ${to}`,
    );
  }
}

export function isTerminal(state: SessionState): boolean {
  return (
    state === "killed" ||
    state === "finished" ||
    state === "error" ||
    state === "cancelled" ||
    state === "interrupted" ||
    state === "lost" ||
    state === "stalled"
  );
}

export function acceptsSend(state: SessionState): boolean {
  return state === "idle" || state === "awaiting_input" || state === "running" || state === "starting";
}
