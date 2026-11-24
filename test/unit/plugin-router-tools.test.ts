import { describe, expect, it } from "vitest";
import { TigerError } from "../../src/errors.js";
import {
  assertRouterSessionMayStart,
  codexPluginRouterSurface,
  effectiveRouterTools,
  pluginRouterMcpToolNames,
  UNPROVEN_HOST_NATIVE_TOOLS,
} from "../../src/plugin-boundary.js";
import { forbiddenRouterToolNames, ROUTER_TOOL_NAMES } from "../../src/tools.js";

const coordination = () => [...pluginRouterMcpToolNames()];

describe("plugin Router effective tools", () => {
  it("fails if shell, edit, or write appears in the effective tool set", () => {
    const allowed = {
      mcpTools: coordination(),
      hostNativeTools: [] as readonly string[],
    };
    expect(forbiddenRouterToolNames(effectiveRouterTools(allowed))).toEqual([]);
    expect(() => assertRouterSessionMayStart(allowed)).not.toThrow();

    for (const name of ["shell", "edit", "write"]) {
      const onHost = { mcpTools: coordination(), hostNativeTools: [name] };
      expect(forbiddenRouterToolNames(effectiveRouterTools(onHost))).toContain(name);
      expect(() => assertRouterSessionMayStart(onHost)).toThrow(TigerError);

      const onMcp = { mcpTools: [...coordination(), name], hostNativeTools: [] as readonly string[] };
      expect(forbiddenRouterToolNames(effectiveRouterTools(onMcp))).toContain(name);
      expect(() => assertRouterSessionMayStart(onMcp)).toThrow(/refused to start/);
    }
  });

  it("keeps unproven Codex native tools in the production surface and refuses startup", () => {
    const surface = codexPluginRouterSurface();
    expect(surface.hostNativeTools).toBeNull();
    expect(surface.mcpTools).toEqual([...ROUTER_TOOL_NAMES, "runtimes"]);
    expect(forbiddenRouterToolNames(surface.mcpTools)).toEqual([]);
    expect(effectiveRouterTools(surface).slice(-UNPROVEN_HOST_NATIVE_TOOLS.length)).toEqual([
      ...UNPROVEN_HOST_NATIVE_TOOLS,
    ]);
    expect(forbiddenRouterToolNames(effectiveRouterTools(surface))).toEqual(["shell", "edit", "write"]);
    expect(() => assertRouterSessionMayStart(surface)).toThrow(/cannot inspect or remove Codex native tools/);
    try {
      assertRouterSessionMayStart(surface);
    } catch (error) {
      expect(error).toMatchObject({ code: "router_native_tools" });
      expect((error as TigerError).message).toMatch(/No looser permission mode was used/);
    }
  });
});
