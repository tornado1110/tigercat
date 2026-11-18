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
    request.options.find((option) => option.kind.startsWith("allow")) ?? request.options[0];
  if (!preferred) return { type: "cancelled" };
  return { type: "selected", optionId: preferred.optionId };
}

function deny(request: PermissionRequest): PermissionDecision {
  const preferred = request.options.find((option) => option.kind.startsWith("reject"));
  if (!preferred) return { type: "cancelled" };
  return { type: "selected", optionId: preferred.optionId };
}
