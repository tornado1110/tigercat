import { TigerError } from "./errors.js";
import { forbiddenRouterToolNames, ROUTER_TOOL_NAMES } from "./tools.js";

/**
 * Coordination tools the plugin MCP server would register for the Router.
 * `runtimes` is plugin-only; it does not run a shell or edit files.
 */
export function pluginRouterMcpToolNames(): readonly string[] {
  return [...ROUTER_TOOL_NAMES, "runtimes"];
}

/**
 * Shell, edit, and write stay on the host conversation when the host does
 * not prove they were removed. Codex plugin mode has no API this process
 * can call to inspect or remove those native tools. These names are the
 * contract categories, not a claim that a particular host hook exists.
 */
export const UNPROVEN_HOST_NATIVE_TOOLS = ["shell", "edit", "write"] as const;

export interface RouterToolSurface {
  mcpTools: readonly string[];
  /**
   * Native tools the host still exposes on the Router session.
   * `null` means the host did not prove they were removed. That is not
   * an empty tool list.
   */
  hostNativeTools: readonly string[] | null;
}

/** Production surface for Codex plugin mode. The host report stays unproven. */
export function codexPluginRouterSurface(
  mcpTools: readonly string[] = pluginRouterMcpToolNames(),
): RouterToolSurface {
  return { mcpTools, hostNativeTools: null };
}

export function effectiveRouterTools(surface: RouterToolSurface): string[] {
  const host = surface.hostNativeTools ?? UNPROVEN_HOST_NATIVE_TOOLS;
  return [...surface.mcpTools, ...host];
}

/**
 * Allow a plugin Router session only when its effective tool set has no
 * shell, edit, or write tool. An unproven host report keeps those native
 * categories in the set, and startup must refuse. This does not switch to
 * a looser permission policy.
 */
export function assertRouterSessionMayStart(surface: RouterToolSurface): void {
  const names = effectiveRouterTools(surface);
  const bad = forbiddenRouterToolNames(names);
  if (bad.length === 0) return;
  throw new TigerError(
    "router_native_tools",
    `Codex plugin mode refused to start: the Router effective tool set still includes shell, edit, or write tools (${bad.join(", ")}). TigerCat cannot inspect or remove Codex native tools. No looser permission mode was used.`,
  );
}
