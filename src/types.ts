import type { FilterConfig } from "./filter.js";

export const EVENT_TYPES = [
  "worker.spawned",
  "worker.update",
  "worker.permission_request",
  "worker.turn_end",
  "worker.error",
  "worker.stalled",
  "coordinator.turn_end",
  "trigger.ingested",
  "trigger.ignored",
  "trigger.delivered",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type SessionRole = "router" | "worker";

export type SessionState =
  | "starting"
  | "running"
  | "idle"
  | "awaiting_input"
  | "stalled"
  | "cancelled"
  | "error"
  | "killed"
  | "finished"
  | "interrupted";

export type PermissionPolicy = "auto" | "ask" | "deny";

/** DeepSeek Chat Completions. Not an OpenAI or Anthropic credential. */
export interface RouterProviderConfig {
  provider: "deepseek";
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
}

export type FilterAction = "respond" | "candidate" | "ignore";

export interface RuntimeConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  tags: string[];
  description: string;
  permission: PermissionPolicy;
  /** Name only, resolved from the built-in adapter's user configuration. */
  providerCredentialEnv?: string;
  /** Pass the args to CreateProcess unchanged. Used for the cmd.exe fallback. */
  windowsVerbatimArguments?: boolean;
}

export interface AppConfig {
  idleTimeoutMs: number;
  cancelGraceMs: number;
  summaryMaxChars: number;
  coordinatorRuntime?: string;
  /** Tool-calling Router. Unset keeps the scripted brain. */
  routerProvider?: RouterProviderConfig;
  defaultWorkerRuntime: string;
  maxConcurrency: number;
  filter: FilterConfig;
  runtimes: RuntimeConfig[];
}

export interface SessionRecord {
  id: string;
  role: SessionRole;
  runtime: string | null;
  state: SessionState;
  cwd: string | null;
  worktree: boolean;
  baseCwd: string | null;
  threadId: string | null;
  acpSessionId: string | null;
  pid: number | null;
  seq: number;
  paths: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TigerEvent {
  id: string;
  seq: number;
  workerId: string;
  type: EventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface ThreadRecord {
  id: string;
  key: string;
  source: string;
  createdAt: number;
}

export interface TriggerRecord {
  id: string;
  externalId: string | null;
  source: string;
  threadId: string;
  author: string;
  text: string;
  timestamp: number;
  kind: string;
  isBot: boolean;
  replyTo: string | null;
  action: FilterAction | null;
  rule: string | null;
  interrupt: boolean;
  createdAt: number;
}

export interface SubscriptionRecord {
  workerId: string;
  threadId: string;
  createdAt: number;
}

export type RouterItem =
  | {
      kind: "trigger";
      triggerId: string;
      threadId: string;
      threadKey: string;
      source: string;
      author: string;
      text: string;
      outcome: FilterAction;
      rule: string | null;
    }
  | {
      kind: "worker_event";
      eventId: string;
      eventType: EventType;
      workerId: string;
      threadId: string | null;
      summary: string;
      stopReason?: string;
      awaitingInput?: boolean;
    };

export interface RouterTurnRecord {
  id: string;
  itemCount: number;
  reply: string;
  items: RouterItem[];
  createdAt: number;
}

export interface TriggerInput {
  /** Stable fixture id (`trg_…`). Stored for replay; the event log still mints its own ids. */
  id?: string;
  source: string;
  /** Thread key, the fixture `thread_id`. */
  thread: string;
  author: string;
  text: string;
  timestamp: number;
  kind?: string;
  isBot?: boolean;
  replyTo?: string | null;
}

export interface SpawnRequest {
  runtime: string;
  /** Task text. `prompt` is the issue #4 alias. */
  task?: string;
  prompt?: string;
  cwd?: string;
  /** Repository / workspace root. Alias of cwd. */
  repo?: string;
  thread?: string;
  /** Threads to subscribe the new Worker to. The first is the home Thread. */
  threads?: string[];
}

export interface SpawnResult {
  status: "started";
  workerId: string;
  threadId: string;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_SUMMARY_MAX_CHARS = 800;
export const ROUTER_SESSION_ID = "router";
