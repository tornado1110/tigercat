import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Buffer } from "node:buffer";
import path from "node:path";
import { SecretRegistry } from "./redact.js";

/** A trusted account/profile binding captured by the host of the capability. */
export interface LarkCliBinding {
  readonly accountRef: string;
  readonly profileRef: string;
  readonly credentialHome: string;
  readonly credentialRevision: string;
}

export type LarkCliVersionPolicy = "exact" | "same-minor";
export type LarkCliEffect = "read" | "write";
export type LarkCliAuthStatus = "ready" | "refreshable" | "missing" | "unavailable";

export type LarkCliErrorCode =
  | "missing_authorization"
  | "missing_user_scope"
  | "app_scope"
  | "acl"
  | "ambiguous_failure"
  | "outcome_unknown"
  | "unavailable"
  | "version_unsupported"
  | "revision_mismatch"
  | "binding_mismatch"
  | "invalid_request";

export interface LarkCliInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/** Raw process result accepted by the test runner and used by the subprocess runner. */
export interface LarkCliRawResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal?: string | null;
  readonly timedOut?: boolean;
  readonly truncated?: boolean;
  readonly started?: boolean;
  readonly error?: string;
}

export type LarkCliRunner = (invocation: LarkCliInvocation) => Promise<LarkCliRawResult>;

export interface LarkCliOptions {
  /** Defaults to the locally installed `lark-cli` on PATH. */
  readonly binary?: string;
  /** Arguments placed before the fixed profile/command argv (useful for a local test stub). */
  readonly prefixArgs?: readonly string[];
  /** The compatibility baseline pinned by DeerFlow. Defaults to 1.0.82. */
  readonly expectedVersion?: string;
  /** `exact` only accepts the baseline; `same-minor` allows newer patch releases. */
  readonly versionPolicy?: LarkCliVersionPolicy;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Extra non-secret environment values. HOME and XDG paths are always overwritten. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam; production uses the no-shell child-process runner. */
  readonly runner?: LarkCliRunner;
  /** Set false only when the host has already probed this exact binding/version. */
  readonly checkVersion?: boolean;
}

export interface LarkCliVersionResult {
  readonly ok: boolean;
  readonly compatible: boolean;
  readonly version?: string;
  readonly expectedVersion: string;
  readonly policy: LarkCliVersionPolicy;
  readonly code?: LarkCliErrorCode;
  readonly message?: string;
}

export interface LarkCliStatusResult {
  readonly ok: boolean;
  readonly status: LarkCliAuthStatus;
  readonly accountRef: string;
  readonly profileRef: string;
  readonly credentialRevision: string;
  readonly code?: LarkCliErrorCode;
  readonly message?: string;
}

export interface LarkCliCallResult<T = unknown> {
  readonly ok: boolean;
  readonly value?: T;
  readonly code?: LarkCliErrorCode;
  readonly message?: string;
  /** Writes are deliberately one-shot; uncertain delivery is surfaced explicitly. */
  readonly outcome?: "success" | "rejected" | "outcome_unknown";
  readonly attempted: boolean;
  readonly redactedStderr?: string;
}

export interface LarkCliExecuteRequest {
  readonly args: readonly string[];
  readonly effect: LarkCliEffect;
  /** Reject the call if the host's trusted credential snapshot has changed. */
  readonly expectedRevision?: string;
}

export interface LarkCliDiscoverResult extends LarkCliCallResult<unknown> {
  readonly skill?: string;
}

const DEFAULT_BINARY = "lark-cli";
const DEFAULT_VERSION = "1.0.82";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const PROFILE_FLAG = "--profile";

const AUTH_SUBTYPES = new Set([
  "auth",
  "authentication",
  "unauthorized",
  "not_authorized",
  "not_configured",
  "token_missing",
  "token_expired",
  "need_user_authorization",
]);
const USER_SCOPE_SUBTYPES = new Set(["missing_scope", "insufficient_scope", "user_scope"]);
const APP_SCOPE_SUBTYPES = new Set(["app_scope_not_applied", "app_scope", "app_not_authorized"]);
const ACL_SUBTYPES = new Set(["permission_not_granted", "forbidden", "acl"]);
const USER_TOKEN_CODES = new Set([99991668, 99991677, 99991679]);
const CREDENTIAL_ARG = /--(?:access[-_]?token|api[-_]?key|client[-_]?secret|password|credential|authorization)(?:=|$)/i;
const CREDENTIAL_JSON_FIELD = /["'](?:access[-_]?token|api[-_]?key|client[-_]?secret|password|credential|authorization)["']\s*:/i;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_BYTES = 64 * 1024;

function fail(message: string, code: LarkCliErrorCode, attempted = false): LarkCliCallResult {
  return { ok: false, code, message, attempted, outcome: attempted ? "rejected" : undefined };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseVersion(text: string): string | undefined {
  const match = text.match(/\b(?:lark-cli\s+)?version\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/i) ?? text.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1];
}

function versionParts(version: string): [number, number, number] | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compatibleVersion(actual: string, expected: string, policy: LarkCliVersionPolicy): boolean {
  const actualParts = versionParts(actual);
  const expectedParts = versionParts(expected);
  if (!actualParts || !expectedParts) return false;
  if (policy === "exact") return actual === expected;
  return actualParts[0] === expectedParts[0] && actualParts[1] === expectedParts[1] && actualParts[2] >= expectedParts[2];
}

function jsonFromOutput(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Some wrappers print notices before or after a JSON envelope. Extract a
    // balanced object/array so nested error objects are not mistaken for the
    // top-level response.
    for (let start = 0; start < trimmed.length; start += 1) {
      if (trimmed[start] !== "{" && trimmed[start] !== "[") continue;
      const stack: string[] = [];
      let quoted = false;
      let escaped = false;
      for (let index = start; index < trimmed.length; index += 1) {
        const character = trimmed[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') {
          quoted = true;
          continue;
        }
        if (character === "{" || character === "[") {
          stack.push(character === "{" ? "}" : "]");
          continue;
        }
        if (character !== "}" && character !== "]") continue;
        if (stack.pop() !== character) break;
        if (stack.length !== 0) continue;
        try {
          return JSON.parse(trimmed.slice(start, index + 1)) as unknown;
        } catch {
          break;
        }
      }
    }
    return undefined;
  }
}

function codeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function errorNode(payload: unknown): Record<string, unknown> | undefined {
  if (!isObject(payload)) return undefined;
  if (isObject(payload.error)) return payload.error;
  if (typeof payload.error === "string") return { type: payload.error };
  if (isObject(payload.data) && isObject(payload.data.error)) return payload.data.error;
  if (isObject(payload.data) && typeof payload.data.error === "string") return { type: payload.data.error };
  if (payload.ok === false) return payload;
  if (typeof payload.type === "string" && (typeof payload.subtype === "string" || typeof payload.message === "string")) return payload;
  return undefined;
}

function explicitBindingMismatch(payload: unknown, binding: LarkCliBinding): boolean {
  if (!isObject(payload)) return false;
  const candidates = [payload, isObject(payload.data) ? payload.data : undefined, isObject(payload.result) ? payload.result : undefined].filter(isObject);
  for (const candidate of candidates) {
    for (const key of ["appId", "app_id", "accountRef", "account_ref", "profileRef", "profile", "profile_id"]) {
      const value = asString(candidate[key]);
      if (!value) continue;
      if ((key === "appId" || key === "app_id") && value !== binding.accountRef) return true;
      if ((key === "accountRef" || key === "account_ref") && value !== binding.accountRef) return true;
      if ((key === "profileRef" || key === "profile" || key === "profile_id") && value !== binding.profileRef) return true;
    }
  }
  return false;
}

function classifyError(payload: unknown, stderr: string): LarkCliErrorCode {
  const error = errorNode(payload);
  const values = [
    error?.type,
    error?.subtype,
    error?.kind,
    error?.reason,
    error?.message,
    isObject(payload) ? payload.code : undefined,
    isObject(payload) && isObject(payload.data) ? payload.data.code : undefined,
  ];
  const texts = values.map(lower);
  const numeric = values.map(codeNumber).find((value) => value !== undefined);
  if (numeric !== undefined && USER_TOKEN_CODES.has(numeric)) return "missing_user_scope";
  if (texts.some((value) => value.includes("need_user_authorization") || AUTH_SUBTYPES.has(value))) return "missing_authorization";
  if (texts.some((value) => value.includes("app_scope_not_applied") || APP_SCOPE_SUBTYPES.has(value))) return "app_scope";
  if (texts.some((value) => value.includes("missing_scope") || value.includes("insufficient_scope") || USER_SCOPE_SUBTYPES.has(value))) return "missing_user_scope";
  if (texts.some((value) => value.includes("permission_not_granted") || value === "forbidden" || ACL_SUBTYPES.has(value))) return "acl";
  const diagnostic = `${texts.join(" ")} ${stderr.toLowerCase()}`;
  if (/profile .* not found/.test(diagnostic)) return "unavailable";
  if (/not configured|credential|token missing|not logged in/.test(diagnostic)) return "missing_authorization";
  return "ambiguous_failure";
}

function classifyAuth(payload: unknown): LarkCliAuthStatus {
  if (!isObject(payload)) return "unavailable";
  const identities = isObject(payload.identities) ? payload.identities : isObject(payload.data) && isObject(payload.data.identities) ? payload.data.identities : undefined;
  const user = identities && isObject(identities.user) ? identities.user : undefined;
  const status = lower(user?.status);
  if (status === "ready") return "ready";
  if (status === "needs_refresh" || status === "refreshable") return "refreshable";
  if (status === "missing") return "missing";
  const diagnostic = JSON.stringify(errorNode(payload) ?? payload).toLowerCase();
  if (/profile .* not found/.test(diagnostic)) return "unavailable";
  const errorCode = classifyError(payload, "");
  return errorCode === "missing_authorization" ? "missing" : "unavailable";
}

function validateArgs(args: readonly string[]): string | undefined {
  if (!Array.isArray(args)) return "args must be an array";
  if (args.length === 0) return "a business command is required";
  if (args.length > MAX_ARGUMENTS) return "too many command arguments";
  const command = args[0];
  if (command && ["auth", "config", "login", "logout", "profile", "profiles", "doctor", "update", "whoami", "help", "version", "skills"].includes(command)) {
    return "authentication, identity, CLI management and discovery are host-owned operations";
  }
  for (const arg of args) {
    if (typeof arg !== "string" || arg.includes("\0")) return "arguments contain an invalid value";
    if (Buffer.byteLength(arg, "utf8") > MAX_ARGUMENT_BYTES) return "an argument is too large";
    if (CREDENTIAL_ARG.test(arg) || CREDENTIAL_JSON_FIELD.test(arg)) return "credential-like arguments are not accepted";
    if (arg === PROFILE_FLAG || arg.startsWith(`${PROFILE_FLAG}=`)) return "profile is fixed by the trusted binding";
    if (arg === "--as" || arg.startsWith("--as=")) return "identity is fixed to the authorized user";
    if (arg === "--home" || arg.startsWith("--home=") || arg === "--config" || arg.startsWith("--config=")) return "credential location is fixed by the trusted binding";
  }
  return undefined;
}

/** Validate model-supplied argv without launching the CLI. */
export function validateLarkCliArguments(args: readonly string[]): string | undefined {
  return validateArgs(args);
}

function makeEnvironment(binding: LarkCliBinding, extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(extra ?? {}) };
  // DeerFlow's wrapper uses this variable to synthesize a profile flag. The
  // adapter supplies the flag itself, so an inherited value must not redirect
  // a call to another account.
  delete env.ANEW_LARK_PROFILE;
  delete env.LARK_PROFILE;
  env.HOME = binding.credentialHome;
  env.XDG_CONFIG_HOME = path.join(binding.credentialHome, ".config");
  env.XDG_DATA_HOME = path.join(binding.credentialHome, ".local", "share");
  env.XDG_STATE_HOME = path.join(binding.credentialHome, ".local", "state");
  env.XDG_CACHE_HOME = path.join(binding.credentialHome, ".cache");
  return env;
}

function spawnRunner(invocation: LarkCliInvocation): Promise<LarkCliRawResult> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(invocation.file, [...invocation.args], {
        env: { ...invocation.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as ChildProcessWithoutNullStreams;
    } catch (error) {
      resolve({ stdout: "", stderr: "", exitCode: null, started: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;
    const started = true;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, invocation.timeoutMs);
    const append = (target: Buffer[], chunk: Buffer) => {
      if (settled || truncated) return;
      const remaining = invocation.maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      target.push(accepted);
      outputBytes += accepted.length;
      if (accepted.length < chunk.length) {
        truncated = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: null, started: false, error: error.message });
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode, signal, timedOut, truncated, started });
    });
  });
}

function validateBinding(binding: LarkCliBinding): void {
  for (const [name, value] of Object.entries(binding)) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new TypeError(`invalid lark-cli binding ${name}`);
  }
  if (binding.profileRef.startsWith("-")) throw new TypeError("profileRef cannot start with a flag prefix");
  if (!path.isAbsolute(binding.credentialHome)) throw new TypeError("credentialHome must be absolute");
}

/**
 * A small, host-owned adapter around the local lark-cli binary. The model only
 * supplies business arguments; profile, HOME and credential revision are
 * immutable constructor state and are never accepted from command output.
 */
export class LocalLarkCli {
  readonly binding: LarkCliBinding;
  readonly binary: string;
  readonly prefixArgs: readonly string[];
  readonly expectedVersion: string;
  readonly versionPolicy: LarkCliVersionPolicy;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly runner: LarkCliRunner;
  private readonly checkVersion: boolean;
  private versionResult?: LarkCliVersionResult;

  constructor(binding: LarkCliBinding, options: LarkCliOptions = {}) {
    validateBinding(binding);
    this.binding = Object.freeze({ ...binding });
    this.binary = options.binary ?? DEFAULT_BINARY;
    this.prefixArgs = Object.freeze([...(options.prefixArgs ?? [])]);
    this.expectedVersion = options.expectedVersion ?? DEFAULT_VERSION;
    this.versionPolicy = options.versionPolicy ?? "same-minor";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");
    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) throw new TypeError("maxOutputBytes must be positive");
    this.env = options.env ? { ...options.env } : undefined;
    this.runner = options.runner ?? spawnRunner;
    this.checkVersion = options.checkVersion ?? true;
  }

  async probeVersion(): Promise<LarkCliVersionResult> {
    if (this.versionResult) return this.versionResult;
    const result = await this.invoke([PROFILE_FLAG, this.binding.profileRef, "--version"]);
    const version = parseVersion(`${result.stdout}\n${result.stderr}`);
    const compatible = Boolean(version && compatibleVersion(version, this.expectedVersion, this.versionPolicy));
    const probe: LarkCliVersionResult = result.error || result.timedOut || result.truncated || result.exitCode !== 0 || !version
      ? { ok: false, compatible: false, version, expectedVersion: this.expectedVersion, policy: this.versionPolicy, code: "unavailable", message: "could not probe lark-cli version" }
      : compatible
        ? { ok: true, compatible: true, version, expectedVersion: this.expectedVersion, policy: this.versionPolicy }
        : { ok: false, compatible: false, version, expectedVersion: this.expectedVersion, policy: this.versionPolicy, code: "version_unsupported", message: `lark-cli ${version} is incompatible with ${this.expectedVersion}` };
    this.versionResult = probe;
    return probe;
  }

  async status(): Promise<LarkCliStatusResult> {
    const version = await this.ensureVersion();
    if (!version.ok) return { ok: false, status: "unavailable", accountRef: this.binding.accountRef, profileRef: this.binding.profileRef, credentialRevision: this.binding.credentialRevision, code: version.code, message: version.message };
    const result = await this.invoke([PROFILE_FLAG, this.binding.profileRef, "auth", "status", "--json"]);
    const payload = jsonFromOutput(result.redactedStdout) ?? jsonFromOutput(result.redactedStderr);
    if (explicitBindingMismatch(payload, this.binding)) return { ok: false, status: "unavailable", accountRef: this.binding.accountRef, profileRef: this.binding.profileRef, credentialRevision: this.binding.credentialRevision, code: "binding_mismatch", message: "lark-cli returned a different bound profile" };
    const status = result.started === false || result.error || result.timedOut || result.truncated ? "unavailable" : classifyAuth(payload);
    const code = status === "missing" ? "missing_authorization" : status === "unavailable" ? "unavailable" : undefined;
    return { ok: status !== "unavailable", status, accountRef: this.binding.accountRef, profileRef: this.binding.profileRef, credentialRevision: this.binding.credentialRevision, code, message: status === "missing" ? "user authorization is missing" : undefined };
  }

  async discover(skill?: string): Promise<LarkCliDiscoverResult> {
    const validation = skill && (skill.includes("\0") || skill.startsWith("-") ? "invalid skill name" : undefined);
    if (validation) return { ...fail(validation, "invalid_request"), skill };
    const version = await this.ensureVersion();
    if (!version.ok) return { ...fail(version.message ?? "lark-cli is unavailable", version.code ?? "unavailable"), skill };
    const args = skill ? [PROFILE_FLAG, this.binding.profileRef, "skills", "read", skill, "--json"] : [PROFILE_FLAG, this.binding.profileRef, "skills", "list", "--json"];
    const result = await this.invoke(args);
    return this.finishCall(result, "read", skill);
  }

  async execute(request: LarkCliExecuteRequest): Promise<LarkCliCallResult> {
    if (!request || !Array.isArray(request.args)) return fail("args must be an array", "invalid_request");
    if (request.effect !== "read" && request.effect !== "write") return fail("effect must be read or write", "invalid_request");
    if (request.expectedRevision !== undefined && request.expectedRevision !== this.binding.credentialRevision) return fail("credential revision is stale", "revision_mismatch");
    const validation = validateArgs(request.args);
    if (validation) return fail(validation, "invalid_request");
    const version = await this.ensureVersion();
    if (!version.ok) return fail(version.message ?? "lark-cli is unavailable", version.code ?? "unavailable");
    const args = [PROFILE_FLAG, this.binding.profileRef, ...request.args, "--as", "user", "--json"];
    const result = await this.invoke(args);
    return this.finishCall(result, request.effect);
  }

  private async ensureVersion(): Promise<LarkCliVersionResult> {
    if (!this.checkVersion) return { ok: true, compatible: true, expectedVersion: this.expectedVersion, policy: this.versionPolicy };
    return this.probeVersion();
  }

  private async invoke(args: readonly string[]): Promise<LarkCliRawResult & { redactedStdout: string; redactedStderr: string }> {
    const registry = new SecretRegistry();
    registry.noteProcessEnv(process.env);
    registry.noteEnv(this.env ? Object.fromEntries(Object.entries(this.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined);
    const invocation: LarkCliInvocation = {
      file: this.binary,
      args: [...this.prefixArgs, ...args],
      env: makeEnvironment(this.binding, this.env),
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    };
    let raw: LarkCliRawResult;
    try {
      raw = await this.runner(invocation);
    } catch (error) {
      raw = { stdout: "", stderr: "", exitCode: null, started: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ...raw, redactedStdout: registry.redact(raw.stdout ?? ""), redactedStderr: registry.redact(raw.stderr ?? "") };
  }

  private finishCall(raw: LarkCliRawResult & { redactedStdout: string; redactedStderr: string }, effect: LarkCliEffect, skill?: string): LarkCliCallResult & { skill?: string } {
    const attempted = raw.started !== false && !raw.error;
    if (!attempted) return { ...fail("lark-cli could not be started", "unavailable"), attempted: false, redactedStderr: raw.redactedStderr, skill };
    if (raw.timedOut || raw.truncated) {
      return effect === "write"
        ? { ok: false, code: "outcome_unknown", message: "write outcome is unknown; no automatic retry was attempted", outcome: "outcome_unknown", attempted: true, redactedStderr: raw.redactedStderr, skill }
        : { ok: false, code: "ambiguous_failure", message: "lark-cli response was incomplete", outcome: "rejected", attempted: true, redactedStderr: raw.redactedStderr, skill };
    }
    const payload = jsonFromOutput(raw.redactedStdout) ?? jsonFromOutput(raw.redactedStderr);
    if (explicitBindingMismatch(payload, this.binding)) return { ok: false, code: "binding_mismatch", message: "lark-cli returned a different bound profile", outcome: "rejected", attempted: true, redactedStderr: raw.redactedStderr, skill };
    const error = errorNode(payload);
    if (error) {
      const code = classifyError(payload, raw.redactedStderr);
      return { ok: false, code, message: "lark-cli rejected the request", outcome: "rejected", attempted: true, redactedStderr: raw.redactedStderr, skill };
    }
    if (raw.exitCode !== 0 || payload === undefined) {
      return effect === "write"
        ? { ok: false, code: "outcome_unknown", message: "write outcome is unknown; no automatic retry was attempted", outcome: "outcome_unknown", attempted: true, redactedStderr: raw.redactedStderr, skill }
        : { ok: false, code: "ambiguous_failure", message: "lark-cli returned an unparseable response", outcome: "rejected", attempted: true, redactedStderr: raw.redactedStderr, skill };
    }
    return { ok: true, value: payload ?? raw.redactedStdout.trim(), outcome: "success", attempted: true, redactedStderr: raw.redactedStderr, skill };
  }
}

