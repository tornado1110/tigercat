import { createHash } from "node:crypto";
import type { Clock } from "./clock.js";
import type { LarkCliCallResult } from "./lark-cli.js";
import type { LarkTransport } from "./lark-transport.js";
import type { Store } from "./store.js";

const STATE_KEY = "personal-resources.v1";
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_LIMIT = 20;

export type ResourceStatus = "tracking" | "closed";

export interface ResourceCandidate {
  id: string;
  source: string;
  kind: string;
  title: string;
  url?: string;
  locator: Record<string, string>;
  metadata: Record<string, string>;
  rationale?: string;
}

export interface TrackedResource extends ResourceCandidate {
  status: ResourceStatus;
  confirmedAt: number;
  lastCheckedAt: number;
  baselineHash: string;
  baselineText: string;
  lastSeenHash: string;
}

export interface ResourceChange {
  id: string;
  source: string;
  kind: string;
  title: string;
  url?: string;
  changedAt: number;
  previousHash: string;
  currentHash: string;
  summary: string;
}

export interface ResourceSearch {
  source: string;
  query?: string;
  sinceDays?: number;
  limit?: number;
}

export interface ResourceSearchResult {
  candidates: ResourceCandidate[];
  errors: string[];
}

export interface ResourceSource {
  search(request: ResourceSearch): Promise<ResourceSearchResult>;
  read(resource: ResourceCandidate): Promise<string>;
}

export interface ResourceScanResult {
  scannedAt: number;
  source: string;
  candidates: ResourceCandidate[];
  tracked: TrackedResource[];
  changes: ResourceChange[];
  errors: string[];
}

interface TrackerState {
  candidates: ResourceCandidate[];
  tracked: TrackedResource[];
}

export interface PersonalResourceTrackerOptions {
  source: ResourceSource;
  store: Store;
  clock: Clock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function payloadData(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return value.data ?? value;
}

function resultError(result: LarkCliCallResult): string {
  return result.message ?? result.code ?? "source read failed";
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function cleanText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function extractText(value: unknown, output: string[] = []): string {
  if (typeof value === "string") {
    if (value.trim()) output.push(value);
    return output.join("\n");
  }
  if (Array.isArray(value)) {
    for (const item of value) extractText(item, output);
    return output.join("\n");
  }
  if (!isRecord(value)) return output.join("\n");
  for (const key of ["content", "text", "markdown", "subject", "body", "summary", "transcript", "document", "data"]) {
    if (key in value) extractText(value[key], output);
  }
  return output.join("\n");
}

function summarizeChange(previous: string, current: string): string {
  const oldLines = previous.split("\n");
  const newLines = current.split("\n");
  const added = newLines.filter((line) => line && !oldLines.includes(line)).slice(0, 3);
  const removed = oldLines.filter((line) => line && !newLines.includes(line)).slice(0, 3);
  const pieces: string[] = [];
  if (added.length) pieces.push(`added: ${added.join(" / ")}`);
  if (removed.length) pieces.push(`removed: ${removed.join(" / ")}`);
  return pieces.join("; ") || "content changed, open the source to review it";
}

function tokenFromUrl(url: string): string | undefined {
  return url.match(/\/(?:wiki|docx|docs|sheets|base|slides|minutes)\/([A-Za-z0-9_-]+)/)?.[1];
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function parseSourceCandidates(source: string, value: unknown, limit: number): ResourceCandidate[] {
  const data = payloadData(value);
  if (!isRecord(data)) return [];
  const rows = Array.isArray(data.results) ? data.results : Array.isArray(data.items) ? data.items : Array.isArray(data.messages) ? data.messages : [];
  const candidates: ResourceCandidate[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const meta = {
      ...(isRecord(row.meta_data) ? row.meta_data : {}),
      ...(isRecord(row.result_meta) ? row.result_meta : {}),
      ...row,
    };
    const title = firstString(meta, ["title", "title_highlighted", "subject", "name", "display_info", "text", "body", "content"])
      ?? firstString(row, ["title", "title_highlighted", "subject", "name", "display_info", "text", "body", "content"]);
    const url = firstString(meta, ["url", "app_link", "link", "message_app_link"]) ?? firstString(row, ["url", "app_link", "link", "message_app_link"]);
    const rawToken = firstString(meta, ["token", "minute_token", "message_id", "id"])
      ?? firstString(row, ["token", "minute_token", "message_id", "id"]);
    const token = rawToken && rawToken !== "[REDACTED]" ? rawToken : (url ? tokenFromUrl(url) : undefined);
    if (!title || !token) continue;
    const kind = firstString(meta, ["doc_types", "entity_type", "type", "msg_type"]) ?? source;
    const metadata: Record<string, string> = {};
    for (const key of ["owner_id", "owner_name", "sender_name", "date", "update_time_iso", "create_time_iso", "thread_id", "chat_id"]) {
      const value = asString(meta[key]);
      if (value) metadata[key] = value;
    }
    candidates.push({
      id: `${source}:${kind.toLowerCase()}:${token}`,
      source,
      kind,
      title,
      ...(url ? { url } : {}),
      locator: { token },
      metadata,
      rationale: `source=${source}, kind=${kind}`,
    });
  }
  return candidates.slice(0, limit);
}

function trackerState(value: string | undefined): TrackerState {
  if (!value) return { candidates: [], tracked: [] };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return { candidates: [], tracked: [] };
    return {
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates as ResourceCandidate[] : [],
      tracked: Array.isArray(parsed.tracked) ? parsed.tracked as TrackedResource[] : [],
    };
  } catch {
    return { candidates: [], tracked: [] };
  }
}

function activeTracked(state: TrackerState): TrackedResource[] {
  return state.tracked.filter((resource) => resource.status === "tracking");
}

export class PersonalResourceTracker {
  constructor(private readonly options: PersonalResourceTrackerOptions) {}

  async scan(request: ResourceSearch): Promise<ResourceScanResult> {
    const scannedAt = this.options.clock.now();
    const state = await this.load();
    const result = await this.options.source.search(request);
    const candidatesById = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));
    for (const candidate of result.candidates) candidatesById.set(candidate.id, candidate);
    state.candidates = [...candidatesById.values()];
    await this.save(state);
    return { scannedAt, source: request.source, candidates: result.candidates, tracked: activeTracked(state), changes: [], errors: result.errors };
  }

  async confirm(ids: readonly string[]): Promise<TrackedResource[]> {
    const state = await this.load();
    const selected = new Set(ids);
    const now = this.options.clock.now();
    const trackedById = new Map(state.tracked.map((item) => [item.id, item]));
    for (const candidate of state.candidates) {
      if (!selected.has(candidate.id)) continue;
      const previous = trackedById.get(candidate.id);
      if (previous?.status === "tracking") continue;
      const baselineText = cleanText(await this.options.source.read(candidate));
      const baselineHash = hashText(baselineText);
      trackedById.set(candidate.id, { ...candidate, status: "tracking", confirmedAt: now, lastCheckedAt: now, baselineHash, baselineText, lastSeenHash: baselineHash });
    }
    state.tracked = [...trackedById.values()];
    await this.save(state);
    return activeTracked(state);
  }

  async refresh(): Promise<ResourceScanResult> {
    const scannedAt = this.options.clock.now();
    const state = await this.load();
    const changes: ResourceChange[] = [];
    const errors: string[] = [];
    for (const resource of state.tracked) {
      if (resource.status !== "tracking") continue;
      try {
        const currentText = cleanText(await this.options.source.read(resource));
        const currentHash = hashText(currentText);
        if (currentHash !== resource.lastSeenHash) {
          changes.push({ id: resource.id, source: resource.source, kind: resource.kind, title: resource.title, url: resource.url, changedAt: scannedAt, previousHash: resource.lastSeenHash, currentHash, summary: summarizeChange(resource.baselineText, currentText) });
          resource.lastSeenHash = currentHash;
        }
        resource.lastCheckedAt = scannedAt;
      } catch (error) {
        errors.push(`${resource.title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.save(state);
    return { scannedAt, source: "tracked", candidates: state.candidates, tracked: activeTracked(state), changes, errors };
  }

  async list(): Promise<TrackedResource[]> {
    return activeTracked(await this.load());
  }

  async close(ids: readonly string[]): Promise<TrackedResource[]> {
    const state = await this.load();
    const selected = new Set(ids);
    for (const resource of state.tracked) if (selected.has(resource.id)) resource.status = "closed";
    await this.save(state);
    return activeTracked(state);
  }

  private async load(): Promise<TrackerState> {
    return trackerState(await this.options.store.getMeta(STATE_KEY));
  }

  private async save(state: TrackerState): Promise<void> {
    await this.options.store.setMeta(STATE_KEY, JSON.stringify(state));
  }
}

export class LarkResourceSource implements ResourceSource {
  constructor(private readonly transport: LarkTransport) {}

  async search(request: ResourceSearch): Promise<ResourceSearchResult> {
    const limit = Math.min(Math.max(request.limit ?? DEFAULT_LIMIT, 1), 50);
    if (request.source === "messages" && !request.query?.trim()) return { candidates: [], errors: ["messages source requires a query"] };
    const since = isoSince(request.sinceDays ?? DEFAULT_LOOKBACK_DAYS);
    const args = sourceSearchArgs(request.source, request.query ?? "", since, limit);
    if (!args) return { candidates: [], errors: [`unsupported source: ${request.source}`] };
    const result = await this.transport.read(args);
    if (!result.ok) return { candidates: [], errors: [resultError(result)] };
    return { candidates: parseSourceCandidates(request.source, result.value, limit), errors: [] };
  }

  async read(resource: ResourceCandidate): Promise<string> {
    const args = sourceReadArgs(resource);
    if (!args) throw new Error(`unsupported resource: ${resource.id}`);
    const result = await this.transport.read(args);
    if (!result.ok) throw new Error(resultError(result));
    return extractText(result.value);
  }
}

function sourceSearchArgs(source: string, query: string, since: string, limit: number): string[] | undefined {
  switch (source) {
    case "documents": return ["drive", "+search", "--query", query, "--edited-since", since, "--doc-types", "doc,wiki,docx,sheet,bitable,slides,file", "--sort", "edit_time", "--page-size", String(Math.min(limit, 20)), "--format", "json"];
    case "mail": return ["mail", "+triage", "--query", query, "--max", String(Math.min(limit, 400)), "--format", "json"];
    case "minutes": return ["minutes", "+search", ...(query ? ["--query", query] : []), "--start", since, "--page-size", String(Math.min(limit, 30)), "--format", "json"];
    case "messages": return ["im", "+messages-search", ...(query ? ["--query", query] : []), "--start", since, "--page-size", String(Math.min(limit, 50)), "--format", "json"];
    default: return undefined;
  }
}

function isoSince(days: number): string {
  const localMillis = Date.now() - Math.max(days, 1) * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000;
  return `${new Date(localMillis).toISOString().slice(0, 19)}+08:00`;
}

function sourceReadArgs(resource: ResourceCandidate): string[] | undefined {
  const token = resource.locator.token;
  switch (resource.source) {
    case "documents": return ["docs", "+fetch", "--doc", resource.url ?? token, "--scope", "full", "--doc-format", "markdown", "--format", "json"];
    case "mail": return ["mail", "+message", "--message-id", token, "--html=false", "--format", "json"];
    case "minutes": return ["minutes", "+detail", "--minute-tokens", token, "--summary", "--todo", "--transcript", "--format", "json"];
    case "messages": return ["im", "+messages-mget", "--message-ids", token, "--format", "json"];
    default: return undefined;
  }
}

export function resourceScanMarkdown(result: ResourceScanResult): string {
  const lines = [`### Resources (${result.source})`];
  if (result.candidates.length) {
    lines.push("", "Candidates:");
    for (const [index, resource] of result.candidates.entries()) {
      const link = resource.url ? `[${resource.title}](${resource.url})` : resource.title;
      lines.push(`${index + 1}. ${link} · ${resource.kind} · \`${resource.id}\``);
    }
  } else lines.push("", "No resources matched.");
  if (result.tracked.length) lines.push("", `Tracking ${result.tracked.length} resource(s).`);
  if (result.changes.length) {
    lines.push("", "Changes requiring review:");
    for (const change of result.changes) lines.push(`- ${change.title}: ${change.summary}${change.url ? ` (${change.url})` : ""}`);
  }
  if (result.errors.length) lines.push("", `Errors: ${result.errors.join("; ")}`);
  return lines.join("\n");
}
