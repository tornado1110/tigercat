import path from "node:path";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { deriveAwaitingInput } from "./awaiting.js";
import { AcpRouterBrain, ScriptedRouter, type RouterBrain, type ToolApi } from "./brains.js";
import { admit } from "./filter.js";
import type { Clock, ClockTimer } from "./clock.js";
import { TigerError } from "./errors.js";
import { newId } from "./ids.js";
import { decidePermission, type PermissionOption } from "./permissions.js";
import { SecretRegistry } from "./redact.js";
import { resolveRuntime } from "./builtins.js";
import type { LaunchContext, RuntimeFactory, RuntimeHandle } from "./runtime.js";
import { spill } from "./spill.js";
import { acceptsSend, assertTransition, isTerminal } from "./state.js";
import type { Store, TriggerIngestResult } from "./store.js";
import { optionalNumber, optionalString, requireString } from "./tools.js";
import type {
  AppConfig,
  EventType,
  PermissionPolicy,
  RuntimeConfig,
  SessionRecord,
  SessionState,
  SpawnRequest,
  SpawnResult,
  TigerEvent,
  TriggerInput,
  TriggerRecord,
} from "./types.js";
import { ROUTER_SESSION_ID } from "./types.js";
import { prepareWorkspace, type Workspace } from "./worktree.js";

function ingressFingerprint(input: TriggerInput): string {
  // Defaulted fields have the same meaning on a provider's retry. Arrival
  // time is deliberately excluded; timestamp is the external event's time.
  return createHash("sha256").update(JSON.stringify([
    input.thread,
    input.author,
    input.text,
    input.timestamp,
    input.kind ?? "im.message",
    input.isBot ?? false,
    input.replyTo ?? null,
  ])).digest("hex");
}

export interface EngineOptions {
  store: Store;
  clock: Clock;
  config: AppConfig;
  factory: RuntimeFactory;
  brain?: RouterBrain;
  /** Absolute command used when a downstream agent launches the TigerCat MCP server. */
  mcpLaunch?: { command: string; argsPrefix: string[] };
  /** Base directory for worker workspaces when spawn has no cwd. */
  workspaceRoot?: string;
  /** Independent human approval deadline; no response ever implies approval. */
  permissionTimeoutMs?: number;
}

export interface PendingPermission {
  permissionId: string;
  workerId: string;
  role: "router" | "worker";
  toolCallId: string;
  title: string;
  kind: string;
  input?: unknown;
  options: PermissionOption[];
  createdAt: number;
  expiresAt: number;
}

export interface PermissionResponseInput {
  workerId: string;
  permissionId: string;
  decision: { outcome: "selected"; optionId: string; optionKind: string } | { outcome: "cancelled" };
}

export type PermissionHandler = (request: PendingPermission) => void | Promise<void>;

interface PermissionWaiter {
  request: PendingPermission;
  /** Public IDs may be opaque replacements for secret-bearing native IDs. */
  nativeOptions: Map<string, PermissionOption>;
  resolve: (response: RequestPermissionResponse) => void;
  timer: ClockTimer;
}

export type IngestResult = TriggerIngestResult;

type Listener = (event: TigerEvent) => void;
type Hook = (event: TigerEvent) => void | Promise<void>;

interface LiveWorker {
  handle?: RuntimeHandle;
  workspace?: Workspace;
  stall?: ClockTimer;
  grace?: ClockTimer;
  busy: boolean;
  pumping: boolean;
  pumpAgain: boolean;
  terminalEmitted: boolean;
  /** Set for `kill()` so the process exit is not treated as a crash. */
  suppressExit: boolean;
}

/**
 * The resident coordinator. Durable objects (triggers, threads, workers,
 * subscriptions, the event log, the router queue) are in {@link Store}.
 * This object only holds live process handles and timers.
 */
export class Engine {
  readonly store: Store;
  readonly clock: Clock;
  readonly config: AppConfig;
  private readonly factory: RuntimeFactory;
  private brain: RouterBrain;
  private readonly secrets = new SecretRegistry();
  private readonly live = new Map<string, LiveWorker>();
  private readonly hooks = new Set<Hook>();
  private readonly listeners = new Set<Listener>();
  private readonly waitClosers = new Set<() => void>();
  private readonly permissionWaiters = new Map<string, PermissionWaiter>();
  private readonly permissionHandlers = new Set<PermissionHandler>();
  private readonly permissionTimeoutMs: number;
  private launchInflight = 0;
  private spawnAdmission: Promise<void> = Promise.resolve();
  private readonly interrupting = new Set<string>();
  private readonly ingests = new Map<string, { fingerprint: string; result: Promise<IngestResult> }>();
  private busy = false;
  private flushScheduled = false;
  private flushAgain = false;
  private flushing: Promise<void> | null = null;
  private ipc: { port: number; token: string; mcpCommand: (role: "router" | "worker") => LaunchContext["mcpServers"] } | undefined;
  private closed = false;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.clock = options.clock;
    this.config = options.config;
    this.factory = options.factory;
    this.brain =
      options.brain ??
      new ScriptedRouter(options.config.defaultWorkerRuntime);
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 10 * 60_000;
    if (!Number.isFinite(this.permissionTimeoutMs) || this.permissionTimeoutMs <= 0) {
      throw new TigerError("invalid_args", "permissionTimeoutMs must be a positive finite number");
    }
    this.secrets.noteProcessEnv(process.env);
    for (const runtime of options.config.runtimes) this.secrets.noteEnv(runtime.env);
    this.mcpLaunch = options.mcpLaunch;
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
  }

  private readonly mcpLaunch?: { command: string; argsPrefix: string[] };
  private readonly workspaceRoot: string;

  tools: ToolApi = {
    spawn: (input) => this.spawn(input),
    resume: (id, input) => this.resume(id, input),
    list: () => this.list(),
    send: (id, input) => this.send(id, input),
    read: (id, since) => this.read(id, since),
    interrupt: (id) => this.interrupt(id),
    wait: (ids, mode, timeout) => this.wait(ids, mode, timeout),
    kill: (id) => this.kill(id),
    subscribe: (worker, thread) => this.subscribe(worker, thread),
    unsubscribe: (worker, thread) => this.unsubscribe(worker, thread),
  };

  attachIpc(ipc: NonNullable<Engine["ipc"]>): void {
    this.ipc = ipc;
    this.secrets.noteEnv({ TIGERCAT_IPC_TOKEN: ipc.token });
  }

  useBrain(brain: RouterBrain): void {
    this.brain = brain;
  }

  addHook(hook: Hook): () => void {
    this.hooks.add(hook);
    return () => this.hooks.delete(hook);
  }

  /** Trusted host UI only: a model must never approve its own Worker. */
  addPermissionHandler(handler: PermissionHandler): () => void {
    this.permissionHandlers.add(handler);
    return () => this.permissionHandlers.delete(handler);
  }

  pendingPermissions(workerId?: string): PendingPermission[] {
    return [...this.permissionWaiters.values()]
      .filter((waiter) => workerId === undefined || waiter.request.workerId === workerId)
      .map((waiter) => JSON.parse(JSON.stringify(waiter.request)) as PendingPermission);
  }

  respondPermission(input: PermissionResponseInput): { status: "resolved"; permissionId: string; workerId: string } {
    requireString(input.workerId, "workerId");
    requireString(input.permissionId, "permissionId");
    const waiter = this.permissionWaiters.get(input.permissionId);
    if (!waiter) throw new TigerError("permission_not_pending", "Permission request is unknown, expired, or already answered");
    if (waiter.request.workerId !== input.workerId) throw new TigerError("permission_worker_mismatch", "Permission request belongs to a different Worker");
    if (this.closed || this.clock.now() >= waiter.request.expiresAt) {
      this.completePermission(input.permissionId, { outcome: { outcome: "cancelled" } });
      throw new TigerError("permission_expired", "Permission request is no longer active");
    }
    const decision = input.decision;
    if (decision?.outcome === "cancelled") {
      this.completePermission(input.permissionId, { outcome: { outcome: "cancelled" } });
    } else if (decision?.outcome === "selected") {
      const option = waiter.nativeOptions.get(decision.optionId);
      if (!option || option.kind !== decision.optionKind) {
        throw new TigerError("invalid_permission_option", "Choose an exact option and kind from this permission request");
      }
      this.completePermission(input.permissionId, { outcome: { outcome: "selected", optionId: option.optionId } });
    } else {
      throw new TigerError("invalid_permission_decision", "Permission decision must explicitly select an option or cancel");
    }
    return { status: "resolved", permissionId: input.permissionId, workerId: input.workerId };
  }

  async start(): Promise<void> {
    await this.ensureRouterSession();
    await this.store.resetInflightRouterItems();
    await this.store.setMeta("router_busy", "0");
    const sessions = await this.store.listSessions("worker");
    for (const session of sessions) {
      if (isTerminal(session.state)) continue;
      // No live handle survives the process. That is an abnormal exit:
      // release every subscription so the Thread goes back through the Router.
      // interrupt() does not do this; only kill and this path do.
      await this.transition(session.id, "interrupted");
      await this.releaseSubscriptions(session.id);
      await this.emit("worker.error", session.id, {
        message: "worker process was not alive after restart",
        code: "interrupted",
      });
    }
    this.scheduleFlush();
  }

  /**
   * Launch the configured coordinator runtime, if any, and route its
   * turns through ACP. Without one, the scripted brain is the Router.
   */
  async launchCoordinator(): Promise<void> {
    const name = this.config.coordinatorRuntime;
    if (!name) return;
    const runtime = this.runtimeByName(name);
    if (!this.ipc) {
      throw new TigerError("ipc_required", "coordinator MCP endpoint is not listening");
    }
    const mcpServers = this.ipc.mcpCommand("router");
    const cwd = this.workspaceRoot;
    const handle = await this.factory.launch(runtime, {
      cwd,
      role: "router",
      mcpServers,
      onUpdate: () => undefined,
      onPermission: (request) => this.answerPermission(ROUTER_SESSION_ID, "router", runtime.permission, request),
    });
    const live = this.liveOf(ROUTER_SESSION_ID);
    live.handle = handle;
    await this.store.updateSession(ROUTER_SESSION_ID, {
      state: "idle",
      runtime: runtime.name,
      cwd,
      pid: handle.pid ?? null,
      acpSessionId: handle.acpSessionId ?? null,
      updatedAt: this.clock.now(),
    });
    this.brain = new AcpRouterBrain(
      async (text) => handle.prompt(text),
      this.config.summaryMaxChars,
    );
  }

  async ingest(input: TriggerInput): Promise<IngestResult> {
    // Inputs without a provider identity remain independent submissions.
    if (input.id === undefined) return this.ingestNew(input, newId("trg"));
    requireString(input.id, "id");
    const snapshot = { ...input };
    const key = JSON.stringify([snapshot.source, snapshot.id]);
    const fingerprint = ingressFingerprint(snapshot);
    const pending = this.ingests.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        throw new TigerError("ingest_identity_conflict", "External event identity was reused with different content");
      }
      const result = await pending.result;
      return { ...result, deliveredTo: [...result.deliveredTo] };
    }
    const result = this.ingestIdentified(snapshot, fingerprint);
    this.ingests.set(key, { fingerprint, result });
    try {
      const receipt = await result;
      return { ...receipt, deliveredTo: [...receipt.deliveredTo] };
    } finally {
      this.ingests.delete(key);
    }
  }

  private async ingestIdentified(input: TriggerInput, fingerprint: string): Promise<IngestResult> {
    const externalId = input.id!;
    const claim = await this.store.claimIngress({
      source: input.source,
      externalId,
      fingerprint,
      triggerId: newId("trg"),
      createdAt: this.clock.now(),
    });
    if (!claim.claimed) {
      let originalFingerprint = claim.receipt.fingerprint;
      if (originalFingerprint === null) {
        const trigger = await this.store.getTrigger(claim.receipt.triggerId);
        const thread = trigger ? await this.store.getThread(trigger.threadId) : undefined;
        if (trigger && thread) originalFingerprint = ingressFingerprint({ ...trigger, thread: thread.key });
      }
      if (originalFingerprint !== null && originalFingerprint !== fingerprint) {
        throw new TigerError("ingest_identity_conflict", "External event identity was reused with different content");
      }
      if (claim.receipt.result) return claim.receipt.result;
      // Another process may still own this dispatch, or it may have crashed
      // after a side effect. Neither case authorizes a blind replay.
      throw new TigerError("ingest_incomplete", `Dispatch ${claim.receipt.triggerId} has no completed receipt; reconcile it before retrying`);
    }
    const result = await this.ingestNew(input, claim.receipt.triggerId);
    await this.store.completeIngress(input.source, externalId, fingerprint, result);
    return result;
  }

  private async ingestNew(input: TriggerInput, triggerId: string): Promise<IngestResult> {
    const thread = await this.store.upsertThread(input.thread, input.source, input.timestamp || this.clock.now());
    const subs = await this.activeSubscriptions(thread.id);
    const admission = admit(
      {
        source: input.source,
        thread_id: thread.key,
        kind: input.kind ?? "im.message",
        is_bot: input.isBot ?? false,
        text: input.text,
        has_subscriber: subs.length > 0,
      },
      this.config.filter,
    );
    const trigger: TriggerRecord = {
      id: triggerId,
      externalId: input.id ?? null,
      source: input.source,
      threadId: thread.id,
      author: input.author,
      text: input.text,
      timestamp: input.timestamp,
      kind: input.kind ?? "im.message",
      isBot: input.isBot ?? false,
      replyTo: input.replyTo ?? null,
      action: admission.outcome,
      rule: admission.rule,
      interrupt: admission.interrupt,
      createdAt: this.clock.now(),
    };
    await this.store.insertTrigger(trigger);
    await this.emit("trigger.ingested", ROUTER_SESSION_ID, {
      triggerId: trigger.id,
      externalId: trigger.externalId,
      threadId: thread.id,
      threadKey: thread.key,
      source: input.source,
      author: input.author,
      action: admission.outcome,
      rule: admission.rule,
      interrupt: admission.interrupt,
    });
    if (admission.outcome === "ignore") {
      await this.emit("trigger.ignored", ROUTER_SESSION_ID, {
        triggerId: trigger.id,
        threadId: thread.id,
        rule: admission.rule,
      });
      return {
        action: admission.outcome,
        triggerId: trigger.id,
        threadId: thread.id,
        deliveredTo: [],
        router: false,
        interrupt: false,
        rule: admission.rule,
      };
    }
    if (subs.length > 0 && admission.outcome === "respond") {
      if (admission.interrupt) {
        for (const sub of subs) {
          await this.interrupt(sub.workerId).catch(() => undefined);
        }
      }
      const deliveredTo: string[] = [];
      for (const sub of subs) {
        await this.deliverToWorker(sub.workerId, trigger, thread.key);
        deliveredTo.push(sub.workerId);
      }
      return {
        action: admission.outcome,
        triggerId: trigger.id,
        threadId: thread.id,
        deliveredTo,
        router: false,
        interrupt: admission.interrupt,
        rule: admission.rule,
      };
    }
    await this.store.enqueueRouter(
      {
        kind: "trigger",
        triggerId: trigger.id,
        threadId: thread.id,
        threadKey: thread.key,
        source: trigger.source,
        author: trigger.author,
        text: trigger.text,
        outcome: admission.outcome,
        rule: admission.rule,
      },
      this.clock.now(),
    );
    this.scheduleFlush();
    return {
      action: admission.outcome,
      triggerId: trigger.id,
      threadId: thread.id,
      deliveredTo: [],
      router: true,
      interrupt: false,
      rule: admission.rule,
    };
  }

  async spawn(input: SpawnRequest): Promise<SpawnResult> {
    if (this.closed) throw new TigerError("engine_closed", "Cannot start a Worker after Engine shutdown");
    const previous = this.spawnAdmission;
    let release!: () => void;
    this.spawnAdmission = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.closed) throw new TigerError("engine_closed", "Cannot start a Worker after Engine shutdown");
      return await this.spawnAdmitted(input);
    } finally {
      release();
    }
  }

  private async spawnAdmitted(input: SpawnRequest): Promise<SpawnResult> {
    const runtimeName = requireString(input.runtime, "runtime");
    const task = requireString(input.task ?? input.prompt, "task");
    const cwdArg = optionalString(input.cwd ?? input.repo, "cwd");
    const threadRefs = [
      ...(input.threads ?? []),
      ...(input.thread ? [input.thread] : []),
    ];
    const runtime = this.runtimeByName(runtimeName);
    const running = (await this.store.listSessions("worker")).filter(
      (session) => session.state === "starting" || session.state === "running",
    );
    if (this.closed) throw new TigerError("engine_closed", "Cannot start a Worker after Engine shutdown");
    if (running.length >= this.config.maxConcurrency) {
      throw new TigerError("max_concurrency", `max concurrency ${this.config.maxConcurrency} reached`);
    }
    const thread = threadRefs[0]
      ? await this.resolveThread(threadRefs[0], "task")
      : await this.store.upsertThread(newId("task"), "task", this.clock.now());
    const workerId = newId("wrk");
    const base = path.resolve(cwdArg ?? this.workspaceRoot);
    const workspace = await prepareWorkspace(base, workerId);
    if (this.closed) throw new TigerError("engine_closed", "Cannot start a Worker after Engine shutdown");
    const now = this.clock.now();
    const session: SessionRecord = {
      id: workerId,
      role: "worker",
      runtime: runtime.name,
      state: "starting",
      cwd: workspace.cwd,
      worktree: workspace.worktree,
      baseCwd: workspace.baseCwd,
      threadId: thread.id,
      acpSessionId: null,
      pid: null,
      seq: 0,
      paths: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.store.insertSession(session);
    const subscribeRefs = threadRefs.length > 0 ? threadRefs : [thread.id];
    for (const ref of subscribeRefs) {
      const target = await this.resolveThread(ref, "task");
      await this.store.addSubscription(workerId, target.id, now);
    }
    const live = this.liveOf(workerId);
    live.workspace = workspace;
    await this.emit("worker.spawned", workerId, {
      runtime: runtime.name,
      threadId: thread.id,
      cwd: workspace.cwd,
      worktree: workspace.worktree,
      task: this.secrets.redact(task),
    });
    void this.bootWorker(session, runtime, task).catch((error) => {
      if (this.closed) return;
      void this.failWorker(session.id, error).catch(() => undefined);
    });
    return { status: "started", workerId, threadId: thread.id };
  }

  /** Explicitly restore an interrupted Worker on its existing worktree.
   * The caller must provide new input; the old prompt is never replayed. */
  async resume(workerId: string, input: string): Promise<SpawnResult> {
    requireString(workerId, "workerId");
    requireString(input, "input");
    const previous = this.spawnAdmission;
    let release!: () => void;
    this.spawnAdmission = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.closed) throw new TigerError("engine_closed", "Cannot resume a Worker after Engine shutdown");
      const session = await this.requireWorker(workerId);
      if (session.state !== "interrupted") throw new TigerError("not_resumable", `worker ${workerId} is ${session.state}`);
      const live = this.live.get(workerId);
      if (live?.handle) throw new TigerError("worker_running", `worker ${workerId} still has a live runtime handle`);
      if (!session.cwd || !session.baseCwd) throw new TigerError("workspace_missing", `worker ${workerId} has no recoverable workspace`);
      await access(session.cwd);
      const running = (await this.store.listSessions("worker")).filter((item) => item.state === "starting" || item.state === "running");
      if (running.length >= this.config.maxConcurrency) throw new TigerError("max_concurrency", `max concurrency ${this.config.maxConcurrency} reached`);
      if (this.closed) throw new TigerError("engine_closed", "Cannot resume a Worker after Engine shutdown");
      const runtime = this.runtimeByName(session.runtime ?? this.config.defaultWorkerRuntime);
      const reset: LiveWorker = { busy: false, pumping: false, pumpAgain: false, terminalEmitted: false, suppressExit: false, workspace: { cwd: session.cwd, baseCwd: session.baseCwd, worktree: session.worktree } };
      this.live.set(workerId, reset);
      await this.transition(workerId, "starting");
      if (session.threadId) await this.store.addSubscription(workerId, session.threadId, this.clock.now());
      await this.emit("worker.update", workerId, { state: "starting", recovered: true, nativeSession: "new" });
      const resumed = { ...session, state: "starting" as const, pid: null, acpSessionId: null, updatedAt: this.clock.now() };
      void this.bootWorker(resumed, runtime, input).catch((error) => {
        if (!this.closed) void this.failWorker(workerId, error).catch(() => undefined);
      });
      return { status: "started", workerId, threadId: session.threadId ?? "" };
    } finally {
      release();
    }
  }

  async list(): Promise<Array<{ id: string; state: string; runtime: string | null; threadId: string | null }>> {
    const sessions = await this.store.listSessions("worker");
    return sessions.map((session) => ({
      id: session.id,
      state: session.state,
      runtime: session.runtime,
      threadId: session.threadId,
    }));
  }

  async send(id: string, input: string): Promise<{ status: "started" }> {
    requireString(id, "id");
    requireString(input, "input");
    const session = await this.requireWorker(id);
    if (!acceptsSend(session.state) || isTerminal(session.state)) {
      throw new TigerError("worker_finished", `worker ${id} is ${session.state}`);
    }
    await this.store.enqueueInbox({
      workerId: id,
      text: input,
      triggerId: "",
      createdAt: this.clock.now(),
    });
    void this.pumpInbox(id);
    return { status: "started" };
  }

  async read(id: string, since?: number): Promise<unknown> {
    requireString(id, "id");
    const sinceSeq = optionalNumber(since, "since");
    const session = await this.store.getSession(id);
    if (session) {
      const events = await this.store.listEvents({
        workerId: id,
        sinceSeq,
      });
      return {
        kind: "summary",
        id,
        since: sinceSeq ?? null,
        files: session.paths,
        state: session.state,
        events: events.map((event) => ({
          id: event.id,
          seq: event.seq,
          type: event.type,
          summary: spill(
            typeof event.payload.summary === "string"
              ? event.payload.summary
              : typeof event.payload.text === "string"
                ? event.payload.text
                : event.type,
            { eventId: event.id, workerId: id },
            this.config.summaryMaxChars,
          ),
        })),
        related: {
          threadId: session.threadId,
          runtime: session.runtime,
        },
      };
    }
    const trigger = await this.store.getTrigger(id);
    if (trigger) {
      const thread = await this.store.getThread(trigger.threadId);
      const subs = await this.store.subscriptionsForThread(trigger.threadId);
      return {
        kind: "trigger",
        id: trigger.id,
        text: trigger.text,
        source: trigger.source,
        author: trigger.author,
        threadId: trigger.threadId,
        threadKey: thread?.key,
        workerIds: subs.map((sub) => sub.workerId),
      };
    }
    const event = await this.store.getEvent(id);
    if (event) {
      return { kind: "event", ...event, continuation: `read(${event.workerId})` };
    }
    const thread = await this.store.getThread(id) ?? await this.store.getThreadByKey(id);
    if (thread) {
      const triggers = await this.store.listTriggers(thread.id);
      const subs = await this.store.subscriptionsForThread(thread.id);
      return {
        kind: "thread",
        id: thread.id,
        key: thread.key,
        triggerIds: triggers.map((item) => item.id),
        workerIds: subs.map((sub) => sub.workerId),
      };
    }
    throw new TigerError("unknown_id", `unknown id ${id}`);
  }

  async interrupt(id: string): Promise<{ status: "cancelled" }> {
    const session = await this.requireWorker(id);
    if (this.interrupting.has(id)) {
      throw new TigerError("double_interrupt", `worker ${id} interrupt is already in flight`);
    }
    if (session.state !== "running" && session.state !== "starting" && session.state !== "awaiting_input") {
      throw new TigerError("not_running", `worker ${id} is ${session.state}`);
    }
    this.interrupting.add(id);
    this.cancelPermissions(id);
    const live = this.liveOf(id);
    // A starting Worker may not have a native handle yet. runPrompt observes
    // the pending cancellation before submitting its first input.
    if (!live.handle) return { status: "cancelled" };
    // Arm before awaiting the native acknowledgement: that await can outlive
    // this turn, and a late timer must never cancel the following turn.
    live.grace = this.clock.setTimeout(() => {
      void this.forceCancel(id);
    }, this.config.cancelGraceMs);
    await live.handle.cancel().catch(() => undefined);
    return { status: "cancelled" };
  }

  async wait(ids: string[], mode: "any" | "all", timeout: number): Promise<{ status: string; done: string[] }> {
    if (mode !== "any" && mode !== "all") {
      throw new TigerError("invalid_args", "mode must be any or all");
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new TigerError("invalid_args", "ids must be a non-empty list");
    }
    if (this.closed) return { status: "closed", done: [] };
    const done = () => this.workersSatisfied(ids);
    const immediate = await done();
    if (this.closed) return { status: "closed", done: [] };
    if (mode === "any" && immediate.length > 0) return { status: "ok", done: immediate };
    if (mode === "all" && immediate.length === ids.length) return { status: "ok", done: immediate };
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        this.clock.clearTimeout(timer);
        this.listeners.delete(listener);
        this.waitClosers.delete(onClose);
      };
      const finish = (status: string, ready: string[]) => {
        if (settled) return;
        cleanup();
        resolve({ status, done: ready });
      };
      const onClose = () => finish("closed", []);
      const inspect = (status: "ok" | "timeout") => {
        if (settled) return;
        if (this.closed) return onClose();
        void done().then((ready) => {
          if (this.closed) return onClose();
          if (status === "timeout" || (mode === "any" ? ready.length > 0 : ready.length === ids.length)) finish(status, ready);
        }, (error: unknown) => {
          if (settled) return;
          if (this.closed) return onClose();
          cleanup();
          reject(error);
        });
      };
      const listener = () => inspect("ok");
      const timer = this.clock.setTimeout(() => inspect("timeout"), timeout);
      this.waitClosers.add(onClose);
      this.listeners.add(listener);
      // Cover a Worker settling between the initial snapshot and listener
      // registration, without waiting for another unrelated event.
      listener();
    });
  }

  async kill(id: string): Promise<{ status: "killed"; idempotent?: boolean }> {
    const session = await this.requireWorker(id);
    if (session.state === "killed") return { status: "killed", idempotent: true };
    const live = this.live.get(id);
    if (live) {
      // Mark the session terminal before awaiting process shutdown. A prompt
      // can resolve concurrently with kill(); without this guard its late
      // turn_end transition could move the session back to idle.
      live.suppressExit = true;
      live.terminalEmitted = true;
    }
    this.cancelPermissions(id);
    await live?.handle?.kill();
    if (live?.stall) this.clock.clearTimeout(live.stall);
    if (live?.grace) this.clock.clearTimeout(live.grace);
    await this.transition(id, "killed");
    await this.releaseSubscriptions(id);
    this.interrupting.delete(id);
    await this.emit("worker.update", id, { state: "killed", worktreeKept: session.cwd });
    return { status: "killed" };
  }

  async subscribe(worker: string, thread: string): Promise<{ status: "ok" }> {
    const session = await this.requireWorker(worker);
    const resolved = await this.resolveThread(thread, "task");
    await this.store.addSubscription(session.id, resolved.id, this.clock.now());
    if (!session.threadId) {
      await this.store.updateSession(session.id, { threadId: resolved.id, updatedAt: this.clock.now() });
    }
    return { status: "ok" };
  }

  async unsubscribe(worker: string, thread: string): Promise<{ status: "ok" }> {
    await this.requireWorker(worker);
    const resolved = await this.resolveThread(thread, "task");
    await this.store.removeSubscription(worker, resolved.id);
    return { status: "ok" };
  }

  async observePath(workerId: string, filePath: string): Promise<void> {
    const session = await this.requireWorker(workerId);
    const paths = session.paths.includes(filePath) ? session.paths : [...session.paths, filePath];
    await this.store.updateSession(workerId, { paths, updatedAt: this.clock.now() });
    const others = (await this.store.listSessions("worker")).filter(
      (other) =>
        other.id !== workerId &&
        !isTerminal(other.state) &&
        other.paths.includes(filePath),
    );
    if (others.length > 0) {
      await this.emit("worker.update", workerId, {
        overlap: true,
        path: filePath,
        otherWorkerIds: others.map((other) => other.id),
      });
    }
  }

  resolvePermission(workerId: string, optionId: string): void {
    const pending = [...this.permissionWaiters.values()].filter((waiter) => waiter.request.workerId === workerId);
    if (pending.length === 0) return;
    if (pending.length !== 1) throw new TigerError("ambiguous_permission_request", "Answer by permissionId when a Worker has multiple pending requests");
    const waiter = pending[0];
    const option = [...waiter.nativeOptions.entries()].find(([publicId, native]) => publicId === optionId || native.optionId === optionId);
    if (!option) throw new TigerError("invalid_permission_option", "Choose an option from the pending permission request");
    this.respondPermission({ workerId, permissionId: waiter.request.permissionId, decision: { outcome: "selected", optionId: option[0], optionKind: option[1].kind } });
  }

  noteSecret(name: string, value: string): void {
    this.secrets.noteEnv({ [name]: value });
  }

  async routerDecisionCount(): Promise<number> {
    return (await this.store.listRouterTurns()).length;
  }

  async routerTurns() {
    return this.store.listRouterTurns();
  }

  async workers(): Promise<SessionRecord[]> {
    return this.store.listSessions("worker");
  }

  async events(): Promise<TigerEvent[]> {
    return this.store.listEvents({});
  }

  routerIsBusy(): boolean {
    return this.busy;
  }

  async settle(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      this.scheduleFlush();
      // scheduleFlush starts flushLoop in a microtask. Yield once so that
      // assignment is visible, then wait for that flush. Checking
      // this.flushing before the microtask runs left the promise in place
      // and fell through to setTimeout(0) on every attempt. Windows rounds
      // that timer up to about 16ms, so 50 waits on each of 300 rows did
      // not finish inside the CI test timeout.
      await Promise.resolve();
      if (this.flushing) await this.flushing;
      const pending = await this.store.hasPendingRouterItems();
      if (!this.busy && !this.flushing && !pending && this.launchInflight === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelPermissions();
    for (const close of this.waitClosers) close();
    for (const [, live] of this.live) {
      if (live.stall) this.clock.clearTimeout(live.stall);
      if (live.grace) this.clock.clearTimeout(live.grace);
      await live.handle?.kill().catch(() => undefined);
    }
    this.live.clear();
  }

  private async bootWorker(session: SessionRecord, runtime: RuntimeConfig, task: string): Promise<void> {
    this.launchInflight += 1;
    const live = this.liveOf(session.id);
    try {
      const handle = await this.factory.launch(runtime, this.launchContext(session, runtime));
      live.handle = handle;
      // Shutdown may already have closed the Store while launch was waiting
      // on a handshake. Reap the process before attempting any storage IO.
      if (this.closed || live.suppressExit) {
        await handle.kill();
        live.handle = undefined;
        return;
      }
      const current = await this.store.getSession(session.id);
      if (this.closed || live.suppressExit || !current || isTerminal(current.state)) {
        await handle.kill();
        live.handle = undefined;
        return;
      }
      await this.store.updateSession(session.id, {
        pid: handle.pid ?? null,
        acpSessionId: handle.acpSessionId ?? null,
        updatedAt: this.clock.now(),
      });
      if (this.closed || live.suppressExit) {
        await handle.kill();
        live.handle = undefined;
        return;
      }
      await this.transition(session.id, "running");
      this.armStall(session.id);
    } catch (error) {
      await this.failWorker(session.id, error);
      return;
    } finally {
      this.launchInflight -= 1;
    }
    await this.runPrompt(session.id, task);
  }

  private launchContext(session: SessionRecord, runtime: RuntimeConfig): LaunchContext {
    return {
      cwd: session.cwd ?? this.workspaceRoot,
      role: "worker",
      mcpServers: this.ipc?.mcpCommand("worker"),
      onUpdate: (update) => {
        const live = this.live.get(session.id);
        if (this.closed || !live || live.suppressExit || live.terminalEmitted) return;
        this.armStall(session.id);
        const payload: Record<string, unknown> = {
          sessionUpdate: update.sessionUpdate,
          text: update.text ? this.secrets.redact(update.text).slice(0, this.config.summaryMaxChars) : undefined,
          toolTitle: update.toolTitle,
          toolKind: update.toolKind,
        };
        void this.emit("worker.update", session.id, payload);
        for (const filePath of update.paths ?? []) void this.observePath(session.id, filePath);
      },
      onPermission: (request) =>
        this.answerPermission(session.id, "worker", runtime.permission, request),
      onExit: () => {
        const live = this.liveOf(session.id);
        if (live.suppressExit || this.closed) return;
        void this.failWorker(session.id, new TigerError("worker_exited", "runtime process exited"));
      },
    };
  }

  private async runPrompt(workerId: string, text: string): Promise<void> {
    const live = this.liveOf(workerId);
    const handle = live.handle;
    if (!handle || this.closed || live.suppressExit) return;
    live.busy = true;
    try {
      const result = this.interrupting.has(workerId)
        ? { stopReason: "cancelled", text: "" }
        : await handle.prompt(text);
      if (this.closed || live.suppressExit) return;
      const session = await this.store.getSession(workerId);
      if (!session || isTerminal(session.state)) return;
      const cancelled = this.interrupting.has(workerId);
      await this.finishTurn(workerId, cancelled ? "cancelled" : result.stopReason, cancelled ? "" : result.text);
    } catch (error) {
      if (this.closed || live.suppressExit) return;
      const session = await this.store.getSession(workerId);
      if (!session || isTerminal(session.state)) return;
      await this.failWorker(workerId, error);
    } finally {
      live.busy = false;
      this.interrupting.delete(workerId);
      if (live.grace) {
        this.clock.clearTimeout(live.grace);
        live.grace = undefined;
      }
      if (!this.closed) await this.pumpInbox(workerId);
    }
  }

  private async pumpInbox(workerId: string): Promise<void> {
    if (this.closed) return;
    const live = this.liveOf(workerId);
    if (live.pumping) {
      live.pumpAgain = true;
      return;
    }
    if (live.busy) return;
    // Reserve before the first storage await. Concurrent ingress can enqueue
    // more messages, but only this pump may submit prompts to the ACP session.
    live.pumping = true;
    try {
      while (!this.closed && !live.suppressExit) {
        live.pumpAgain = false;
        const session = await this.store.getSession(workerId);
        if (!session || isTerminal(session.state) || !live.handle) return;
        if (session.state !== "idle" && session.state !== "awaiting_input") return;
        const next = await this.store.claimInbox(workerId);
        if (!next) return;
        await this.transition(workerId, "running");
        this.armStall(workerId);
        await this.runPrompt(workerId, next.text);
        await this.store.completeInbox(next.id);
      }
    } finally {
      live.pumping = false;
      // An enqueue can race the empty inbox read. Its wakeup must survive
      // releasing this reservation, even if no turn ran in this pump.
      if (live.pumpAgain && !this.closed && !live.suppressExit) {
        live.pumpAgain = false;
        void this.pumpInbox(workerId);
      }
    }
  }

  private async deliverToWorker(workerId: string, trigger: TriggerRecord, threadKey: string): Promise<void> {
    const summary = spill(trigger.text, {
      kind: "trigger",
      triggerId: trigger.id,
      threadId: trigger.threadId,
      threadKey,
      source: trigger.source,
      author: trigger.author,
    }, this.config.summaryMaxChars);
    await this.emit("trigger.delivered", workerId, {
      triggerId: trigger.id,
      threadId: trigger.threadId,
      summary,
      text: trigger.text,
    });
    await this.store.enqueueInbox({
      workerId,
      text: summary,
      triggerId: trigger.id,
      createdAt: this.clock.now(),
    });
    void this.pumpInbox(workerId);
  }

  private async finishTurn(workerId: string, stopReason: string, text: string): Promise<void> {
    if (this.closed) return;
    const live = this.liveOf(workerId);
    if (live.suppressExit || live.terminalEmitted) return;
    this.cancelPermissions(workerId);
    if (live.stall) this.clock.clearTimeout(live.stall);
    const awaitingInput = deriveAwaitingInput(stopReason, text);
    const next: SessionState = awaitingInput ? "awaiting_input" : "idle";
    await this.transition(workerId, next);
    const summary = spill(text || stopReason, {
      event: "worker.turn_end",
      workerId,
      stopReason,
      awaitingInput,
    }, this.config.summaryMaxChars);
    const event = await this.emit("worker.turn_end", workerId, {
      stopReason,
      awaitingInput,
      summary,
      text,
    });
    const session = await this.store.getSession(workerId);
    await this.store.enqueueRouter(
      {
        kind: "worker_event",
        eventId: event.id,
        eventType: "worker.turn_end",
        workerId,
        threadId: session?.threadId ?? null,
        summary,
        stopReason,
        awaitingInput,
      },
      this.clock.now(),
    );
    this.scheduleFlush();
  }

  private async failWorker(workerId: string, error: unknown): Promise<void> {
    if (this.closed) return;
    const live = this.liveOf(workerId);
    if (live.terminalEmitted) return;
    live.terminalEmitted = true;
    this.cancelPermissions(workerId);
    if (live.stall) this.clock.clearTimeout(live.stall);
    const session = await this.store.getSession(workerId);
    if (session && !isTerminal(session.state)) {
      try {
        await this.transition(workerId, "error");
      } catch {
        // already terminal
      }
    }
    await this.releaseSubscriptions(workerId);
    const message = error instanceof Error ? error.message : String(error);
    await this.emit("worker.error", workerId, {
      message: this.secrets.redact(message),
      code: error instanceof TigerError ? error.code : "error",
    });
  }

  private async forceCancel(workerId: string): Promise<void> {
    const session = await this.store.getSession(workerId);
    if (!session || session.state === "killed" || session.state === "idle" || session.state === "error") return;
    if (session.state !== "running" && session.state !== "starting" && session.state !== "awaiting_input") return;
    await this.kill(workerId);
  }

  private async releaseSubscriptions(workerId: string): Promise<void> {
    const subs = await this.store.subscriptionsForWorker(workerId);
    for (const sub of subs) {
      await this.store.removeSubscription(workerId, sub.threadId);
    }
  }

  private async activeSubscriptions(threadId: string) {
    const subs = await this.store.subscriptionsForThread(threadId);
    const active = [];
    for (const sub of subs) {
      const session = await this.store.getSession(sub.workerId);
      if (!session || isTerminal(session.state)) continue;
      active.push(sub);
    }
    return active;
  }

  private armStall(workerId: string): void {
    if (this.closed) return;
    const live = this.liveOf(workerId);
    if (live.suppressExit || live.terminalEmitted) return;
    if (live.stall) this.clock.clearTimeout(live.stall);
    live.stall = this.clock.setTimeout(() => {
      void this.onStalled(workerId);
    }, this.config.idleTimeoutMs);
  }

  private async onStalled(workerId: string): Promise<void> {
    if (this.closed) return;
    const session = await this.store.getSession(workerId);
    if (!session || session.state !== "running") return;
    const live = this.liveOf(workerId);
    if (live.terminalEmitted) return;
    live.terminalEmitted = true;
    this.cancelPermissions(workerId);
    await this.transition(workerId, "stalled");
    await this.emit("worker.stalled", workerId, {
      idleTimeoutMs: this.config.idleTimeoutMs,
    });
    await live.handle?.kill().catch(() => undefined);
  }

  private scheduleFlush(): void {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flushing = this.flushLoop()
        .catch((error) => {
          if (!this.closed) throw error;
        })
        .finally(() => {
          this.flushing = null;
        });
    });
  }

  private async flushLoop(): Promise<void> {
    if (this.closed) return;
    do {
      this.flushAgain = false;
      if (this.busy) return;
      const claimed = await this.store.claimRouterItems();
      if (claimed.length === 0) continue;
      this.busy = true;
      await this.store.setMeta("router_busy", "1");
      try {
        const items = claimed.map((entry) => entry.item);
        const result = await this.brain.decide({ items }, this.tools);
        await this.store.completeRouterItems(claimed.map((entry) => entry.id));
        const reply = spill(result.reply, { event: "coordinator.turn_end" }, this.config.summaryMaxChars);
        await this.store.recordRouterTurn({
          id: newId("turn"),
          itemCount: items.length,
          reply,
          items,
          createdAt: this.clock.now(),
        });
        await this.emit("coordinator.turn_end", ROUTER_SESSION_ID, {
          stopReason: "end_turn",
          itemCount: items.length,
          reply,
        });
      } catch (error) {
        await this.store.completeRouterItems(claimed.map((entry) => entry.id));
        const message = error instanceof Error ? error.message : String(error);
        await this.emit("coordinator.turn_end", ROUTER_SESSION_ID, {
          stopReason: "error",
          message: this.secrets.redact(message),
        });
      } finally {
        this.busy = false;
        await this.store.setMeta("router_busy", "0");
      }
    } while (this.flushAgain || (await this.store.hasPendingRouterItems()));
  }

  private async answerPermission(
    sessionId: string,
    role: "router" | "worker",
    policy: PermissionPolicy,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const toolCall = request.toolCall;
    const options = request.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    }));
    const decision = decidePermission(role, policy, {
      toolTitle: typeof toolCall.title === "string" ? toolCall.title : undefined,
      toolKind: typeof toolCall.kind === "string" ? toolCall.kind : undefined,
      options,
    });
    if (decision.type === "selected") {
      return { outcome: { outcome: "selected", optionId: decision.optionId } };
    }
    if (decision.type === "cancelled") {
      return { outcome: { outcome: "cancelled" } };
    }
      const permissionId = newId("perm");
      const createdAt = this.clock.now();
      const pending: PendingPermission = {
        permissionId,
        workerId: sessionId,
        role,
        toolCallId: String(toolCall.toolCallId),
        title: typeof toolCall.title === "string" ? this.secrets.redact(toolCall.title) : "",
        kind: typeof toolCall.kind === "string" ? toolCall.kind : "",
        input: toolCall.rawInput === undefined ? undefined : this.secrets.redactValue(toolCall.rawInput),
        options: options.map((option) => ({ ...option, name: this.secrets.redact(option.name) })),
        createdAt,
        expiresAt: createdAt + this.permissionTimeoutMs,
      };
      const nativeOptions = new Map(options.map((option) => [option.optionId, option]));
      const response = new Promise<RequestPermissionResponse>((resolve) => {
        const timer = this.clock.setTimeout(() => {
          this.completePermission(permissionId, { outcome: { outcome: "cancelled" } });
        }, this.permissionTimeoutMs);
        this.permissionWaiters.set(permissionId, { request: pending, nativeOptions, resolve, timer });
      });
      if (role === "worker") {
        await this.emit("worker.permission_request", sessionId, {
          permissionId,
          title: toolCall.title,
          kind: toolCall.kind,
          policy,
          decision: decision.type,
          options: pending.options,
        });
      }
      for (const handler of this.permissionHandlers) {
        try {
          const result = handler(JSON.parse(JSON.stringify(pending)) as PendingPermission);
          if (result && typeof (result as Promise<void>).then === "function") void (result as Promise<void>).catch(() => undefined);
        } catch {
          // A host UI failure must not keep an ACP request blocked forever.
        }
      }
      return response;
  }

  private completePermission(permissionId: string, response: RequestPermissionResponse): boolean {
    const waiter = this.permissionWaiters.get(permissionId);
    if (!waiter) return false;
    this.permissionWaiters.delete(permissionId);
    this.clock.clearTimeout(waiter.timer);
    waiter.resolve(response);
    return true;
  }

  private cancelPermissions(workerId?: string): void {
    for (const [permissionId, waiter] of this.permissionWaiters) {
      if (workerId !== undefined && waiter.request.workerId !== workerId) continue;
      this.completePermission(permissionId, { outcome: { outcome: "cancelled" } });
    }
  }

  private async ensureRouterSession(): Promise<void> {
    const existing = await this.store.getSession(ROUTER_SESSION_ID);
    if (existing) return;
    const now = this.clock.now();
    await this.store.insertSession({
      id: ROUTER_SESSION_ID,
      role: "router",
      runtime: this.config.coordinatorRuntime ?? null,
      state: "idle",
      cwd: this.workspaceRoot,
      worktree: false,
      baseCwd: this.workspaceRoot,
      threadId: null,
      acpSessionId: null,
      pid: null,
      seq: 0,
      paths: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  private async transition(id: string, to: SessionState): Promise<void> {
    const session = await this.store.getSession(id);
    if (!session) throw new TigerError("unknown_id", `unknown id ${id}`);
    assertTransition(session.state, to);
    await this.store.updateSession(id, { state: to, updatedAt: this.clock.now() });
  }

  private async emit(
    type: EventType,
    workerId: string,
    payload: Record<string, unknown>,
  ): Promise<TigerEvent> {
    const safe = this.secrets.redactValue(payload) as Record<string, unknown>;
    const event = await this.store.appendEvent({
      workerId,
      type,
      payload: safe,
      createdAt: this.clock.now(),
    });
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // internal listeners must not break the bus
      }
    }
    for (const hook of this.hooks) {
      this.clock.setTimeout(() => {
        try {
          const result = hook(event);
          if (result && typeof (result as Promise<void>).then === "function") {
            void (result as Promise<void>).catch(() => undefined);
          }
        } catch {
          // a failing hook never blocks the bus
        }
      }, 0);
    }
    return event;
  }

  private async requireWorker(id: string): Promise<SessionRecord> {
    const session = await this.store.getSession(id);
    if (!session || session.role !== "worker") {
      throw new TigerError("unknown_id", `unknown worker ${id}`);
    }
    return session;
  }

  private runtimeByName(name: string): RuntimeConfig {
    return resolveRuntime(this.config, name);
  }

  private async resolveThread(ref: string, source: string) {
    return (
      (await this.store.getThread(ref)) ??
      (await this.store.getThreadByKey(ref)) ??
      (await this.store.upsertThread(ref, source, this.clock.now()))
    );
  }

  private liveOf(id: string): LiveWorker {
    let live = this.live.get(id);
    if (!live) {
      live = { busy: false, pumping: false, pumpAgain: false, terminalEmitted: false, suppressExit: false };
      this.live.set(id, live);
    }
    return live;
  }

  private async workersSatisfied(ids: string[]): Promise<string[]> {
    const ready: string[] = [];
    for (const id of ids) {
      if (this.closed) break;
      const session = await this.store.getSession(id);
      if (!session) continue;
      if (session.state !== "starting" && session.state !== "running") ready.push(id);
    }
    return ready;
  }
}
