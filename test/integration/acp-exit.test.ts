import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("tigercat acp", () => {
  it("exits when the client closes stdin, even if an MCP child is still running", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "tigercat-acp-"));
    const db = path.join(root, "tigercat.sqlite");
    const proc = spawn(process.execPath, ["dist/cli.js", "acp"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TIGERCAT_DB: db, TIGERCAT_CONFIG: path.join(root, "missing.toml") },
      windowsHide: true,
    });
    let stdout = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const send = (id: number, method: string, params: unknown) => {
      proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    };
    send(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    await waitFor(() => stdout.includes('"id":1'));
    send(2, "session/new", {
      cwd: root,
      mcpServers: [
        {
          name: "hold",
          command: process.execPath,
          args: [path.join("test", "harness", "mcp-hold.mjs")],
          env: [],
        },
      ],
    });
    await waitFor(() => stdout.includes('"id":2'));
    expect(stdout).toContain('"sessionId"');
    proc.stdin?.end();
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve(null);
      }, 2_000);
      proc.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 5_000) throw new Error("timed out waiting for ACP output");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
