import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { fileURLToPath } from "node:url";
import { TigerError } from "./errors.js";
import { compileFilterRules, type FilterRule, type RuleMatch } from "./filter.js";
import type { AppConfig, FilterAction, PermissionPolicy, RouterProviderConfig, RuntimeConfig } from "./types.js";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_SUMMARY_MAX_CHARS } from "./types.js";

export function defaultRulesPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "rules.default.toml");
}

export const DEFAULT_FILTER_VERSION = "2026-11-19.1";

export function loadDefaultPolicy(): { version: string; rules: FilterRule[] } {
  const raw = parse(readFileSync(defaultRulesPath(), "utf8")) as Record<string, unknown>;
  const version = typeof raw.version === "string" ? raw.version : DEFAULT_FILTER_VERSION;
  return { version, rules: parseRules(raw.rules) };
}

export function loadDefaultRules(): FilterRule[] {
  return loadDefaultPolicy().rules;
}

export function defaultConfig(): AppConfig {
  return {
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    cancelGraceMs: 5_000,
    summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS,
    defaultWorkerRuntime: "worker",
    maxConcurrency: 4,
    filter: {
      version: loadDefaultPolicy().version,
      defaultAction: "candidate",
      rules: loadDefaultRules(),
    },
    runtimes: [],
  };
}

export function configPath(override?: string): string {
  if (override) return override;
  if (process.env.TIGERCAT_CONFIG) return process.env.TIGERCAT_CONFIG;
  return path.join(homedir(), ".tigercat", "config.toml");
}

export function loadConfig(file = configPath()): AppConfig {
  if (!existsSync(file)) return defaultConfig();
  const raw = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return normalizeConfig(raw);
}

export function saveConfig(config: AppConfig, file = configPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, stringify(serializeConfig(config)));
}

export function upsertRuntime(config: AppConfig, runtime: RuntimeConfig): AppConfig {
  if (!runtime.name || !runtime.command) {
    throw new TigerError("invalid_args", "runtime name and command are required");
  }
  const runtimes = config.runtimes.filter((entry) => entry.name !== runtime.name);
  runtimes.push(runtime);
  return { ...config, runtimes };
}

export function removeRuntime(config: AppConfig, name: string): AppConfig {
  const next = config.runtimes.filter((entry) => entry.name !== name);
  if (next.length === config.runtimes.length) {
    throw new TigerError("unknown_runtime", `unknown runtime ${name}`);
  }
  return { ...config, runtimes: next };
}

function normalizeConfig(raw: Record<string, unknown>): AppConfig {
  const base = defaultConfig();
  const filterRaw = asRecord(raw.filter);
  const rulesRaw = Array.isArray(filterRaw.rules) ? filterRaw.rules : [];
  return {
    idleTimeoutMs: numberOr(raw.idle_timeout_ms, base.idleTimeoutMs),
    cancelGraceMs: numberOr(raw.cancel_grace_ms, base.cancelGraceMs),
    summaryMaxChars: numberOr(raw.summary_max_chars, base.summaryMaxChars),
    coordinatorRuntime: stringOrUndefined(raw.coordinator_runtime),
    routerProvider: normalizeRouter(raw.router),
    defaultWorkerRuntime: stringOr(raw.default_worker_runtime, base.defaultWorkerRuntime),
    maxConcurrency: numberOr(raw.max_concurrency, base.maxConcurrency),
    filter: {
      version: stringOr(filterRaw.version, base.filter.version),
      defaultAction: actionOr(filterRaw.default, "candidate"),
      rules: compileLoaded(
        raw.filter === undefined || filterRaw.rules === undefined
          ? loadDefaultRules()
          : rulesRaw.map((rule) => normalizeRule(asRecord(rule))),
      ),
    },
    runtimes: (Array.isArray(raw.runtimes) ? raw.runtimes : []).map((entry) =>
      normalizeRuntime(asRecord(entry)),
    ),
  };
}

function serializeConfig(config: AppConfig): Record<string, unknown> {
  return {
    idle_timeout_ms: config.idleTimeoutMs,
    cancel_grace_ms: config.cancelGraceMs,
    summary_max_chars: config.summaryMaxChars,
    ...(config.coordinatorRuntime ? { coordinator_runtime: config.coordinatorRuntime } : {}),
    ...(config.routerProvider
      ? {
          router: {
            provider: config.routerProvider.provider,
            base_url: config.routerProvider.baseUrl,
            model: config.routerProvider.model,
            api_key_env: config.routerProvider.apiKeyEnv,
          },
        }
      : {}),
    default_worker_runtime: config.defaultWorkerRuntime,
    max_concurrency: config.maxConcurrency,
    filter: {
      version: config.filter.version,
      default: config.filter.defaultAction,
      rules: config.filter.rules.map((rule) => ({
        ...(rule.name ? { name: rule.name } : {}),
        outcome: rule.outcome,
        ...(rule.interrupt ? { interrupt: true } : {}),
        ...(rule.match ? { match: rule.match } : {}),
      })),
    },
    runtimes: config.runtimes.map((runtime) => ({
      name: runtime.name,
      command: runtime.command,
      args: runtime.args,
      env: Object.entries(runtime.env).map(([key, value]) => `${key}=${value}`),
      tags: runtime.tags,
      description: runtime.description,
      permission: runtime.permission,
    })),
  };
}

function normalizeRouter(value: unknown): RouterProviderConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.default_worker_runtime !== undefined) {
    throw new TigerError(
      "invalid_args",
      "default_worker_runtime belongs at the top level of the config. A copy inside [router] is ignored by the loader and was rejected.",
    );
  }
  if (raw.provider !== "deepseek") return undefined;
  return {
    provider: "deepseek",
    baseUrl: stringOr(raw.base_url, "https://api.deepseek.com"),
    model: stringOr(raw.model, "deepseek-flash"),
    apiKeyEnv: stringOr(raw.api_key_env, "DEEPSEEK_API_KEY"),
  };
}

function parseRules(value: unknown): FilterRule[] {
  if (!Array.isArray(value)) return [];
  return compileLoaded(value.map((entry) => normalizeRule(asRecord(entry))));
}

function compileLoaded(rules: FilterRule[]): FilterRule[] {
  compileFilterRules(rules);
  return rules;
}

function normalizeRule(raw: Record<string, unknown>): FilterRule {
  const outcome = actionOr(raw.outcome ?? raw.action, "respond");
  return {
    name: stringOrUndefined(raw.name),
    match: normalizeMatch(raw.match),
    outcome,
    interrupt: raw.interrupt === true,
  };
}

function normalizeMatch(value: unknown): RuleMatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const match: RuleMatch = {};
  if (raw.source !== undefined) match.source = stringOrList(raw.source);
  if (raw.thread_id_prefix !== undefined) match.thread_id_prefix = stringOrList(raw.thread_id_prefix);
  if (raw.kind !== undefined) match.kind = stringOrList(raw.kind);
  if (typeof raw.is_bot === "boolean") match.is_bot = raw.is_bot;
  if (typeof raw.text === "string") match.text = raw.text;
  if (typeof raw.has_subscriber === "boolean") match.has_subscriber = raw.has_subscriber;
  if (raw.not && typeof raw.not === "object") {
    const nested = normalizeMatch(raw.not);
    if (nested) match.not = nested;
  }
  return match;
}

function stringOrList(value: unknown): string | string[] {
  if (Array.isArray(value)) return value.map(String);
  return String(value);
}

function normalizeRuntime(raw: Record<string, unknown>): RuntimeConfig {
  return {
    name: stringOr(raw.name, ""),
    command: stringOr(raw.command, ""),
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: normalizeEnv(raw.env),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    description: stringOr(raw.description, ""),
    permission: permissionOr(raw.permission),
  };
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    const env: Record<string, string> = {};
    for (const entry of value) {
      const text = String(entry);
      const index = text.indexOf("=");
      if (index <= 0) continue;
      env[text.slice(0, index)] = text.slice(index + 1);
    }
    return env;
  }
  if (value && typeof value === "object") {
    const env: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      env[key] = String(item);
    }
    return env;
  }
  return {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function actionOr(value: unknown, fallback: FilterAction): FilterAction {
  if (value === "respond" || value === "candidate" || value === "ignore") return value;
  return fallback;
}

function permissionOr(value: unknown): PermissionPolicy {
  if (value === "auto" || value === "ask" || value === "deny") return value;
  return "ask";
}
