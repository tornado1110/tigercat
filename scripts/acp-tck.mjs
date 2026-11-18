#!/usr/bin/env node
/**
 * Runs the official ACP Test Compatibility Kit against `tigercat acp`.
 * Pinned to acp-tck v0.4.0 (git tag). Requires `uv` (https://docs.astral.sh/uv/).
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
  { stdio: "inherit" },
);

child.on("error", (error) => {
  if (error && error.code === "ENOENT") {
    console.error(
      "uvx was not found. Install uv to run acp-tck: https://docs.astral.sh/uv/",
    );
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
