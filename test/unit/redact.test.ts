import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { TigerError } from "../../src/errors.js";
import { redactText, SecretRegistry } from "../../src/redact.js";
import { ProcessRuntimeFactory } from "../../src/runtime.js";

const FAKE_BEARER = "fake-bearer-token-0001";
const FAKE_ANTHROPIC = "fake-anthropic-value-0001";
const FAKE_DEEPSEEK = "fake-deepseek-value-0001";
const FAKE_HEADER = "fake-header-key-0001";
const FAKE_PROVIDER = "sk-ant-fake-not-a-real-key-0001";

describe("redactText", () => {
  it("scrubs auth headers, secret assignments, and provider tokens", () => {
    const input = [
      `Authorization: Bearer ${FAKE_BEARER}`,
      `authorization: basic ${FAKE_HEADER}`,
      `x-api-key: ${FAKE_HEADER}`,
      `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC}`,
      `DEEPSEEK_API_KEY="${FAKE_DEEPSEEK}"`,
      `provider rejected ${FAKE_PROVIDER}`,
      "worker process was not alive after restart",
      "token budget is unchanged",
    ].join("\n");
    const out = redactText(input);
    expect(out).not.toContain(FAKE_BEARER);
    expect(out).not.toContain(FAKE_ANTHROPIC);
    expect(out).not.toContain(FAKE_DEEPSEEK);
    expect(out).not.toContain(FAKE_HEADER);
    expect(out).not.toContain(FAKE_PROVIDER);
    expect(out).toContain("Authorization: Bearer [REDACTED]");
    expect(out).toContain("ANTHROPIC_API_KEY=[REDACTED]");
    expect(out).toContain("worker process was not alive after restart");
    expect(out).toContain("token budget is unchanged");
  });

  it("keeps JSON event payloads parseable", () => {
    const secrets = new SecretRegistry();
    secrets.noteEnv({ DEEPSEEK_API_KEY: FAKE_DEEPSEEK });
    const safe = secrets.redactValue({
      message: `provider 401 Authorization: Bearer ${FAKE_BEARER} for ${FAKE_DEEPSEEK}`,
      code: "bad_runtime",
      api_key: FAKE_ANTHROPIC,
    });
    expect(JSON.stringify(safe)).not.toContain(FAKE_BEARER);
    expect(JSON.stringify(safe)).not.toContain(FAKE_DEEPSEEK);
    expect(JSON.stringify(safe)).not.toContain(FAKE_ANTHROPIC);
    expect(safe).toMatchObject({ code: "bad_runtime" });
  });

  it("registers the IPC token and ignores short process values", () => {
    const secrets = new SecretRegistry();
    secrets.noteProcessEnv({ TOKEN: "short", ANTHROPIC_API_KEY: FAKE_ANTHROPIC });
    secrets.noteEnv({ TIGERCAT_IPC_TOKEN: "abc123def456abc123def456abc123de" });
    const out = secrets.redact(
      `mcp --token abc123def456abc123def456abc123de used ${FAKE_ANTHROPIC} and short`,
    );
    expect(out).not.toContain("abc123def456abc123def456abc123de");
    expect(out).not.toContain(FAKE_ANTHROPIC);
    expect(out).toContain("short");
  });
});

describe("runtime stderr", () => {
  it("does not copy provider credentials into the launch error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tigercat-redact-"));
    const script = path.join(dir, "stderr.js");
    writeFileSync(
      script,
      [
        `process.stderr.write('provider 401 Authorization: Bearer ${FAKE_BEARER} ANTHROPIC_API_KEY=${FAKE_ANTHROPIC}\\n');`,
        `process.stdout.write('x-api-key: ${FAKE_HEADER}\\n');`,
        "process.exit(2);",
        "",
      ].join("\n"),
    );
    const factory = new ProcessRuntimeFactory({ handshakeTimeoutMs: 3_000 });
    try {
      await factory.launch(
        {
          name: "leak-check",
          command: process.execPath,
          args: [script],
          env: {},
          tags: [],
          description: "",
          permission: "ask",
        },
        {
          cwd: dir,
          role: "worker",
          onUpdate: () => undefined,
          onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        },
      );
      throw new Error("launch should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(TigerError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(FAKE_BEARER);
      expect(message).not.toContain(FAKE_ANTHROPIC);
      expect(message).not.toContain(FAKE_HEADER);
      expect(message).toContain("leak-check");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("example config", () => {
  it("loads without credentials", () => {
    const file = fileURLToPath(new URL("../../examples/config.example.toml", import.meta.url));
    const config = loadConfig(file);
    const encoded = JSON.stringify(config);
    expect(config.coordinatorRuntime).toBeUndefined();
    expect(config.defaultWorkerRuntime).toBe("claude-code");
    expect(config.maxConcurrency).toBe(4);
    expect(config.runtimes).toEqual([]);
    expect(encoded).not.toMatch(/sk-|Bearer |api_key|DEEPSEEK|ANTHROPIC_API_KEY|OPENAI_API_KEY/i);
  });
});
