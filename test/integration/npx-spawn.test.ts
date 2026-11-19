import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAdapterCommand, npxCliPath } from "../../src/builtins.js";

describe("windows npx spawn", () => {
  it.skipIf(process.platform !== "win32")("runs npx --version without EINVAL", () => {
    const cli = npxCliPath(process.execPath);
    const command = buildAdapterCommand("win32", process.env, {
      execPath: process.execPath,
      npxArgs: ["--version"],
      npxCliExists: existsSync(cli),
    });
    const result = spawnSync(command.command, command.args, {
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments === true,
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toMatch(/\d+\.\d+\.\d+/);
  });
});
