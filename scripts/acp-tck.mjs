#!/usr/bin/env node
/**
 * Runs acp-tck v0.4.0 against `tigercat acp`.
 *
 * On Windows the pinned harness calls os.killpg during teardown
 * (tck/common/harness/process.py). That API does not exist on win32.
 * The script names those requirement ids and then exits with the
 * harness status. A killpg teardown failure fails this process.
 * It is not a pass. Issue #25.
 *
 * The harness status is the process exit code. This script also writes
 * acp-tck-result.json (verdict, MANDATORY counts, UNVERIFIED ids) for the
 * CI job summary. Writing that file does not change the exit code.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildResult,
  resultPathFromEnv,
  unverifiedIds,
  windowsKillpgFailure,
  writeResultFile,
} from "./tck-result.mjs";

const ACP_TCK_REF = "v0.4.0";

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function readReport(reportPath) {
  try {
    if (!existsSync(reportPath)) return null;
    const text = readFileSync(reportPath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function runAcpTck(options = {}) {
  const spawnFn = options.spawnFn ?? spawn;
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const exit = options.exit ?? ((code) => process.exit(code));
  const stdioOut = options.stdout ?? process.stdout;
  const stdioErr = options.stderr ?? process.stderr;
  const resultPath = options.resultPath ?? resultPathFromEnv();
  const cliExists = options.cliExists ?? existsSync(new URL("../dist/cli.js", import.meta.url));
  const reportDir =
    options.reportDir ?? mkdtempSync(join(tmpdir(), "acp-tck-"));
  const reportPath = join(reportDir, "report.json");

  let settled = false;
  const finish = (status, log, error = null) => {
    if (settled) return;
    settled = true;
    const result = buildResult({
      report: readReport(reportPath),
      log,
      status,
      platform,
      error,
    });
    try {
      writeResultFile(resultPath, result);
    } catch (writeError) {
      stdioErr.write(`failed to write ${resultPath}: ${writeError.message}\n`);
    }
    try {
      rmSync(reportDir, { recursive: true, force: true });
    } catch {
      // The report is a temp file. Leaving it does not change the exit code.
    }
    exit(status);
  };

  if (!cliExists) {
    const message = "dist/cli.js is missing. Run npm run build first.";
    stdioErr.write(`${message}\n`);
    finish(1, "", message);
    return;
  }

  const child = spawnFn(
    "uvx",
    [
      "--from",
      `git+https://github.com/agentclientprotocol/acp-tck@${ACP_TCK_REF}`,
      "acp-tck",
      "--report-json",
      reportPath,
      "--",
      execPath,
      "dist/cli.js",
      "acp",
    ],
    { stdio: ["inherit", "pipe", "pipe"] },
  );

  let log = "";
  child.stdout?.on("data", (chunk) => {
    const text = String(chunk);
    log += text;
    stdioOut.write(text);
  });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    log += text;
    stdioErr.write(text);
  });

  child.on("error", (error) => {
    if (error && error.code === "ENOENT") {
      const message = "uvx was not found. Install uv to run acp-tck: https://docs.astral.sh/uv/";
      stdioErr.write(`${message}\n`);
      finish(2, log, message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    stdioErr.write(`${message}\n`);
    finish(1, log, message);
  });

  child.on("exit", (code) => {
    const status = code ?? 1;
    if (windowsKillpgFailure(log, { platform, status })) {
      const failed = unverifiedIds(log, { platform, status });
      stdioErr.write("\n");
      stdioErr.write(
        "acp-tck failed. Windows teardown calls os.killpg, which Node's Windows os module does not provide. This is not a pass.\n",
      );
      for (const id of failed) stdioErr.write(`  UNVERIFIED ${id}\n`);
    }
    finish(status, log);
  });
}

if (invokedDirectly()) {
  runAcpTck();
}
