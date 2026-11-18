import { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.js";
import type {
  EventType,
  RouterItem,
  RouterTurnRecord,
  SessionRecord,
  SessionRole,
  SessionState,
  SubscriptionRecord,
  ThreadRecord,
  TigerEvent,
  TriggerRecord,
  FilterAction,
} from "./types.js";

/**
 * All durable TigerCat state lives behind this interface.
 * The running process keeps only live ACP sockets and timers.
 * A remote implementation can replace {@link SqliteStore} later
 * without changing the engine.
 */
export interface Store {
  appendEvent(input: {
    workerId: string;
    type: EventType;
    payload: Record<string, unknown>;
    createdAt: number;
  }): Promise<TigerEvent>;
  listEvents(query: { workerId?: string; sinceSeq?: number; type?: EventType }): Promise<TigerEvent[]>;
  getEvent(id: string): Promise<TigerEvent | undefined>;

  insertSession(session: SessionRecord): Promise<void>;
  updateSession(id: string, patch: Partial<SessionRecord>): Promise<void>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  listSessions(role?: SessionRole): Promise<SessionRecord[]>;

  upsertThread(key: string, source: string, createdAt: number): Promise<ThreadRecord>;
  getThread(id: string): Promise<ThreadRecord | undefined>;
  getThreadByKey(key: string): Promise<ThreadRecord | undefined>;

  insertTrigger(trigger: TriggerRecord): Promise<void>;
  getTrigger(id: string): Promise<TriggerRecord | undefined>;
  setTriggerAction(id: string, action: FilterAction, rule: string | null, interrupt: boolean): Promise<void>;
  listTriggers(threadId: string): Promise<TriggerRecord[]>;

  addSubscription(workerId: string, threadId: string, createdAt: number): Promise<void>;
  removeSubscription(workerId: string, threadId: string): Promise<void>;
  subscriptionsForThread(threadId: string): Promise<SubscriptionRecord[]>;
  subscriptionsForWorker(workerId: string): Promise<SubscriptionRecord[]>;

  enqueueRouter(item: RouterItem, createdAt: number): Promise<void>;
  claimRouterItems(): Promise<Array<{ id: string; item: RouterItem }>>;
  completeRouterItems(ids: string[]): Promise<void>;
  resetInflightRouterItems(): Promise<void>;
  hasPendingRouterItems(): Promise<boolean>;
  recordRouterTurn(turn: RouterTurnRecord): Promise<void>;
  listRouterTurns(): Promise<RouterTurnRecord[]>;

  enqueueInbox(input: {
    workerId: string;
    text: string;
    triggerId: string;
    createdAt: number;
  }): Promise<void>;
  claimInbox(workerId: string): Promise<{ id: string; text: string; triggerId: string } | undefined>;
  completeInbox(id: string): Promise<void>;

  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;

  close(): Promise<void>;
}

interface SessionRow {
  id: string;
  role: SessionRole;
  runtime: string | null;
  state: SessionState;
  cwd: string | null;
  worktree: number;
  base_cwd: string | null;
  thread_id: string | null;
  acp_session_id: string | null;
  pid: number | null;
  seq: number;
  paths: string;
  created_at: number;
  updated_at: number;
}

interface EventRow {
  id: string;
  seq: number;
  worker_id: string;
  type: EventType;
  payload: string;
  created_at: number;
}

export class SqliteStore implements Store {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): SqliteStore {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        runtime TEXT,
        state TEXT NOT NULL,
        cwd TEXT,
        worktree INTEGER NOT NULL DEFAULT 0,
        base_cwd TEXT,
        thread_id TEXT,
        acp_session_id TEXT,
        pid INTEGER,
        seq INTEGER NOT NULL DEFAULT 0,
        paths TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_worker_seq ON events(worker_id, seq);
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        external_id TEXT,
        source TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'im.message',
        is_bot INTEGER NOT NULL DEFAULT 0,
        reply_to TEXT,
        action TEXT,
        rule TEXT,
        interrupt INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        worker_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (worker_id, thread_id)
      );
      CREATE TABLE IF NOT EXISTS router_queue (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS router_turns (
        id TEXT PRIMARY KEY,
        item_count INTEGER NOT NULL,
        reply TEXT NOT NULL,
        items TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_inbox (
        id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        text TEXT NOT NULL,
        trigger_id TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    return new SqliteStore(db);
  }

  async appendEvent(input: {
    workerId: string;
    type: EventType;
    payload: Record<string, unknown>;
    createdAt: number;
  }): Promise<TigerEvent> {
    const seq = this.allocSeq(input.workerId);
    const event: TigerEvent = {
      id: newId("evt"),
      seq,
      workerId: input.workerId,
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt,
    };
    this.db
      .prepare(
        "INSERT INTO events (id, seq, worker_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(event.id, event.seq, event.workerId, event.type, JSON.stringify(event.payload), event.createdAt);
    return event;
  }

  async listEvents(query: {
    workerId?: string;
    sinceSeq?: number;
    type?: EventType;
  }): Promise<TigerEvent[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.workerId) {
      clauses.push("worker_id = ?");
      params.push(query.workerId);
    }
    if (query.sinceSeq !== undefined) {
      clauses.push("seq > ?");
      params.push(query.sinceSeq);
    }
    if (query.type) {
      clauses.push("type = ?");
      params.push(query.type);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY worker_id ASC, seq ASC`)
      .all(...params) as unknown as EventRow[];
    return rows.map(mapEvent);
  }

  async getEvent(id: string): Promise<TigerEvent | undefined> {
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
    return row ? mapEvent(row) : undefined;
  }

  async insertSession(session: SessionRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, role, runtime, state, cwd, worktree, base_cwd, thread_id, acp_session_id, pid, seq, paths, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.role,
        session.runtime,
        session.state,
        session.cwd,
        session.worktree ? 1 : 0,
        session.baseCwd,
        session.threadId,
        session.acpSessionId,
        session.pid,
        session.seq,
        JSON.stringify(session.paths),
        session.createdAt,
        session.updatedAt,
      );
  }

  async updateSession(id: string, patch: Partial<SessionRecord>): Promise<void> {
    const current = await this.getSession(id);
    if (!current) return;
    const next: SessionRecord = { ...current, ...patch, id: current.id };
    this.db
      .prepare(
        `UPDATE sessions SET role=?, runtime=?, state=?, cwd=?, worktree=?, base_cwd=?, thread_id=?, acp_session_id=?, pid=?, seq=?, paths=?, created_at=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.role,
        next.runtime,
        next.state,
        next.cwd,
        next.worktree ? 1 : 0,
        next.baseCwd,
        next.threadId,
        next.acpSessionId,
        next.pid,
        next.seq,
        JSON.stringify(next.paths),
        next.createdAt,
        next.updatedAt,
        id,
      );
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  async listSessions(role?: SessionRole): Promise<SessionRecord[]> {
    const rows = role
      ? (this.db.prepare("SELECT * FROM sessions WHERE role = ? ORDER BY created_at ASC").all(role) as unknown as SessionRow[])
      : (this.db.prepare("SELECT * FROM sessions ORDER BY created_at ASC").all() as unknown as SessionRow[]);
    return rows.map(mapSession);
  }

  async upsertThread(key: string, source: string, createdAt: number): Promise<ThreadRecord> {
    const existing = await this.getThreadByKey(key);
    if (existing) return existing;
    const thread: ThreadRecord = { id: newId("thr"), key, source, createdAt };
    this.db
      .prepare("INSERT INTO threads (id, key, source, created_at) VALUES (?, ?, ?, ?)")
      .run(thread.id, thread.key, thread.source, thread.createdAt);
    return thread;
  }

  async getThread(id: string): Promise<ThreadRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as
      | { id: string; key: string; source: string; created_at: number }
      | undefined;
    return row ? { id: row.id, key: row.key, source: row.source, createdAt: row.created_at } : undefined;
  }

  async getThreadByKey(key: string): Promise<ThreadRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM threads WHERE key = ?").get(key) as
      | { id: string; key: string; source: string; created_at: number }
      | undefined;
    return row ? { id: row.id, key: row.key, source: row.source, createdAt: row.created_at } : undefined;
  }

  async insertTrigger(trigger: TriggerRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO triggers (
          id, external_id, source, thread_id, author, text, timestamp, kind, is_bot, reply_to, action, rule, interrupt, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trigger.id,
        trigger.externalId,
        trigger.source,
        trigger.threadId,
        trigger.author,
        trigger.text,
        trigger.timestamp,
        trigger.kind,
        trigger.isBot ? 1 : 0,
        trigger.replyTo,
        trigger.action,
        trigger.rule,
        trigger.interrupt ? 1 : 0,
        trigger.createdAt,
      );
  }

  async getTrigger(id: string): Promise<TriggerRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as TriggerRow | undefined;
    return row ? mapTrigger(row) : undefined;
  }

  async setTriggerAction(id: string, action: FilterAction, rule: string | null, interrupt: boolean): Promise<void> {
    this.db
      .prepare("UPDATE triggers SET action = ?, rule = ?, interrupt = ? WHERE id = ?")
      .run(action, rule, interrupt ? 1 : 0, id);
  }

  async listTriggers(threadId: string): Promise<TriggerRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM triggers WHERE thread_id = ? ORDER BY timestamp ASC, created_at ASC")
      .all(threadId) as unknown as TriggerRow[];
    return rows.map(mapTrigger);
  }

  async addSubscription(workerId: string, threadId: string, createdAt: number): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO subscriptions (worker_id, thread_id, created_at) VALUES (?, ?, ?) ON CONFLICT(worker_id, thread_id) DO NOTHING",
      )
      .run(workerId, threadId, createdAt);
  }

  async removeSubscription(workerId: string, threadId: string): Promise<void> {
    this.db.prepare("DELETE FROM subscriptions WHERE worker_id = ? AND thread_id = ?").run(workerId, threadId);
  }

  async subscriptionsForThread(threadId: string): Promise<SubscriptionRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM subscriptions WHERE thread_id = ? ORDER BY created_at ASC")
      .all(threadId) as Array<{ worker_id: string; thread_id: string; created_at: number }>;
    return rows.map((row) => ({
      workerId: row.worker_id,
      threadId: row.thread_id,
      createdAt: row.created_at,
    }));
  }

  async subscriptionsForWorker(workerId: string): Promise<SubscriptionRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM subscriptions WHERE worker_id = ? ORDER BY created_at ASC")
      .all(workerId) as Array<{ worker_id: string; thread_id: string; created_at: number }>;
    return rows.map((row) => ({
      workerId: row.worker_id,
      threadId: row.thread_id,
      createdAt: row.created_at,
    }));
  }

  async enqueueRouter(item: RouterItem, createdAt: number): Promise<void> {
    this.db
      .prepare("INSERT INTO router_queue (id, payload, status, created_at) VALUES (?, ?, 'pending', ?)")
      .run(newId("rq"), JSON.stringify(item), createdAt);
  }

  async claimRouterItems(): Promise<Array<{ id: string; item: RouterItem }>> {
    const rows = this.db
      .prepare("SELECT id, payload FROM router_queue WHERE status = 'pending' ORDER BY created_at ASC, id ASC")
      .all() as Array<{ id: string; payload: string }>;
    for (const row of rows) {
      this.db.prepare("UPDATE router_queue SET status = 'inflight' WHERE id = ?").run(row.id);
    }
    return rows.map((row) => ({ id: row.id, item: JSON.parse(row.payload) as RouterItem }));
  }

  async completeRouterItems(ids: string[]): Promise<void> {
    const stmt = this.db.prepare("UPDATE router_queue SET status = 'delivered' WHERE id = ?");
    for (const id of ids) stmt.run(id);
  }

  async resetInflightRouterItems(): Promise<void> {
    this.db.prepare("UPDATE router_queue SET status = 'pending' WHERE status = 'inflight'").run();
  }

  async hasPendingRouterItems(): Promise<boolean> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM router_queue WHERE status = 'pending'")
      .get() as { n: number };
    return row.n > 0;
  }

  async recordRouterTurn(turn: RouterTurnRecord): Promise<void> {
    this.db
      .prepare("INSERT INTO router_turns (id, item_count, reply, items, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(turn.id, turn.itemCount, turn.reply, JSON.stringify(turn.items), turn.createdAt);
  }

  async listRouterTurns(): Promise<RouterTurnRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM router_turns ORDER BY created_at ASC, id ASC")
      .all() as Array<{ id: string; item_count: number; reply: string; items: string; created_at: number }>;
    return rows.map((row) => ({
      id: row.id,
      itemCount: row.item_count,
      reply: row.reply,
      items: JSON.parse(row.items) as RouterItem[],
      createdAt: row.created_at,
    }));
  }

  async enqueueInbox(input: {
    workerId: string;
    text: string;
    triggerId: string;
    createdAt: number;
  }): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO worker_inbox (id, worker_id, text, trigger_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
      )
      .run(newId("inb"), input.workerId, input.text, input.triggerId, input.createdAt);
  }

  async claimInbox(workerId: string): Promise<{ id: string; text: string; triggerId: string } | undefined> {
    const row = this.db
      .prepare(
        "SELECT id, text, trigger_id FROM worker_inbox WHERE worker_id = ? AND status = 'pending' ORDER BY created_at ASC, id ASC LIMIT 1",
      )
      .get(workerId) as { id: string; text: string; trigger_id: string } | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE worker_inbox SET status = 'inflight' WHERE id = ?").run(row.id);
    return { id: row.id, text: row.text, triggerId: row.trigger_id };
  }

  async completeInbox(id: string): Promise<void> {
    this.db.prepare("UPDATE worker_inbox SET status = 'delivered' WHERE id = ?").run(id);
  }

  async getMeta(key: string): Promise<string | undefined> {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private allocSeq(workerId: string): number {
    const row = this.db.prepare("SELECT seq FROM sessions WHERE id = ?").get(workerId) as
      | { seq: number }
      | undefined;
    const next = (row?.seq ?? 0) + 1;
    if (row) {
      this.db.prepare("UPDATE sessions SET seq = ? WHERE id = ?").run(next, workerId);
    } else {
      const metaKey = `seq:${workerId}`;
      const current = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(metaKey) as
        | { value: string }
        | undefined;
      const value = (current ? Number(current.value) : 0) + 1;
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(metaKey, String(value));
      return value;
    }
    return next;
  }
}

interface TriggerRow {
  id: string;
  external_id: string | null;
  source: string;
  thread_id: string;
  author: string;
  text: string;
  timestamp: number;
  kind: string;
  is_bot: number;
  reply_to: string | null;
  action: FilterAction | null;
  rule: string | null;
  interrupt: number;
  created_at: number;
}

function mapTrigger(row: TriggerRow): TriggerRecord {
  return {
    id: row.id,
    externalId: row.external_id,
    source: row.source,
    threadId: row.thread_id,
    author: row.author,
    text: row.text,
    timestamp: row.timestamp,
    kind: row.kind,
    isBot: row.is_bot === 1,
    replyTo: row.reply_to,
    action: row.action,
    rule: row.rule,
    interrupt: row.interrupt === 1,
    createdAt: row.created_at,
  };
}

function mapEvent(row: EventRow): TigerEvent {
  return {
    id: row.id,
    seq: row.seq,
    workerId: row.worker_id,
    type: row.type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    role: row.role,
    runtime: row.runtime,
    state: row.state,
    cwd: row.cwd,
    worktree: row.worktree === 1,
    baseCwd: row.base_cwd,
    threadId: row.thread_id,
    acpSessionId: row.acp_session_id,
    pid: row.pid,
    seq: row.seq,
    paths: JSON.parse(row.paths) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
