import type { PermissionPolicy } from "./types.js";
import { ROUTER_TOOL_NAMES } from "./tools.js";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequest {
  toolTitle?: string;
  toolKind?: string;
  rawName?: string;
  options: PermissionOption[];
}

export type PermissionDecision =
  | { type: "selected"; optionId: string }
  | { type: "cancelled" }
  | { type: "forward" };

const ROUTER_ALLOWED = new Set<string>(ROUTER_TOOL_NAMES);
const OPTION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);

export function validPermissionOptions(options: readonly PermissionOption[]): boolean {
  const ids = new Set<string>();
  return options.length > 0 && options.every((option) => {
    if (typeof option.optionId !== "string" || option.optionId.trim() === "" || ids.has(option.optionId)) return false;
    if (typeof option.name !== "string" || !OPTION_KINDS.has(option.kind)) return false;
    ids.add(option.optionId);
    return true;
  });
}

function toolName(request: PermissionRequest): string {
  return (request.rawName ?? request.toolTitle ?? "").trim();
}

/**
 * Router sessions are refused shell/edit/exec permissions here, regardless
 * of the runtime's auto|ask|deny policy. `ask` never selects an allow option
 * by itself; it forwards the decision.
 */
export function decidePermission(
  role: "router" | "worker",
  policy: PermissionPolicy,
  request: PermissionRequest,
): PermissionDecision {
  if (!validPermissionOptions(request.options)) return { type: "cancelled" };
  if (role === "router" && !routerMayUse(request)) {
    return deny(request);
  }
  if (policy === "deny") return deny(request);
  if (policy === "auto") return allow(request);
  return { type: "forward" };
}

export function routerMayUse(request: PermissionRequest): boolean {
  const kind = (request.toolKind ?? "").toLowerCase();
  if (kind === "edit" || kind === "delete" || kind === "move" || kind === "execute") {
    return false;
  }
  const name = toolName(request);
  if (!name) return false;
  const bare = name.replace(/^tigercat[./]/, "");
  return ROUTER_ALLOWED.has(bare);
}

function allow(request: PermissionRequest): PermissionDecision {
  const preferred =
    request.options.find((option) => option.kind === "allow_once") ?? request.options.find((option) => option.kind === "allow_always");
  if (!preferred) return { type: "cancelled" };
  return { type: "selected", optionId: preferred.optionId };
}

function deny(request: PermissionRequest): PermissionDecision {
  const preferred = request.options.find((option) => option.kind === "reject_once") ?? request.options.find((option) => option.kind === "reject_always");
  if (!preferred) return { type: "cancelled" };
  return { type: "selected", optionId: preferred.optionId };
}
