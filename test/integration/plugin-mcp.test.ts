import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { createPluginHost } from "../../src/plugin.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("host-driven Codex plugin", () => {
  it("refuses to start and leaves no database when native shell, edit, or write tools remain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tigercat-plugin-refuse-"));
    roots.push(root);
    const dbPath = path.join(root, "plugin.sqlite");
    await expect(createPluginHost({
      config: defaultConfig(),
      workspaceRoot: root,
      dbPath,
    })).rejects.toMatchObject({ code: "router_native_tools" });
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.plugin-lock`)).toBe(false);
  });

  it("exits the CLI with the refusal and does not claim the plugin database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tigercat-plugin-cli-"));
    roots.push(root);
    const dbPath = path.join(root, "state.sqlite");
    const configFile = path.join(root, "missing-config.toml");
    const child = spawn(process.execPath, [path.resolve("dist/cli.js"), "plugin", "--config", configFile], {
      env: { ...process.env, TIGERCAT_PLUGIN_DB: dbPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/refused to start/);
    expect(stderr).toMatch(/cannot inspect or remove Codex native tools/);
    expect(stderr).toMatch(/shell, edit, write/);
    expect(existsSync(`${dbPath}.plugin-lock`)).toBe(false);
  });
});
