#!/usr/bin/env node
/**
 * Runs acp-tck v0.4.0 against `tigercat acp`.
 *
 * On Windows the pinned harness calls os.killpg during teardown
 * (tck/common/harness/process.py). That API does not exist on win32.
 * The script names those requirement ids and then exits with the
 * harness status. A killpg teardown failure fails this process.
 * It is not a pass. Issue #25.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const ACP_TCK_REF = "v0.4.0";

if (!existsSync(new URL("../dist/cli.js", import.meta.url))) {
  console.error("dist/cli.js is missing. Run npm run build first.");
  process.exit(1);
}

const child = spawn(
  "uvx",
  [
    "--from",
    `git+https://github.com/agentclientprotocol/acp-tck@${ACP_TCK_REF}`,
    "acp-tck",
    "--",
    process.execPath,
    "dist/cli.js",
    "acp",
  ],
  { stdio: ["inherit", "pipe", "pipe"] },
);

let log = "";
child.stdout?.on("data", (chunk) => {
  const text = String(chunk);
  log += text;
  process.stdout.write(text);
});
child.stderr?.on("data", (chunk) => {
  const text = String(chunk);
  log += text;
  process.stderr.write(text);
});

child.on("error", (error) => {
  if (error && error.code === "ENOENT") {
    console.error("uvx was not found. Install uv to run acp-tck: https://docs.astral.sh/uv/");
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});

child.on("exit", (code) => {
  const status = code ?? 1;
  if (status !== 0 && process.platform === "win32") {
    const killpg = log.includes("has no attribute 'killpg'") || log.includes("os.killpg");
    if (killpg) {
      const failed = [...log.matchAll(/^\s*(ACP-[A-Z0-9-]+)\s+FAIL\s*$/gm)].map((match) => match[1]);
      console.error("");
      console.error(
        "acp-tck failed. Windows teardown calls os.killpg, which Node's Windows os module does not provide. This is not a pass.",
      );
      for (const id of failed) console.error(`  UNVERIFIED ${id}`);
    }
  }
  process.exit(status);
});
