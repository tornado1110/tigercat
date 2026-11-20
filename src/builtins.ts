import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TigerError } from "./errors.js";
import type { AppConfig, PermissionPolicy, RuntimeConfig } from "./types.js";

/**
 * Pinned from the npm registry on 2026-11-18.
 * Claude Code has no native ACP mode. The supported path is
 * `@agentclientprotocol/claude-agent-acp` (bin `claude-agent-acp`).
 * Codex has no native ACP mode. The supported path is
 * `@agentclientprotocol/codex-acp` (bin `codex-acp`). The older
 * `zed-industries/codex-acp` repository is not the current package.
 */
export const CLAUDE_AGENT_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
export const CLAUDE_AGENT_ACP_VERSION = "0.108.0";
export const CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp";
export const CODEX_ACP_VERSION = "2.7.0";

export interface AdapterSpec {
  name: "claude-code" | "codex";
  product: string;
  description: string;
  tags: string[];
  permission: PermissionPolicy;
  packageName: string;
  version: string;
  bin: string;
  /** Package entry used when the adapter is installed next to TigerCat. */
  entry: string;
  vendorBinary: string;
  /** Checked first. An explicit path that is missing does not fall through to PATH. */
  vendorEnv: readonly string[];
  /** Absolute path to an adapter executable. When set, `runtime test` launches it. */
  adapterEnv: string;
  /** Always set on the child so the adapter stays on the v1 session lifecycle this client speaks. */
  childEnv: Record<string, string>;
  /** Env var the adapter reads when the user points it at an installed vendor binary. */
  vendorPassthrough: string;
  manual: string;
}

export const BUILTIN_RUNTIMES: readonly AdapterSpec[] = [
  {
    name: "claude-code",
    product: "Claude Code",
    description: `Official ACP adapter for Claude Code (${CLAUDE_AGENT_ACP_PACKAGE}@${CLAUDE_AGENT_ACP_VERSION}).`,
    tags: ["worker"],
    permission: "ask",
    packageName: CLAUDE_AGENT_ACP_PACKAGE,
    version: CLAUDE_AGENT_ACP_VERSION,
    bin: "claude-agent-acp",
    entry: "dist/index.js",
    vendorBinary: "claude",
    vendorEnv: ["TIGERCAT_CLAUDE_BIN", "CLAUDE_CODE_EXECUTABLE"],
    adapterEnv: "TIGERCAT_CLAUDE_CODE_ACP",
    childEnv: { CLAUDE_AGENT_ACP_PROTOCOL: "v1" },
    vendorPassthrough: "CLAUDE_CODE_EXECUTABLE",
    manual: "TIGERCAT_CLAUDE_BIN=/path/to/claude tigercat runtime test claude-code",
  },
  {
    name: "codex",
    product: "Codex",
    description: `Official ACP adapter for Codex (${CODEX_ACP_PACKAGE}@${CODEX_ACP_VERSION}).`,
    tags: ["worker"],
    permission: "ask",
    packageName: CODEX_ACP_PACKAGE,
    version: CODEX_ACP_VERSION,
    bin: "codex-acp",
    entry: "dist/index.js",
    vendorBinary: "codex",
    vendorEnv: ["TIGERCAT_CODEX_BIN", "CODEX_PATH"],
    adapterEnv: "TIGERCAT_CODEX_ACP",
    childEnv: {},
    vendorPassthrough: "CODEX_PATH",
    manual: "TIGERCAT_CODEX_BIN=/path/to/codex tigercat runtime test codex",
  },
];

export interface ListedRuntime {
  name: string;
  command: string;
  args: string[];
  tags: string[];
  permission: PermissionPolicy;
  description: string;
  builtin: boolean;
  overridden: boolean;
  adapter?: { package: string; version: string; bin: string };
  vendorBinary?: string;
  vendorFound?: boolean;
  /** Absolute executable discovered from an explicit override or PATH. */
  vendorPath?: string;
  testMode?: "dry-run" | "adapter";
  manual?: string;
}

export interface RuntimeTestPlan {
  runtime: RuntimeConfig;
  launch: RuntimeConfig;
  mode: "dry-run" | "adapter" | "command";
  vendorFound: boolean;
  adapter?: { package: string; version: string; bin: string };
  manual: string;
  message: string;
}

interface VendorProbe {
  found: boolean;
  path?: string;
  explicitMissing?: string;
}

export function builtinByName(name: string): AdapterSpec | undefined {
  return BUILTIN_RUNTIMES.find((spec) => spec.name === name);
}

export function resolveRuntime(config: AppConfig, name: string, env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const configured = config.runtimes.find((entry) => entry.name === name && entry.command);
  if (configured) return configured;
  const spec = builtinByName(name);
  if (!spec) throw new TigerError("unknown_runtime", `unknown runtime ${name}`);
  return launchConfig(spec, env);
}

export function listRuntimes(config: AppConfig, env: NodeJS.ProcessEnv = process.env): ListedRuntime[] {
  const listed = new Map<string, ListedRuntime>();
  for (const spec of BUILTIN_RUNTIMES) {
    const launch = launchConfig(spec, env);
    const vendor = findVendor(spec, env);
    listed.set(spec.name, {
      name: spec.name,
      command: launch.command,
      args: launch.args,
      tags: spec.tags,
      permission: spec.permission,
      description: spec.description,
      builtin: true,
      overridden: false,
      adapter: adapterInfo(spec),
      vendorBinary: spec.vendorBinary,
      vendorFound: vendor.found,
      vendorPath: vendor.path,
      testMode: adapterTestRequested(spec, env, vendor) ? "adapter" : "dry-run",
      manual: spec.manual,
    });
  }
  for (const runtime of config.runtimes) {
    const existing = listed.get(runtime.name);
    listed.set(runtime.name, {
      name: runtime.name,
      command: runtime.command,
      args: runtime.args,
      tags: runtime.tags,
      permission: runtime.permission,
      description: runtime.description,
      builtin: false,
      overridden: Boolean(existing),
    });
  }
  return [...listed.values()];
}

/**
 * Probe the host for the built-in Claude Code and Codex vendor executables.
 * The result intentionally reuses the runtime catalog so callers can show
 * both configured overrides and the discovered local adapters in one view.
 */
export function discoverRuntimes(config: AppConfig, env: NodeJS.ProcessEnv = process.env): ListedRuntime[] {
  return listRuntimes(config, env);
}

export function planRuntimeTest(
  config: AppConfig,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeTestPlan {
  const configured = config.runtimes.find((entry) => entry.name === name && entry.command);
  const spec = builtinByName(name);
  if (!configured && !spec) throw new TigerError("unknown_runtime", `unknown runtime ${name}`);
  if (configured) {
    return {
      runtime: configured,
      launch: configured,
      mode: "command",
      vendorFound: spec ? findVendor(spec, env).found : false,
      adapter: spec ? adapterInfo(spec) : undefined,
      manual: spec?.manual ?? "",
      message: `Launching the configured command for ${name}.`,
    };
  }
  const vendor = findVendor(spec!, env);
  if (!adapterTestRequested(spec!, env, vendor)) {
    return {
      runtime: launchConfig(spec!, env),
      launch: dryRunConfig(spec!),
      mode: "dry-run",
      vendorFound: false,
      adapter: adapterInfo(spec!),
      manual: spec!.manual,
      message: dryRunMessage(spec!, vendor),
    };
  }
  return {
    runtime: launchConfig(spec!, env),
    launch: launchConfig(spec!, env),
    mode: "adapter",
    vendorFound: vendor.found,
    adapter: adapterInfo(spec!),
    manual: spec!.manual,
    message: `Launching ${spec!.packageName}@${spec!.version}.`,
  };
}

export function launchConfig(spec: AdapterSpec, env: NodeJS.ProcessEnv): RuntimeConfig {
  const vendor = findVendor(spec, env);
  const childEnv: Record<string, string> = { ...spec.childEnv };
  if (vendor.path) childEnv[spec.vendorPassthrough] = vendor.path;
  const override = env[spec.adapterEnv];
  if (override && override.trim()) {
    return runtimeFrom(spec, override.trim(), [], childEnv);
  }
  const installed = installedAdapter(spec);
  if (installed) return runtimeFrom(spec, process.execPath, [installed], childEnv);
  const npxArgs = ["-y", `${spec.packageName}@${spec.version}`];
  const cli = npxCliPath(process.execPath, process.platform);
  const spawnSpec = buildAdapterCommand(process.platform, env, {
    execPath: process.execPath,
    npxArgs,
    npxCliExists: process.platform === "win32" && isFile(cli),
  });
  return runtimeFrom(spec, spawnSpec.command, spawnSpec.args, childEnv, spawnSpec.windowsVerbatimArguments);
}

export interface AdapterCommand {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/** Path of npm's npx JS entry next to a Windows node.exe. */
export function npxCliPath(execPath: string, platform: NodeJS.Platform = process.platform): string {
  const pathFor = platform === "win32" ? path.win32 : path.posix;
  return pathFor.join(pathFor.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
}

/**
 * How to launch `npx` without spawning a `.cmd` directly.
 * Node throws EINVAL for `.cmd`/`.bat` since CVE-2024-27980 unless a shell is used.
 * User-influenced args stay off `shell: true`.
 */
export function buildAdapterCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  input: { execPath: string; npxArgs: string[]; npxCliExists: boolean },
): AdapterCommand {
  if (platform !== "win32") {
    return { command: "npx", args: input.npxArgs };
  }
  if (input.npxCliExists) {
    return {
      command: input.execPath,
      args: [npxCliPath(input.execPath, platform), ...input.npxArgs],
    };
  }
  return {
    command: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", quoteCmdScript(["npx.cmd", ...input.npxArgs])],
    windowsVerbatimArguments: true,
  };
}

function quoteCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\t\n\r "&|<>^%]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** One command string for `cmd.exe /d /s /c`. /s strips the outer quotes. */
function quoteCmdScript(args: string[]): string {
  return `"${args.map(quoteCmdArg).join(" ")}"`;
}

function dryRunConfig(spec: AdapterSpec): RuntimeConfig {
  return {
    name: spec.name,
    command: process.execPath,
    args: [dryRunAgentPath()],
    env: { TIGERCAT_DRY_RUN_RUNTIME: spec.name },
    tags: spec.tags,
    description: `${spec.description} Dry-run handshake.`,
    permission: spec.permission,
  };
}

export function dryRunAgentPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(here, "dry-run-agent.js");
  const source = path.join(here, "dry-run-agent.ts");
  if (isFile(compiled)) return compiled;
  return source;
}

function adapterTestRequested(spec: AdapterSpec, env: NodeJS.ProcessEnv, vendor: VendorProbe): boolean {
  if (env.TIGERCAT_RUNTIME_LIVE === "1") return true;
  const override = env[spec.adapterEnv];
  if (override && override.trim()) return true;
  return vendor.found;
}

function dryRunMessage(spec: AdapterSpec, vendor: VendorProbe): string {
  const why = vendor.explicitMissing
    ? `${vendor.explicitMissing} does not exist.`
    : `No ${spec.vendorBinary} binary was found on PATH.`;
  return `${why} Handshake used the built-in dry-run agent. ${spec.product} was not executed. Real run: ${spec.manual}`;
}

function findVendor(spec: AdapterSpec, env: NodeJS.ProcessEnv): VendorProbe {
  for (const key of spec.vendorEnv) {
    const value = env[key];
    if (!value) continue;
    const resolved = resolveExecutable(value, env);
    if (resolved) return { found: true, path: resolved };
    return { found: false, explicitMissing: `${key}=${value}` };
  }
  const onPath = findOnPath(spec.vendorBinary, env);
  if (onPath) return { found: true, path: onPath };
  return { found: false };
}

function resolveExecutable(value: string, env: NodeJS.ProcessEnv): string | undefined {
  if (value.includes("/") || value.includes("\\")) {
    // Resolve relative explicit paths against the discovery process. The
    // runtime Worker may use a different cwd, so passing `./claude` through
    // unchanged would make an otherwise valid discovery fail at launch.
    const candidate = path.resolve(value);
    return isExecutableFile(candidate) ? candidate : undefined;
  }
  return findOnPath(value, env);
}

function findOnPath(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.PATH ?? env.Path ?? "";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      // PATH entries may themselves be relative. Return an absolute path so
      // the adapter keeps referring to the discovered binary after its cwd
      // changes to a Worker worktree.
      const candidate = path.resolve(dir, bin + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutableFile(file: string): boolean {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return false;
    // Windows uses executable extensions and does not expose meaningful POSIX
    // mode bits. On POSIX, avoid reporting a non-executable file as a found
    // vendor binary; otherwise launch fails later with an opaque EACCES.
    return process.platform === "win32" || (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function installedAdapter(spec: AdapterSpec): string | undefined {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const entry = path.join(root, "node_modules", spec.packageName, spec.entry);
  return isFile(entry) ? entry : undefined;
}

function runtimeFrom(
  spec: AdapterSpec,
  command: string,
  args: string[],
  env: Record<string, string>,
  windowsVerbatimArguments?: boolean,
): RuntimeConfig {
  return {
    name: spec.name,
    command,
    args,
    env,
    tags: spec.tags,
    description: spec.description,
    permission: spec.permission,
    ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };
}

function adapterInfo(spec: AdapterSpec): { package: string; version: string; bin: string } {
  return { package: spec.packageName, version: spec.version, bin: spec.bin };
}
