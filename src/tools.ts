import { TigerError } from "./errors.js";

/**
 * Tools exposed to the Router. This list is the enforcement point:
 * the Router MCP server registers these names and nothing else.
 * Workers get a smaller subset (subscribe, unsubscribe, read).
 */
export const ROUTER_TOOL_NAMES = [
  "spawn",
  "resume",
  "list",
  "send",
  "read",
  "interrupt",
  "wait",
  "kill",
  "subscribe",
  "unsubscribe",
] as const;

export type RouterToolName = (typeof ROUTER_TOOL_NAMES)[number];

export const WORKER_TOOL_NAMES = ["subscribe", "unsubscribe", "read"] as const;

const SHELL_OR_EDIT =
  /(shell|bash|exec|terminal|edit|write|patch|delete|fs_|strreplace|apply_patch|notebook)/i;

/** Names in `names` that are shell, edit, or write tools. Order is preserved. */
export function forbiddenRouterToolNames(names: readonly string[]): string[] {
  return names.filter((name) => SHELL_OR_EDIT.test(name));
}

export function assertNoShellOrEditTools(names: readonly string[]): void {
  const bad = forbiddenRouterToolNames(names);
  if (bad.length > 0) {
    throw new Error(`router tool list contains shell/edit tools: ${bad.join(", ")}`);
  }
}

export function toolNamesForRole(role: "router" | "worker"): readonly string[] {
  const names = role === "router" ? ROUTER_TOOL_NAMES : WORKER_TOOL_NAMES;
  if (role === "router") assertNoShellOrEditTools(names);
  return names;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TigerError("invalid_args", `${field} must be a non-empty string`);
  }
  return value;
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new TigerError("invalid_args", `${field} must be a string`);
  }
  return value;
}

export function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TigerError("invalid_args", `${field} must be a number`);
  }
  return value;
}
