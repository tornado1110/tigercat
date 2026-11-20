import { spill, formatRouterBatch } from "./spill.js";
import type { RouterItem, SpawnRequest, SpawnResult } from "./types.js";

export interface ToolApi {
  spawn(input: SpawnRequest): Promise<SpawnResult>;
  resume?(id: string, input: string): Promise<SpawnResult>;
  list(): Promise<Array<{ id: string; state: string; runtime: string | null; threadId: string | null }>>;
  send(id: string, input: string): Promise<{ status: "started" }>;
  read(id: string, since?: number): Promise<unknown>;
  interrupt(id: string): Promise<{ status: string }>;
  wait(ids: string[], mode: "any" | "all", timeout: number): Promise<unknown>;
  kill(id: string): Promise<{ status: string }>;
  subscribe(worker: string, thread: string): Promise<{ status: "ok" }>;
  unsubscribe(worker: string, thread: string): Promise<{ status: "ok" }>;
}

export interface RouterTurn {
  items: RouterItem[];
}

export interface RouterBrain {
  decide(turn: RouterTurn, tools: ToolApi): Promise<{ reply: string }>;
}

/**
 * Week-1 stand-in for the Router LLM. It only runs for triggers that the
 * rule filter and the subscription fast-path did not already handle.
 * There is no model call and no shell.
 */
export class ScriptedRouter implements RouterBrain {
  constructor(private readonly defaultRuntime: string) {}

  async decide(turn: RouterTurn, tools: ToolApi): Promise<{ reply: string }> {
    const lines: string[] = [];
    for (const item of turn.items) {
      if (item.kind === "worker_event") {
        lines.push(item.summary);
        continue;
      }
      const text = item.text.trim();
      if (item.outcome === "candidate") {
        lines.push(`candidate ${item.triggerId} (${item.rule ?? "no-rule"}) left for judgement`);
        continue;
      }
      const spawned = await tools.spawn({
        runtime: this.defaultRuntime,
        prompt: text,
        threads: [item.threadKey],
      });
      lines.push(`started ${spawned.workerId} on ${spawned.threadId}`);
    }
    return { reply: lines.join("\n") || "ok" };
  }
}

export function renderTurn(items: RouterItem[], maxChars: number): string {
  const blocks = items.map((item) => {
    if (item.kind === "trigger") {
      return spill(item.text, {
        kind: "trigger",
        triggerId: item.triggerId,
        threadId: item.threadId,
        threadKey: item.threadKey,
        source: item.source,
        author: item.author,
      }, maxChars);
    }
    return spill(item.summary, {
      kind: "worker_event",
      event: item.eventType,
      eventId: item.eventId,
      workerId: item.workerId,
      threadId: item.threadId,
      stopReason: item.stopReason,
    }, maxChars);
  });
  return formatRouterBatch(blocks);
}

/**
 * Router brain that prompts a real ACP coordinator session.
 * Tool calls happen out of band through the injected MCP server while
 * `prompt` is in flight, so this method only waits for the turn to end.
 */
export class AcpRouterBrain implements RouterBrain {
  constructor(
    private readonly prompt: (text: string) => Promise<{ text: string }>,
    private readonly maxChars: number,
  ) {}

  async decide(turn: RouterTurn, _tools: ToolApi): Promise<{ reply: string }> {
    const result = await this.prompt(renderTurn(turn.items, this.maxChars));
    return { reply: result.text || "ok" };
  }
}
