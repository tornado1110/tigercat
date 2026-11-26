import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAdapterCommand,
  builtinByName,
  CLAUDE_AGENT_ACP_VERSION,
  CLAUDE_AGENT_INFO_NAME,
  CODEX_ACP_VERSION,
  CODEX_AGENT_INFO_NAME,
  launchConfig,
  listRuntimes,
  npxCliPath,
  planRuntimeTest,
  resolveRuntime,
  RESTORE_IDENTITY_ALLOWLIST,
  restoreGate,
} from "../../src/builtins.js";
import { defaultConfig } from "../../src/config.js";
import { TigerError } from "../../src/errors.js";
import type { RuntimeConfig } from "../../src/types.js";

const quiet: NodeJS.ProcessEnv = { PATH: "" };

describe("session restore identity gate", () => {
  it("allowlists only the pinned adapter name and version pairs", () => {
    expect(RESTORE_IDENTITY_ALLOWLIST).toEqual([
      { name: "@agentclientprotocol/claude-agent-acp", version: "0.108.0" },
      { name: "@agentclientprotocol/codex-acp", version: "2.7.0" },
    ]);
    expect(CLAUDE_AGENT_INFO_NAME).toBe("@agentclientprotocol/claude-agent-acp");
    expect(CODEX_AGENT_INFO_NAME).toBe("@agentclientprotocol/codex-acp");
    expect(CLAUDE_AGENT_ACP_VERSION).toBe("0.108.0");
    expect(CODEX_ACP_VERSION).toBe("2.7.0");
  });

  it("allows an exact allowlisted identity only when loadSession is true", () => {
    for (const entry of RESTORE_IDENTITY_ALLOWLIST) {
      expect(restoreGate(entry, true)).toBe("allow");
      expect(restoreGate(entry, false)).toBe("load_unsupported");
      expect(restoreGate({ name: entry.name, version: "9.9.9" }, true)).toBe("builtin_no_restore");
      expect(restoreGate({ name: entry.name, version: "9.9.9" }, false)).toBe("load_unsupported");
    }
  });

  it("lets a non-built-in identity load when loadSession is advertised", () => {
    expect(restoreGate({ name: "custom-acp", version: "1.0.0" }, true)).toBe("allow");
    expect(restoreGate({ name: "tigercat-stub", version: "0.0.0" }, true)).toBe("allow");
    expect(restoreGate(undefined, true)).toBe("allow");
    expect(restoreGate(null, true)).toBe("allow");
    expect(restoreGate({ name: "custom-acp", version: "1.0.0" }, false)).toBe("load_unsupported");
  });
});

describe("built-in ACP runtimes", () => {
  it("pins the official claude-code and codex adapters", () => {
    const claude = launchConfig(builtinByName("claude-code")!, quiet);
    const codex = launchConfig(builtinByName("codex")!, quiet);
    const installedClaude = path.resolve("node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
    const installedCodex = path.resolve("node_modules/@agentclientprotocol/codex-acp/dist/index.js");
    const npxCliExists = process.platform === "win32" && existsSync(npxCliPath(process.execPath));
    const claudeNpx = buildAdapterCommand(process.platform, quiet, {
      execPath: process.execPath,
      npxArgs: ["-y", "@agentclientprotocol/claude-agent-acp@0.108.0"],
      npxCliExists,
    });
    if (existsSync(installedClaude)) {
      expect(claude.command).toBe(process.execPath);
      expect(claude.args).toEqual([installedClaude]);
    } else {
      expect(claude.command).toBe(process.platform === "win32" ? claudeNpx.command : "npx");
      expect(claude.args).toEqual(process.platform === "win32" ? claudeNpx.args : ["-y", "@agentclientprotocol/claude-agent-acp@0.108.0"]);
    }
    expect(claude.env.CLAUDE_AGENT_ACP_PROTOCOL).toBe("v1");
    expect(claude.env.CLAUDE_CODE_EXECUTABLE).toBeUndefined();
    const codexNpx = buildAdapterCommand(process.platform, quiet, {
      execPath: process.execPath,
      npxArgs: ["-y", "@agentclientprotocol/codex-acp@2.7.0"],
      npxCliExists,
    });
    if (existsSync(installedCodex)) {
      expect(codex.command).toBe(process.execPath);
      expect(codex.args).toEqual([installedCodex]);
    } else {
      expect(codex.command).toBe(process.platform === "win32" ? codexNpx.command : "npx");
      expect(codex.args).toEqual(process.platform === "win32" ? codexNpx.args : ["-y", "@agentclientprotocol/codex-acp@2.7.0"]);
    }
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
    expect(plan.launch.command === process.execPath || plan.launch.args.join(" ").includes("@agentclientprotocol/codex-acp@2.7.0")).toBe(true);
  });

  it("discovers local vendor binaries from PATH without an environment override", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tigercat-runtime-discovery-"));
    try {
      const suffix = process.platform === "win32" ? ".cmd" : "";
      const claude = path.join(root, `claude${suffix}`);
      const codex = path.join(root, `codex${suffix}`);
      writeFileSync(claude, "#!/bin/sh\n");
      writeFileSync(codex, "#!/bin/sh\n");
      chmodSync(claude, 0o755);
      chmodSync(codex, 0o755);
      const env = { PATH: path.relative(process.cwd(), root) };
      const listed = listRuntimes(defaultConfig(), env);
      expect(listed.find((runtime) => runtime.name === "claude-code")).toMatchObject({ vendorFound: true, vendorPath: claude, testMode: "adapter" });
      expect(listed.find((runtime) => runtime.name === "codex")).toMatchObject({ vendorFound: true, vendorPath: codex, testMode: "adapter" });
      expect(launchConfig(builtinByName("codex")!, env).env.CODEX_PATH).toBe(codex);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not mistake a non-executable PATH file for a vendor binary", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tigercat-runtime-discovery-mode-"));
    try {
      writeFileSync(path.join(root, process.platform === "win32" ? "claude.txt" : "claude"), "#!/bin/sh\n");
      const listed = listRuntimes(defaultConfig(), { PATH: root });
      expect(listed.find((runtime) => runtime.name === "claude-code")).toMatchObject({
        vendorFound: false,
        testMode: "dry-run",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe("buildAdapterCommand", () => {
  const execPath = "C:\\Program Files\\nodejs\\node.exe";

  it("uses npx on posix", () => {
    expect(buildAdapterCommand("linux", {}, {
      execPath: "/usr/bin/node",
      npxArgs: ["-y", "@agentclientprotocol/codex-acp@2.7.0"],
      npxCliExists: true,
    })).toEqual({
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp@2.7.0"],
    });
  });

  it("runs npx-cli.js with node on win32 when the file exists", () => {
    const command = buildAdapterCommand("win32", {}, {
      execPath,
      npxArgs: ["-y", "@agentclientprotocol/claude-agent-acp@0.108.0"],
      npxCliExists: true,
    });
    expect(command.command).toBe(execPath);
    expect(command.windowsVerbatimArguments).toBeUndefined();
    expect(command.args).toEqual([
      npxCliPath(execPath, "win32"),
      "-y",
      "@agentclientprotocol/claude-agent-acp@0.108.0",
    ]);
    expect(command.args[0]).toBe("C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js");
  });

  it("quotes win32 cmd.exe fallback args that contain spaces", () => {
    const command = buildAdapterCommand("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, {
      execPath,
      npxArgs: ["-y", "pkg with spaces"],
      npxCliExists: false,
    });
    expect(command.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(command.windowsVerbatimArguments).toBe(true);
    expect(command.args).toEqual(["/d", "/s", "/c", '"npx.cmd -y "pkg with spaces""']);
  });
});
