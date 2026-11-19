import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatUpstreamReply } from "../../src/acp-agent.js";
import { builtinByName, launchConfig } from "../../src/builtins.js";
import { loadConfig, saveConfig } from "../../src/config.js";
import { TigerError } from "../../src/errors.js";
import { ChatToolRouter } from "../../src/router-llm.js";
import { ROUTER_TOOL_NAMES } from "../../src/tools.js";
import { startHarness } from "../harness/engine.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    await closers.pop()?.();
  }
});

describe("DeepSeek chat-completions Router (local fake, not a live provider)", () => {
  it("refuses to start when the DeepSeek key is missing and does not call the network", () => {
    let called = 0;
    const fetchImpl: typeof fetch = async () => {
      called += 1;
      throw new Error("fetch should not run");
    };
    expect(
      () =>
        new ChatToolRouter({
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-flash",
          apiKey: "",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          fetchImpl,
        }),
    ).toThrow(/DEEPSEEK_API_KEY/);
    expect(called).toBe(0);
  });

  it("round-trips the deepseek router table", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tigercat-router-"));
    const file = path.join(dir, "config.toml");
    const config = loadConfig(file);
    config.routerProvider = {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    };
    saveConfig(config, file);
    expect(loadConfig(file).routerProvider).toEqual(config.routerProvider);
  });

  it("reads default_worker_runtime from every root README toml sample", () => {
    const root = new URL("../../", import.meta.url);
    const names = readdirSync(root)
      .filter((name) => /^README.*\.md$/.test(name))
      .sort();
    expect(names).toContain("README.md");
    const english = routerConfigBlocks(readFileSync(new URL("README.md", root), "utf8"));
    expect(english.length).toBeGreaterThan(0);
    const crlf = routerConfigBlocks(
      "```toml\r\ndefault_worker_runtime = \"claude-code\"\r\n\r\n[router]\r\nprovider = \"deepseek\"\r\n```\r\n",
    );
    expect(crlf).toEqual(['default_worker_runtime = "claude-code"\r\n\r\n[router]\r\nprovider = "deepseek"\r\n']);
    for (const name of names) {
      const blocks = routerConfigBlocks(readFileSync(new URL(name, root), "utf8"));
      expect(blocks, name).toEqual(english);
      for (const toml of [...blocks, ...crlf]) {
        expect(toml.indexOf("default_worker_runtime"), name).toBeLessThan(toml.indexOf("[router]"));
        const dir = mkdtempSync(path.join(tmpdir(), "tigercat-readme-"));
        const file = path.join(dir, "config.toml");
        writeFileSync(file, toml);
        expect(loadConfig(file).defaultWorkerRuntime, name).toBe("claude-code");
      }
    }
  });

  it("rejects default_worker_runtime nested inside [router]", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tigercat-nested-"));
    const file = path.join(dir, "config.toml");
    writeFileSync(file, '[router]\nprovider = "deepseek"\ndefault_worker_runtime = "claude-code"\n');
    expect(() => loadConfig(file)).toThrow(TigerError);
    expect(() => loadConfig(file)).toThrow(/top level/);
  });

  it("spawns through the documented tool protocol and leaves a subscribed follow-up off the Router", async () => {
    const seen: Array<{ body: Record<string, unknown>; headers: IncomingHttpHeaders }> = [];
    let step = 0;
    const server = await listen((body, headers) => {
      seen.push({ body, headers });
      step += 1;
      if (step === 1) {
        return message(null, [
          {
            id: "call_spawn",
            function: {
              name: "spawn",
              arguments: JSON.stringify({
                runtime: "worker",
                prompt: "investigate",
                threads: ["feishu:eng:other"],
              }),
            },
          },
        ]);
      }
      return message("dispatched the worker");
    });
    const harness = await startHarness();
    closers.push(async () => {
      await harness.engine.close();
      await harness.store.close();
    });
    harness.engine.useBrain(
      new ChatToolRouter({
        baseUrl: server.url,
        model: "deepseek-flash",
        apiKey: "local-fake-key",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      }),
    );
    const first = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:other",
      author: "keith",
      text: "Please investigate the flaky CI job.",
      kind: "im.message",
      isBot: false,
      timestamp: 1_000,
    });
    await harness.engine.settle();
    expect(first.router).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers.authorization).toBe("Bearer local-fake-key");
    expect(seen[0]?.body.model).toBe("deepseek-flash");
    expect(seen[0]?.body.thinking).toEqual({ type: "disabled" });
    const tools = seen[0]?.body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name)).toEqual([...ROUTER_TOOL_NAMES]);
    const workers = await harness.engine.workers();
    expect(workers).toHaveLength(1);
    const reply = await formatUpstreamReply(harness.engine, first, 0, {});
    expect(reply).toContain("dispatched the worker");
    expect(reply).toContain(`${workers[0]?.id} is still running`);
    expect(reply).toContain("will not reach Feishu");
    const follow = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:other",
      author: "keith",
      text: "The typo is in the install section, not the title.",
      kind: "im.message",
      isBot: false,
      timestamp: 2_000,
    });
    await harness.engine.settle();
    expect(follow.router).toBe(false);
    expect(follow.deliveredTo).toEqual([workers[0]?.id]);
    expect(seen).toHaveLength(2);
    const launch = launchConfig(builtinByName("claude-code")!, { PATH: "" });
    expect(`${launch.command} ${launch.args.join(" ")}`).not.toMatch(/dry-run/);
  });

  it("does not execute a tool outside the router allowlist", async () => {
    let step = 0;
    const seen: Array<Record<string, unknown>> = [];
    const server = await listen((body) => {
      seen.push(body);
      step += 1;
      if (step === 1) {
        return message(null, [
          { id: "call_bash", function: { name: "bash", arguments: JSON.stringify({ command: "uname" }) } },
        ]);
      }
      return message("refused");
    });
    const harness = await startHarness();
    closers.push(async () => {
      await harness.engine.close();
      await harness.store.close();
    });
    harness.engine.useBrain(
      new ChatToolRouter({
        baseUrl: server.url,
        model: "deepseek-flash",
        apiKey: "local-fake-key",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      }),
    );
    await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:other",
      author: "keith",
      text: "Please investigate the flaky CI job.",
      kind: "im.message",
      isBot: false,
      timestamp: 1_000,
    });
    await harness.engine.settle();
    expect(await harness.engine.workers()).toHaveLength(0);
    const second = seen[1]?.messages as Array<{ role?: string; content?: string }>;
    const toolMessage = second.find((entry) => entry.role === "tool");
    expect(toolMessage?.content).toContain("not on the router allowlist");
    const turns = await harness.engine.routerTurns();
    expect(turns.at(-1)?.reply).toContain("refused");
  });

  it("surfaces a provider HTTP failure and does not spawn", async () => {
    const leaked = "sk-provider-body-must-not-leak";
    const server = await listen(() => ({ status: 401, body: { error: leaked, detail: "raw-provider-detail" } }));
    const harness = await startHarness();
    closers.push(async () => {
      await harness.engine.close();
      await harness.store.close();
    });
    harness.engine.useBrain(
      new ChatToolRouter({
        baseUrl: server.url,
        model: "deepseek-flash",
        apiKey: "local-fake-key",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      }),
    );
    const result = await harness.engine.ingest({
      source: "feishu",
      thread: "feishu:eng:other",
      author: "keith",
      text: "Please investigate the flaky CI job.",
      kind: "im.message",
      isBot: false,
      timestamp: 1_000,
    });
    await harness.engine.settle();
    expect(await harness.engine.workers()).toHaveLength(0);
    const reply = await formatUpstreamReply(harness.engine, result, 0, {});
    expect(reply).toMatch(/^Router failed: DeepSeek chat\/completions HTTP 401/);
    expect(reply).not.toContain(leaked);
    expect(reply).not.toContain("raw-provider-detail");
    const events = await harness.engine.events();
    expect(events.some((event) => event.type === "coordinator.turn_end" && event.payload.stopReason === "error")).toBe(
      true,
    );
  });
});

function routerConfigBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```toml\r?\n([\s\S]*?)```/g)]
    .map((match) => match[1] ?? "")
    .filter((block) => block.includes("[router]") || block.includes("default_worker_runtime"));
}

function message(
  content: string | null,
  toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>,
): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      choices: [
        {
          message: {
            role: "assistant",
            content,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
        },
      ],
    },
  };
}

async function listen(
  handler: (
    body: Record<string, unknown>,
    headers: IncomingHttpHeaders,
  ) => { status?: number; body: unknown },
): Promise<{ url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const reply = handler(body, req.headers);
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new TigerError("router_provider", "fake server has no port");
  const url = `http://127.0.0.1:${address.port}`;
  closers.push(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { url };
}
