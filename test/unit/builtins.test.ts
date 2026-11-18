import { describe, expect, it } from "vitest";
import {
  builtinByName,
  launchConfig,
  listRuntimes,
  planRuntimeTest,
  resolveRuntime,
} from "../../src/builtins.js";
import { defaultConfig } from "../../src/config.js";
import { TigerError } from "../../src/errors.js";
import type { RuntimeConfig } from "../../src/types.js";

const quiet: NodeJS.ProcessEnv = { PATH: "" };

describe("built-in ACP runtimes", () => {
  it("pins the official claude-code and codex adapters", () => {
    const claude = launchConfig(builtinByName("claude-code")!, quiet);
    const codex = launchConfig(builtinByName("codex")!, quiet);
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    expect(claude.command).toBe(npx);
    expect(claude.args).toEqual(["-y", "@agentclientprotocol/claude-agent-acp@0.108.0"]);
    expect(claude.env.CLAUDE_AGENT_ACP_PROTOCOL).toBe("v1");
    expect(claude.env.CLAUDE_CODE_EXECUTABLE).toBeUndefined();
    expect(codex.command).toBe(npx);
    expect(codex.args).toEqual(["-y", "@agentclientprotocol/codex-acp@2.7.0"]);
    expect(codex.env.CODEX_PATH).toBeUndefined();
  });

  it("dry-runs runtime test when the vendor binary is absent", () => {
    const claude = planRuntimeTest(defaultConfig(), "claude-code", quiet);
    const codex = planRuntimeTest(defaultConfig(), "codex", quiet);
    expect(claude.mode).toBe("dry-run");
    expect(codex.mode).toBe("dry-run");
    expect(claude.launch.command).toBe(process.execPath);
    expect(claude.launch.args[0]).toMatch(/dry-run-agent\.(ts|js)$/);
    expect(claude.launch.command).not.toBe("npx");
    expect(claude.message).toContain("Claude Code was not executed");
    expect(codex.message).toContain("Codex was not executed");
    expect(claude.manual).toContain("TIGERCAT_CLAUDE_BIN=");
    expect(codex.manual).toContain("TIGERCAT_CODEX_BIN=");
  });

  it("uses the adapter when a real run is requested", () => {
    const plan = planRuntimeTest(defaultConfig(), "codex", { PATH: "", TIGERCAT_RUNTIME_LIVE: "1" });
    expect(plan.mode).toBe("adapter");
    expect(plan.launch.args.join(" ")).toContain("@agentclientprotocol/codex-acp@2.7.0");
  });

  it("prefers a configured runtime over the built-in launch", () => {
    const config = defaultConfig();
    const override: RuntimeConfig = {
      name: "claude-code",
      command: process.execPath,
      args: ["stub"],
      env: {},
      tags: [],
      description: "override",
      permission: "ask",
    };
    config.runtimes = [override];
    expect(resolveRuntime(config, "claude-code", { PATH: "", TIGERCAT_RUNTIME_LIVE: "1" }).args).toEqual(["stub"]);
    const plan = planRuntimeTest(config, "claude-code", { PATH: "", TIGERCAT_RUNTIME_LIVE: "1" });
    expect(plan.mode).toBe("command");
    expect(plan.launch.command).toBe(process.execPath);
    const listed = listRuntimes(config, quiet);
    expect(listed.map((runtime) => runtime.name)).toEqual(["claude-code", "codex"]);
    expect(listed[0]?.overridden).toBe(true);
    expect(listed[0]?.command).toBe(process.execPath);
    expect(listed[1]?.builtin).toBe(true);
    expect(listed[1]?.testMode).toBe("dry-run");
  });

  it("rejects an unknown runtime", () => {
    expect(() => resolveRuntime(defaultConfig(), "worker", quiet)).toThrow(TigerError);
    expect(() => planRuntimeTest(defaultConfig(), "missing", quiet)).toThrow(/unknown runtime missing/);
  });
});
