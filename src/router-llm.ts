import { TigerError } from "./errors.js";
import { renderTurn, type RouterBrain, type RouterTurn, type ToolApi } from "./brains.js";
import { assertNoShellOrEditTools, ROUTER_TOOL_NAMES, type RouterToolName } from "./tools.js";
import type { RouterProviderConfig } from "./types.js";

const ALLOWED = new Set<string>(ROUTER_TOOL_NAMES);

export interface ChatRouterOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyEnv: string;
  fetchImpl?: typeof fetch;
  maxRounds?: number;
}

interface ToolCall {
  id: string;
  function: { name: string; arguments?: string };
}

interface ProviderMessage {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/**
 * Tool-calling Router over DeepSeek Chat Completions
 * (`POST {baseUrl}/chat/completions`, `Authorization: Bearer`).
 * Thinking is disabled so tool calls stay on the non-thinking path.
 * This is not a Claude or Codex session and it does not speak the
 * Responses API. A missing key throws before any request.
 */
export class ChatToolRouter implements RouterBrain {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRounds: number;

  constructor(private readonly options: ChatRouterOptions) {
    if (!options.apiKey) {
      throw new TigerError(
        "missing_credential",
        `Router provider deepseek needs ${options.apiKeyEnv}. No request was sent. ` +
          `Set ${options.apiKeyEnv} to a DeepSeek API key. ` +
          `The call is POST ${options.baseUrl.replace(/\/$/, "")}/chat/completions ` +
          `with Authorization: Bearer and tools. ` +
          `That key is not an OpenAI or Anthropic credential, and this Router does not fall back to the scripted brain.`,
      );
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRounds = options.maxRounds ?? 4;
    assertNoShellOrEditTools(ROUTER_TOOL_NAMES);
  }

  async decide(turn: RouterTurn, tools: ToolApi): Promise<{ reply: string }> {
    const messages: ProviderMessage[] = [
      {
        role: "system",
        content:
          "You are TigerCat's main assistant. Route executable work to Workers with spawn. " +
          "Do not edit files or run a shell yourself. Handle simple conversation directly. " +
          "Ask before consequential external actions. Call only the listed tools.",
      },
      { role: "user", content: renderTurn(turn.items, 8_000) },
    ];
    for (let round = 0; round < this.maxRounds; round += 1) {
      const message = await this.complete(messages);
      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        return { reply: typeof message.content === "string" ? message.content : "" };
      }
      messages.push(message);
      for (const call of calls) {
        const result = await dispatchTool(call, tools);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }
    throw new TigerError(
      "router_provider",
      "DeepSeek Router exceeded tool rounds. No scripted or dry-run fallback was used.",
    );
  }

  private async complete(messages: ProviderMessage[]): Promise<ProviderMessage> {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          tools: toolSchemas(),
          tool_choice: "auto",
          thinking: { type: "disabled" },
        }),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      throw new TigerError(
        "router_provider",
        `DeepSeek chat/completions request failed (${name}). No fallback was used.`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new TigerError(
        "router_provider",
        `DeepSeek chat/completions HTTP ${response.status}. The provider body was discarded. No fallback was used.`,
      );
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: ProviderMessage }>;
    };
    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw new TigerError("router_provider", "DeepSeek response had no message. No fallback was used.");
    }
    return message;
  }
}

export function chatRouterFromConfig(
  config: RouterProviderConfig,
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): ChatToolRouter {
  const apiKey = env[config.apiKeyEnv] ?? "";
  return new ChatToolRouter({
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey,
    apiKeyEnv: config.apiKeyEnv,
    fetchImpl,
  });
}

async function dispatchTool(call: ToolCall, tools: ToolApi): Promise<unknown> {
  const name = call.function?.name ?? "";
  if (!ALLOWED.has(name)) {
    return { ok: false, error: `tool ${name} is not on the router allowlist` };
  }
  let args: Record<string, unknown> = {};
  if (call.function?.arguments) {
    try {
      const parsed = JSON.parse(call.function.arguments) as unknown;
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `invalid tool arguments: ${message}` };
    }
  }
  try {
    return await runTool(name as RouterToolName, args, tools);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

async function runTool(name: RouterToolName, args: Record<string, unknown>, tools: ToolApi): Promise<unknown> {
  const text = stringArg(args, "prompt") ?? stringArg(args, "task") ?? stringArg(args, "text") ?? "";
  switch (name) {
    case "spawn":
      return tools.spawn({
        runtime: stringArg(args, "runtime") ?? "",
        prompt: text,
        thread: stringArg(args, "thread"),
        threads: stringList(args.threads),
      });
    case "list":
      return tools.list();
    case "send":
      return tools.send(stringArg(args, "id") ?? "", text);
    case "read":
      return tools.read(stringArg(args, "id") ?? "", numberArg(args.since));
    case "interrupt":
      return tools.interrupt(stringArg(args, "id") ?? "");
    case "wait":
      return tools.wait(stringList(args.ids) ?? [], args.mode === "all" ? "all" : "any", numberArg(args.timeout) ?? 0);
    case "kill":
      return tools.kill(stringArg(args, "id") ?? "");
    case "subscribe":
      return tools.subscribe(stringArg(args, "worker") ?? "", stringArg(args, "thread") ?? "");
    case "unsubscribe":
      return tools.unsubscribe(stringArg(args, "worker") ?? "", stringArg(args, "thread") ?? "");
    default:
      return { ok: false, error: `tool ${name} is not on the router allowlist` };
  }
}

function toolSchemas(): Array<{ type: "function"; function: { name: string; description: string; parameters: object } }> {
  const descriptions: Record<RouterToolName, string> = {
    spawn: "Start a Worker for an executable task.",
    resume: "Resume a lost or interrupted Worker.",
    list: "List Workers and states.",
    send: "Send follow-up input to a Worker.",
    read: "Read Worker state or events.",
    interrupt: "Cancel a Worker turn.",
    wait: "Wait for Workers to settle.",
    kill: "End a Worker and release subscriptions.",
    subscribe: "Route a Thread to a Worker.",
    unsubscribe: "Stop routing a Thread to a Worker.",
  };
  return ROUTER_TOOL_NAMES.map((name) => ({
    type: "function" as const,
    function: {
      name,
      description: descriptions[name],
      parameters: { type: "object", additionalProperties: true },
    },
  }));
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(String);
}
