import {
  LocalLarkCli,
  validateLarkCliArguments,
  type LarkCliCallResult,
  type LarkCliDiscoverResult,
  type LarkCliExecuteRequest,
  type LarkCliStatusResult,
} from "./lark-cli.js";

export type LarkApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type LarkApiPrimitive = string | number | boolean;

export interface LarkApiRequest {
  readonly method: LarkApiMethod;
  /** Only the Lark Open API namespace is accepted; host/profile flags stay private. */
  readonly path: string;
  readonly params?: Readonly<Record<string, LarkApiPrimitive | readonly LarkApiPrimitive[]>>;
  readonly data?: unknown;
  readonly expectedRevision?: string;
}

export interface LarkTransport {
  status(): Promise<LarkCliStatusResult>;
  discover(skill?: string): Promise<LarkCliDiscoverResult>;
  execute(request: LarkCliExecuteRequest): Promise<LarkCliCallResult>;
  read(args: readonly string[], expectedRevision?: string): Promise<LarkCliCallResult>;
  write(args: readonly string[], expectedRevision?: string): Promise<LarkCliCallResult>;
  api(request: LarkApiRequest): Promise<LarkCliCallResult>;
}

export interface LarkMockFixtures {
  readonly status?: Partial<LarkCliStatusResult>;
  readonly skills?: unknown;
  readonly skill?: Readonly<Record<string, unknown>>;
  readonly read?: unknown;
  readonly write?: unknown;
}

export interface LarkMockCall {
  readonly operation: "read" | "write" | "execute" | "api";
  readonly args?: readonly string[];
  readonly request?: LarkApiRequest;
}

const OPEN_API_PATH = /^\/open-apis\/[A-Za-z0-9._~:/@!$&'()*+,;=%-]+$/;
const API_METHODS = new Set<LarkApiMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const CREDENTIAL_KEY = /(?:token|secret|password|credential|authorization|api[_-]?key)/i;
const MAX_JSON_ARGUMENT_BYTES = 256 * 1024;

function failure(message: string): LarkCliCallResult {
  return { ok: false, code: "invalid_request", message, attempted: false };
}

function isCallResult(value: readonly string[] | LarkCliCallResult): value is LarkCliCallResult {
  return !Array.isArray(value);
}

function containsCredentialKey(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsCredentialKey(item, seen));
  return Object.entries(value).some(([key, item]) => CREDENTIAL_KEY.test(key) || containsCredentialKey(item, seen));
}

function jsonArgument(value: unknown, name: string): string | LarkCliCallResult {
  if (containsCredentialKey(value)) return failure(`${name} contains a credential-like field`);
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return failure(`${name} must be JSON-serializable`);
  }
  if (encoded === undefined) return failure(`${name} must be JSON-serializable`);
  if (Buffer.byteLength(encoded, "utf8") > MAX_JSON_ARGUMENT_BYTES) return failure(`${name} is too large`);
  return encoded;
}

function validateApiRequest(request: LarkApiRequest): LarkCliCallResult | undefined {
  if (!request || !API_METHODS.has(request.method)) {
    return failure("method must be one of GET, POST, PUT, PATCH or DELETE");
  }
  if (typeof request.path !== "string" || request.path.length > 4096 || !OPEN_API_PATH.test(request.path) || request.path.includes("?") || request.path.includes("#") || request.path.includes("\\")) {
    return failure("path must be an absolute /open-apis/ path without query or shell syntax");
  }
  if (request.path.split("/").some((segment) => segment === "." || segment === "..") || /%0[0-9a-f]|%1[0-9a-f]|%2e|%2f|%5c/i.test(request.path)) return failure("path cannot contain dot, control or encoded separator segments");
  if (request.method === "GET" && request.data !== undefined) return failure("GET requests cannot carry a data body");
  if (request.params !== undefined) {
    if (typeof request.params !== "object" || request.params === null || Array.isArray(request.params)) return failure("params must be a JSON object");
    const params = jsonArgument(request.params, "params");
    if (typeof params !== "string") return params;
  }
  if (request.data !== undefined) {
    const data = jsonArgument(request.data, "data");
    if (typeof data !== "string") return data;
  }
  return undefined;
}

/** Validate a structured request without invoking a transport or child process. */
export function validateLarkApiRequest(request: LarkApiRequest): LarkCliCallResult | undefined {
  return validateApiRequest(request);
}

function apiArgs(request: LarkApiRequest): readonly string[] | LarkCliCallResult {
  const invalid = validateApiRequest(request);
  if (invalid) return invalid;
  const args: string[] = ["api", request.method, request.path];
  if (request.params !== undefined) {
    const params = jsonArgument(request.params, "params");
    if (typeof params !== "string") return params;
    args.push("--params", params);
  }
  if (request.data !== undefined) {
    const data = jsonArgument(request.data, "data");
    if (typeof data !== "string") return data;
    args.push("--data", data);
  }
  return args;
}

/**
 * Structured API facade over LocalLarkCli. Raw argv remains available through
 * execute for discovery-driven commands, while API calls cannot smuggle a
 * profile, shell fragment or credential field in their path/body.
 */
export class LocalLarkTransport implements LarkTransport {
  constructor(readonly cli: LocalLarkCli) {}

  status(): Promise<LarkCliStatusResult> {
    return this.cli.status();
  }

  discover(skill?: string): Promise<LarkCliDiscoverResult> {
    return this.cli.discover(skill);
  }

  execute(request: LarkCliExecuteRequest): Promise<LarkCliCallResult> {
    return this.cli.execute(request);
  }

  read(args: readonly string[], expectedRevision?: string): Promise<LarkCliCallResult> {
    return this.cli.execute({ args, effect: "read", expectedRevision });
  }

  write(args: readonly string[], expectedRevision?: string): Promise<LarkCliCallResult> {
    return this.cli.execute({ args, effect: "write", expectedRevision });
  }

  async api(request: LarkApiRequest): Promise<LarkCliCallResult> {
    const args = apiArgs(request);
    if (isCallResult(args)) return args;
    return this.cli.execute({ args, effect: request.method === "GET" ? "read" : "write", expectedRevision: request.expectedRevision });
  }
}

/**
 * Deterministic fixture transport for plugin and API-contract tests. It never
 * starts a process or contacts Lark. A host still owns write approval; this
 * class only records the call after the host has decided to invoke it.
 */
export class MockLarkTransport implements LarkTransport {
  readonly calls: LarkMockCall[] = [];
  private readonly fixtures: LarkMockFixtures;
  private readonly credentialRevision: string;

  constructor(fixtures: LarkMockFixtures = {}) {
    this.fixtures = fixtures;
    this.credentialRevision = fixtures.status?.credentialRevision ?? "mock-revision";
  }

  async status(): Promise<LarkCliStatusResult> {
    return {
      ok: true,
      status: "ready",
      accountRef: "mock-account",
      profileRef: "mock-profile",
      credentialRevision: "mock-revision",
      ...this.fixtures.status,
    };
  }

  async discover(skill?: string): Promise<LarkCliDiscoverResult> {
    if (skill !== undefined && (typeof skill !== "string" || skill.includes("\0") || skill.startsWith("-"))) return { ...failure("invalid skill name"), skill };
    return {
      ok: true,
      value: skill ? (this.fixtures.skill ?? { name: skill, description: "mock Lark capability", version: "mock" }) : (this.fixtures.skills ?? [{ name: "lark-im", description: "mock messaging capability", version: "mock" }]),
      skill,
      outcome: "success",
      attempted: false,
    };
  }

  async execute(request: LarkCliExecuteRequest): Promise<LarkCliCallResult> {
    return this.mockExecute(request, "execute");
  }

  read(args: readonly string[], expectedRevision?: string): Promise<LarkCliCallResult> {
    return this.mockExecute({ args, effect: "read", expectedRevision }, "read");
  }

  write(args: readonly string[], expectedRevision?: string): Promise<LarkCliCallResult> {
    return this.mockExecute({ args, effect: "write", expectedRevision }, "write");
  }

  private async mockExecute(request: LarkCliExecuteRequest, operation: "read" | "write" | "execute"): Promise<LarkCliCallResult> {
    if (!request || !Array.isArray(request.args)) return failure("args must be an array");
    if (request.effect !== "read" && request.effect !== "write") return failure("effect must be read or write");
    if (request.expectedRevision !== undefined && request.expectedRevision !== this.credentialRevision) return { ok: false, code: "revision_mismatch", message: "credential revision is stale", attempted: false };
    const args = [...request.args];
    const invalid = validateLarkCliArguments(args);
    if (invalid) return failure(invalid);
    this.calls.push({ operation, args });
    return {
      ok: true,
      value: request.effect === "write" ? (this.fixtures.write ?? { mocked: true, effect: "write", args }) : (this.fixtures.read ?? { mocked: true, effect: "read", args }),
      outcome: "success",
      attempted: false,
    };
  }

  async api(request: LarkApiRequest): Promise<LarkCliCallResult> {
    const args = apiArgs(request);
    if (isCallResult(args)) return args;
    if (request.expectedRevision !== undefined && request.expectedRevision !== this.credentialRevision) return { ok: false, code: "revision_mismatch", message: "credential revision is stale", attempted: false };
    this.calls.push({ operation: "api", request: { ...request } });
    return {
      ok: true,
      value: request.method === "GET" ? (this.fixtures.read ?? { mocked: true, effect: "read", args }) : (this.fixtures.write ?? { mocked: true, effect: "write", args }),
      outcome: "success",
      attempted: false,
    };
  }
}

