import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scriptsDir = join(repoRoot, "scripts");

async function loadResultModule() {
  const href = pathToFileURL(join(scriptsDir, "tck-result.mjs")).href;
  return import(href);
}

async function loadRunner() {
  const href = pathToFileURL(join(scriptsDir, "acp-tck.mjs")).href;
  return import(href);
}

const failingReport = {
  verdict: {
    conformant: false,
    blocked_by_auth: false,
    blocked_by_version_mismatch: false,
    tier_counts: {
      MANDATORY: { PASS: 28, FAIL: 2, SKIPPED: 1, NOT_TESTED: 1 },
      CAPABILITY: { PASS: 0, FAIL: 0, SKIPPED: 42, NOT_TESTED: 0 },
    },
  },
};

const passingReport = {
  verdict: {
    conformant: true,
    blocked_by_auth: false,
    blocked_by_version_mismatch: false,
    tier_counts: {
      MANDATORY: { PASS: 30, FAIL: 0, SKIPPED: 2, NOT_TESTED: 0 },
      CAPABILITY: { PASS: 0, FAIL: 0, SKIPPED: 42, NOT_TESTED: 0 },
    },
  },
};

function fakeChild(chunks: { stdout?: string; stderr?: string; code?: number | null; error?: NodeJS.ErrnoException }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (chunks.error) {
      child.emit("error", chunks.error);
      return;
    }
    if (chunks.stdout) child.stdout.emit("data", Buffer.from(chunks.stdout));
    if (chunks.stderr) child.stderr.emit("data", Buffer.from(chunks.stderr));
    child.emit("exit", chunks.code === undefined ? 0 : chunks.code);
  });
  return child;
}

describe("acp-tck result", () => {
  it("copies the terminal VERDICT line and MANDATORY counts from the report", async () => {
    const { buildResult, verdictLineFromReport } = await loadResultModule();
    expect(verdictLineFromReport(failingReport.verdict)).toBe(
      "VERDICT: NOT CONFORMANT (2 mandatory failures, 1 mandatory not tested)",
    );
    expect(verdictLineFromReport({ ...failingReport.verdict, conformant: false, tier_counts: {
      MANDATORY: { PASS: 0, FAIL: 1, SKIPPED: 0, NOT_TESTED: 0 },
      CAPABILITY: { FAIL: 1 },
    }, blocked_by_auth: true, blocked_by_version_mismatch: true })).toBe(
      "VERDICT: NOT CONFORMANT (1 mandatory failure, 1 capability failure, blocked by authentication, blocked by version mismatch)",
    );

    const result = buildResult({
      report: passingReport,
      log: "",
      status: 0,
      platform: "linux",
    });
    expect(result.verdictLine).toBe("VERDICT: CONFORMANT");
    expect(result.exitCode).toBe(0);
    expect(result.mandatory).toEqual({ passed: 30, failed: 0, skipped: 2, notTested: 0, total: 32 });
    expect(result.unverified).toEqual([]);
  });

  it("parses a CRLF, ANSI-colored log when the JSON report is missing", async () => {
    const { buildResult } = await loadResultModule();
    const log = [
      "\u001b[32m  MANDATORY      PASS=30, FAIL=0, SKIPPED=2, NOT_TESTED=0\u001b[0m",
      "VERDICT: CONFORMANT",
    ].join("\r\n");
    const result = buildResult({ report: null, log, status: 0, platform: "win32" });
    expect(result.verdictLine).toBe("VERDICT: CONFORMANT");
    expect(result.mandatory).toEqual({ passed: 30, failed: 0, skipped: 2, notTested: 0, total: 32 });
  });

  it("lists UNVERIFIED ids only for a non-zero Windows killpg teardown", async () => {
    const { unverifiedIds } = await loadResultModule();
    const log = [
      "  ACP-SESSION-001              FAIL",
      "  ACP-CANCEL-002               PASS",
      "AttributeError: module 'os' has no attribute 'killpg'",
    ].join("\r\n");
    expect(unverifiedIds(log, { platform: "win32", status: 1 })).toEqual(["ACP-SESSION-001"]);
    expect(unverifiedIds(log, { platform: "win32", status: 0 })).toEqual([]);
    expect(unverifiedIds(log, { platform: "linux", status: 1 })).toEqual([]);
  });

  it("renders the summary with LF and the failure lines", async () => {
    const { buildResult, renderSummary } = await loadResultModule();
    const log = "  ACP-INIT-001                 FAIL\r\nos.killpg\r\n";
    const result = buildResult({ report: failingReport, log, status: 1, platform: "win32" });
    const markdown = renderSummary(result);
    expect(markdown).toContain("VERDICT: NOT CONFORMANT (2 mandatory failures, 1 mandatory not tested)");
    expect(markdown).toContain("MANDATORY passed: 28");
    expect(markdown).toContain("MANDATORY failed: 2");
    expect(markdown).toContain("MANDATORY skipped: 1");
    expect(markdown).toContain("MANDATORY not tested: 1");
    expect(markdown).toContain("MANDATORY total: 32");
    expect(markdown).toContain("UNVERIFIED ACP-INIT-001");
    expect(markdown.includes("\r")).toBe(false);
  });
});

describe("acp-tck process", () => {
  it("keeps a failing harness exit code and records UNVERIFIED for the summary", async () => {
    const { runAcpTck } = await loadRunner();
    const dir = mkdtempSync(join(tmpdir(), "acp-tck-fail-"));
    const resultPath = join(dir, "acp-tck-result.json");
    const stderr: string[] = [];
    const stdout: string[] = [];
    let exitCode = -1;
    const log = [
      "  ACP-INIT-001                 FAIL",
      "  MANDATORY      PASS=28, FAIL=2, SKIPPED=1, NOT_TESTED=1",
      "VERDICT: NOT CONFORMANT (2 mandatory failures, 1 mandatory not tested)",
      "AttributeError: module 'os' has no attribute 'killpg'",
    ].join("\r\n");

    await new Promise<void>((resolve) => {
      runAcpTck({
        cliExists: true,
        platform: "win32",
        resultPath,
        stdout: { write: (chunk: string) => stdout.push(chunk) },
        stderr: { write: (chunk: string) => stderr.push(chunk) },
        exit: (code: number) => {
          exitCode = code;
          resolve();
        },
        spawnFn: (_command: string, args: string[]) => {
          const reportFlag = args.indexOf("--report-json");
          expect(reportFlag).toBeGreaterThan(-1);
          expect(args[args.indexOf("--") + 1]).toBe(process.execPath);
          writeFileSync(args[reportFlag + 1], JSON.stringify(failingReport));
          return fakeChild({ code: 1, stdout: log });
        },
      });
    });

    expect(exitCode).toBe(1);
    const recorded = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(recorded.exitCode).toBe(1);
    expect(recorded.verdictLine).toBe(
      "VERDICT: NOT CONFORMANT (2 mandatory failures, 1 mandatory not tested)",
    );
    expect(recorded.mandatory).toEqual({ passed: 28, failed: 2, skipped: 1, notTested: 1, total: 32 });
    expect(recorded.unverified).toEqual(["ACP-INIT-001"]);
    expect(stderr.join("")).toContain("  UNVERIFIED ACP-INIT-001\n");
    expect(stdout.join("")).toContain("ACP-INIT-001");
    expect(readFileSync(resultPath, "utf8").includes("\r")).toBe(false);
  });

  it("does not turn a zero harness status into a failure", async () => {
    const { runAcpTck } = await loadRunner();
    const dir = mkdtempSync(join(tmpdir(), "acp-tck-pass-"));
    const resultPath = join(dir, "acp-tck-result.json");
    let exitCode = -1;
    const sink = { write: () => undefined };
    await new Promise<void>((resolve) => {
      runAcpTck({
        cliExists: true,
        platform: "win32",
        resultPath,
        stdout: sink,
        stderr: sink,
        exit: (code: number) => {
          exitCode = code;
          resolve();
        },
        spawnFn: (_command: string, args: string[]) => {
          const reportFlag = args.indexOf("--report-json");
          writeFileSync(args[reportFlag + 1], JSON.stringify(passingReport));
          return fakeChild({
            code: 0,
            stderr: "module 'os' has no attribute 'killpg'\r\n  ACP-INIT-001                 FAIL\r\n",
          });
        },
      });
    });
    expect(exitCode).toBe(0);
    const recorded = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(recorded.exitCode).toBe(0);
    expect(recorded.unverified).toEqual([]);
    expect(recorded.verdictLine).toBe("VERDICT: CONFORMANT");
  });

  it("still exits non-zero when uvx is missing, and writes a summary result", async () => {
    const { runAcpTck } = await loadRunner();
    const dir = mkdtempSync(join(tmpdir(), "acp-tck-missing-"));
    const resultPath = join(dir, "acp-tck-result.json");
    let exitCode = -1;
    const sink = { write: () => undefined };
    await new Promise<void>((resolve) => {
      runAcpTck({
        cliExists: true,
        platform: "linux",
        resultPath,
        stdout: sink,
        stderr: sink,
        exit: (code: number) => {
          exitCode = code;
          resolve();
        },
        spawnFn: () => fakeChild({ error: Object.assign(new Error("spawn uvx ENOENT"), { code: "ENOENT" }) }),
      });
    });
    expect(exitCode).toBe(2);
    const recorded = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(recorded.exitCode).toBe(2);
    expect(recorded.verdictLine).toBe("VERDICT: unavailable");
  });
});

describe("job summary step", () => {
  function runSummary(resultPath: string, summaryPath: string) {
    return spawnSync(process.execPath, [join(scriptsDir, "acp-tck-summary.mjs")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ACP_TCK_RESULT: resultPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      encoding: "utf8",
    });
  }

  it("writes a failing verdict into the summary file and exits 0", async () => {
    const { buildResult, writeResultFile } = await loadResultModule();
    const dir = mkdtempSync(join(tmpdir(), "acp-tck-summary-"));
    const resultPath = join(dir, "acp-tck-result.json");
    const summaryPath = join(dir, "summary.md");
    const result = buildResult({
      report: failingReport,
      log: "  ACP-INIT-001                 FAIL\nos.killpg\n",
      status: 1,
      platform: "win32",
    });
    writeResultFile(resultPath, result);
    writeFileSync(resultPath, readFileSync(resultPath, "utf8").replace(/\n/g, "\r\n"));

    const summary = runSummary(resultPath, summaryPath);
    expect(summary.status).toBe(0);
    const text = readFileSync(summaryPath);
    expect(text.includes(13)).toBe(false);
    const markdown = text.toString("utf8");
    expect(markdown).toContain("VERDICT: NOT CONFORMANT (2 mandatory failures, 1 mandatory not tested)");
    expect(markdown).toContain("MANDATORY passed: 28");
    expect(markdown).toContain("MANDATORY failed: 2");
    expect(markdown).toContain("MANDATORY skipped: 1");
    expect(markdown).toContain("MANDATORY total: 32");
    expect(markdown).toContain("UNVERIFIED ACP-INIT-001");
    expect(summary.stdout).toContain("UNVERIFIED ACP-INIT-001");
  });

  it.skipIf(process.platform === "win32")("runs the real script entry, fails the step, and still summarizes", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-tck-entry-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const fake = join(dir, "fake-uvx.mjs");
    writeFileSync(
      fake,
      `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const report = args[args.indexOf("--report-json") + 1];
writeFileSync(report, JSON.stringify(${JSON.stringify(failingReport)}));
process.stdout.write("  ACP-INIT-001                 FAIL\\n");
process.stdout.write("VERDICT: NOT CONFORMANT (2 mandatory failures, 1 mandatory not tested)\\n");
process.exit(1);
`,
    );
    const uvx = join(bin, "uvx");
    writeFileSync(uvx, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    chmodSync(uvx, 0o755);
    const resultPath = join(dir, "acp-tck-result.json");
    const tck = spawnSync(process.execPath, [join(scriptsDir, "acp-tck.mjs")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        ACP_TCK_RESULT: resultPath,
      },
      encoding: "utf8",
    });
    expect(tck.status).not.toBe(0);
    const summaryPath = join(dir, "summary.md");
    const summary = runSummary(resultPath, summaryPath);
    expect(summary.status).toBe(0);
    const markdown = readFileSync(summaryPath, "utf8");
    expect(markdown).toContain("VERDICT: NOT CONFORMANT");
    expect(markdown).toContain("MANDATORY failed: 2");
    expect(tck.status).toBe(1);
  });
});
