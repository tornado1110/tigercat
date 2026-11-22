import { createHash } from "node:crypto";
import type { Clock } from "./clock.js";
import type { LarkCliCallResult } from "./lark-cli.js";
import type { LarkTransport } from "./lark-transport.js";
import type { Store } from "./store.js";

const STATE_KEY = "personal-assistant.v1";
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_CANDIDATES = 20;

export type DraftTrackingStatus = "tracking" | "closed";

export interface DraftCandidate {
  id: string;
  title: string;
  url: string;
  token: string;
  type: string;
  ownerId?: string;
  ownerName?: string;
  updatedAt?: string;
  rationale: string;
}

export interface TrackedDraft extends DraftCandidate {
  status: DraftTrackingStatus;
  confirmedAt: number;
  lastCheckedAt: number;
  baselineHash: string;
  baselineText: string;
  lastSeenHash: string;
}

export interface DraftChange {
  id: string;
  title: string;
  url: string;
  changedAt: number;
  previousHash: string;
  currentHash: string;
  summary: string;
}

export interface PersonalScanResult {
  scannedAt: number;
  candidates: DraftCandidate[];
  tracked: TrackedDraft[];
  changes: DraftChange[];
  errors: string[];
}

interface AssistantState {
  candidates: DraftCandidate[];
  tracked: TrackedDraft[];
}

export interface PersonalAssistantOptions {
  transport: LarkTransport;
  store: Store;
  clock: Clock;
  lookbackDays?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

function payloadData(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return value.data ?? value;
}

function resultError(result: LarkCliCallResult): string {
  return result.message ?? result.code ?? "飞书读取失败";
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
  for (const key of ["content", "text", "markdown", "title", "body", "blocks", "document", "data"]) {
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
  if (added.length) pieces.push(`新增：${added.join(" / ")}`);
  if (removed.length) pieces.push(`删除：${removed.join(" / ")}`);
  return pieces.join("；") || "正文内容发生变化，请打开原文核对。";
}

function tokenFromUrl(url: string): string | undefined {
  const match = url.match(/\/(?:wiki|docx|docs|sheets|base|slides)\/([A-Za-z0-9_-]+)/);
  return match?.[1];
}

function parseCandidates(value: unknown): DraftCandidate[] {
  const data = payloadData(value);
  if (!isRecord(data) || !Array.isArray(data.results)) return [];
  const candidates: DraftCandidate[] = [];
  for (const item of data.results) {
    if (!isRecord(item)) continue;
    const meta = isRecord(item.result_meta) ? item.result_meta : item;
    const title = stringValue(meta.title) ?? stringValue(meta.title_highlighted) ?? stringValue(item.title) ?? stringValue(item.title_highlighted);
    const url = stringValue(meta.url);
    const rawToken = stringValue(meta.token);
    const token = rawToken && rawToken !== "[REDACTED]" ? rawToken : (url ? tokenFromUrl(url) : undefined);
    if (!title || !url || !token) continue;
    const type = stringValue(meta.doc_types) ?? stringValue(item.entity_type) ?? "DOCX";
    const ownerName = stringValue(meta.owner_name);
    const updatedAt = stringValue(meta.update_time_iso) ?? (numberValue(meta.update_time) ? new Date(Number(meta.update_time) * 1000).toISOString() : undefined);
    const rationale = ownerName
      ? `最近更新的${type.toLowerCase()}文档，当前负责人是${ownerName}`
      : `最近更新的${type.toLowerCase()}文档`;
    candidates.push({
      id: `${type.toLowerCase()}:${token}`,
      title,
      url,
      token,
      type,
      ownerId: stringValue(meta.owner_id),
      ownerName,
      updatedAt,
      rationale,
    });
  }
  return candidates.slice(0, MAX_CANDIDATES);
}

function initialState(value: string | undefined): AssistantState {
  if (!value) return { candidates: [], tracked: [] };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return { candidates: [], tracked: [] };
    return {
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates as DraftCandidate[] : [],
      tracked: Array.isArray(parsed.tracked) ? parsed.tracked as TrackedDraft[] : [],
    };
  } catch {
    return { candidates: [], tracked: [] };
  }
}

/**
 * Local-first personal workflow for read-only Feishu content.
 * The transport owns identity and authorization. This class only stores
 * candidate/tracking state and never sends or edits a Feishu resource.
 */
export class PersonalAssistant {
  private readonly lookbackDays: number;

  constructor(private readonly options: PersonalAssistantOptions) {
    this.lookbackDays = Number.isInteger(options.lookbackDays) && (options.lookbackDays ?? 0) > 0
      ? options.lookbackDays!
      : DEFAULT_LOOKBACK_DAYS;
  }

  async status() {
    return this.options.transport.status();
  }

  async scanCandidates(): Promise<PersonalScanResult> {
    const scannedAt = this.options.clock.now();
    const state = await this.load();
    const result = await this.options.transport.read([
      "drive", "+search", "--query", "", "--edited-since", `${this.lookbackDays}d`,
      "--doc-types", "docx,wiki", "--sort", "edit_time", "--page-size", String(MAX_CANDIDATES), "--format", "json",
    ]);
    if (!result.ok) {
      return { scannedAt, candidates: state.candidates, tracked: activeTracked(state), changes: [], errors: [resultError(result)] };
    }
    const candidates = parseCandidates(result.value);
    state.candidates = candidates;
    await this.save(state);
    return { scannedAt, candidates, tracked: activeTracked(state), changes: [], errors: [] };
  }

  async confirm(ids: readonly string[]): Promise<TrackedDraft[]> {
    const state = await this.load();
    const selected = new Set(ids);
    const now = this.options.clock.now();
    const trackedById = new Map(state.tracked.map((item) => [item.id, item]));
    for (const candidate of state.candidates) {
      if (!selected.has(candidate.id) || trackedById.has(candidate.id)) continue;
      const baseline = await this.fetchText(candidate);
      trackedById.set(candidate.id, {
        ...candidate,
        status: "tracking",
        confirmedAt: now,
        lastCheckedAt: now,
        baselineHash: hashText(baseline),
        baselineText: baseline,
        lastSeenHash: hashText(baseline),
      });
    }
    state.tracked = [...trackedById.values()];
    await this.save(state);
    return activeTracked(state);
  }

  async listTracked(): Promise<TrackedDraft[]> {
    return activeTracked(await this.load());
  }

  async refresh(): Promise<PersonalScanResult> {
    const scannedAt = this.options.clock.now();
    const state = await this.load();
    const changes: DraftChange[] = [];
    const errors: string[] = [];
    for (const item of state.tracked) {
      if (item.status !== "tracking") continue;
      try {
        const text = await this.fetchText(item);
        const currentHash = hashText(text);
        if (currentHash !== item.lastSeenHash) {
          changes.push({
            id: item.id,
            title: item.title,
            url: item.url,
            changedAt: scannedAt,
            previousHash: item.lastSeenHash,
            currentHash,
            summary: summarizeChange(item.baselineText, text),
          });
          item.lastSeenHash = currentHash;
        }
        item.lastCheckedAt = scannedAt;
      } catch (error) {
        errors.push(`${item.title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.save(state);
    return { scannedAt, candidates: state.candidates, tracked: activeTracked(state), changes, errors };
  }

  async close(ids: readonly string[]): Promise<TrackedDraft[]> {
    const state = await this.load();
    const selected = new Set(ids);
    for (const item of state.tracked) {
      if (selected.has(item.id)) item.status = "closed";
    }
    await this.save(state);
    return activeTracked(state);
  }

  private async fetchText(item: DraftCandidate): Promise<string> {
    const result = await this.options.transport.read([
      "docs", "+fetch", "--doc", item.url, "--scope", "full", "--doc-format", "markdown", "--format", "json",
    ]);
    if (!result.ok) throw new Error(resultError(result));
    return cleanText(extractText(result.value));
  }

  private async load(): Promise<AssistantState> {
    return initialState(await this.options.store.getMeta(STATE_KEY));
  }

  private async save(state: AssistantState): Promise<void> {
    await this.options.store.setMeta(STATE_KEY, JSON.stringify(state));
  }
}

function activeTracked(state: AssistantState): TrackedDraft[] {
  return state.tracked.filter((item) => item.status === "tracking");
}

export function personalAssistantMarkdown(result: PersonalScanResult): string {
  const lines = ["### 稿件跟踪"];
  if (result.candidates.length) {
    lines.push("", "候选稿件：");
    for (const [index, item] of result.candidates.entries()) lines.push(`${index + 1}. [${item.title}](${item.url}) · ${item.rationale} · \`${item.id}\``);
  } else {
    lines.push("", "这次没有找到最近更新的候选稿件。");
  }
  if (result.tracked.length) lines.push("", `正在跟踪 ${result.tracked.length} 篇稿件。`);
  if (result.changes.length) {
    lines.push("", "需要你判断的变化：");
    for (const change of result.changes) lines.push(`- [${change.title}](${change.url})：${change.summary}`);
  }
  if (result.errors.length) lines.push("", `读取失败 ${result.errors.length} 项：${result.errors.join("；")}`);
  return lines.join("\n");
}
