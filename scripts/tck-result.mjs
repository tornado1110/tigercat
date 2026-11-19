/**
 * Turns an acp-tck run into the small JSON file the CI job summary renders.
 *
 * The harness process status is the pass/fail gate. This module only records
 * it. A NOT CONFORMANT verdict or an UNVERIFIED id does not get rewritten
 * into exit 0.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_RESULT_NAME = "acp-tck-result.json";

const ANSI = /\u001b\[[0-9;]*m/g;
const FAIL_LINE = /^\s*(ACP-[A-Z0-9-]+)\s+FAIL\s*$/gm;
const MANDATORY_COUNTS =
  /^ {2}MANDATORY\s+PASS=(\d+), FAIL=(\d+), SKIPPED=(\d+), NOT_TESTED=(\d+)\s*$/m;
const VERDICT_LINE = /^VERDICT: (.+)\s*$/m;

export function resultPathFromEnv(env = process.env, cwd = process.cwd()) {
  return env.ACP_TCK_RESULT || join(cwd, DEFAULT_RESULT_NAME);
}

export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function countOf(tierCounts, tier, status) {
  const value = tierCounts?.[tier]?.[status];
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function mandatoryCounts(tierCounts) {
  const passed = countOf(tierCounts, "MANDATORY", "PASS");
  const failed = countOf(tierCounts, "MANDATORY", "FAIL");
  const skipped = countOf(tierCounts, "MANDATORY", "SKIPPED");
  const notTested = countOf(tierCounts, "MANDATORY", "NOT_TESTED");
  return {
    passed,
    failed,
    skipped,
    notTested,
    total: passed + failed + skipped + notTested,
  };
}

/**
 * Same wording as acp-tck's terminal `VERDICT:` line
 * (`tck/common/plugin.py` `_verdict_reason`, v0.4.0).
 */
export function verdictLineFromReport(verdict) {
  if (!verdict || typeof verdict.conformant !== "boolean" || !verdict.tier_counts) return null;
  if (verdict.conformant) return "VERDICT: CONFORMANT";
  const failed = countOf(verdict.tier_counts, "MANDATORY", "FAIL");
  const notTested = countOf(verdict.tier_counts, "MANDATORY", "NOT_TESTED");
  const capabilityFailed = countOf(verdict.tier_counts, "CAPABILITY", "FAIL");
  const parts = [];
  if (failed) parts.push(`${failed} mandatory failure${failed === 1 ? "" : "s"}`);
  if (notTested) parts.push(`${notTested} mandatory not tested`);
  if (capabilityFailed) {
    parts.push(`${capabilityFailed} capability failure${capabilityFailed === 1 ? "" : "s"}`);
  }
  if (verdict.blocked_by_auth) parts.push("blocked by authentication");
  if (verdict.blocked_by_version_mismatch) parts.push("blocked by version mismatch");
  const reason = parts.join(", ") || "no cause recorded";
  return `VERDICT: NOT CONFORMANT (${reason})`;
}

export function parseLogSummary(log) {
  const text = stripAnsi(log);
  const counts = text.match(MANDATORY_COUNTS);
  const verdict = text.match(VERDICT_LINE);
  if (!counts && !verdict) return null;
  const mandatory = counts
    ? {
        passed: Number(counts[1]),
        failed: Number(counts[2]),
        skipped: Number(counts[3]),
        notTested: Number(counts[4]),
        total: Number(counts[1]) + Number(counts[2]) + Number(counts[3]) + Number(counts[4]),
      }
    : null;
  return {
    verdictLine: verdict ? `VERDICT: ${verdict[1].trim()}` : null,
    conformant: verdict ? verdict[1].trim() === "CONFORMANT" : null,
    mandatory,
  };
}

/**
 * Windows killpg teardown. Only when the harness already exited non-zero
 * on win32, matching the gate in `acp-tck.mjs`. A hit is not a pass.
 */
export function windowsKillpgFailure(log, { platform, status }) {
  if (status === 0 || platform !== "win32") return false;
  const text = stripAnsi(log);
  return text.includes("has no attribute 'killpg'") || text.includes("os.killpg");
}

export function unverifiedIds(log, { platform, status }) {
  if (!windowsKillpgFailure(log, { platform, status })) return [];
  return [...stripAnsi(log).matchAll(FAIL_LINE)].map((match) => match[1]);
}

export function emptyResult(error) {
  return {
    verdictLine: "VERDICT: unavailable",
    conformant: null,
    exitCode: null,
    mandatory: null,
    unverified: [],
    error,
  };
}

export function buildResult({ report, log = "", status, platform, error = null }) {
  const unverified = unverifiedIds(log, { platform, status });
  const fromReport = report?.verdict
    ? {
        verdictLine: verdictLineFromReport(report.verdict),
        conformant: report.verdict.conformant,
        mandatory: report.verdict.tier_counts ? mandatoryCounts(report.verdict.tier_counts) : null,
      }
    : null;
  const fromLog = fromReport?.verdictLine ? null : parseLogSummary(log);
  const chosen = fromReport?.verdictLine ? fromReport : fromLog;
  return {
    verdictLine: chosen?.verdictLine ?? "VERDICT: unavailable",
    conformant: chosen?.conformant ?? null,
    exitCode: status,
    mandatory: chosen?.mandatory ?? null,
    unverified,
    error,
  };
}

export function renderSummary(result) {
  const lines = ["### acp-tck", "", "```text"];
  lines.push(result?.verdictLine || "VERDICT: unavailable");
  if (result?.mandatory) {
    lines.push(`MANDATORY passed: ${result.mandatory.passed}`);
    lines.push(`MANDATORY failed: ${result.mandatory.failed}`);
    lines.push(`MANDATORY skipped: ${result.mandatory.skipped}`);
    lines.push(`MANDATORY not tested: ${result.mandatory.notTested}`);
    lines.push(`MANDATORY total: ${result.mandatory.total}`);
  } else {
    lines.push("MANDATORY passed: unavailable");
    lines.push("MANDATORY failed: unavailable");
    lines.push("MANDATORY skipped: unavailable");
    lines.push("MANDATORY not tested: unavailable");
    lines.push("MANDATORY total: unavailable");
  }
  if (result?.unverified?.length) {
    lines.push("");
    for (const id of result.unverified) lines.push(`UNVERIFIED ${id}`);
  }
  if (result?.error) {
    lines.push("");
    lines.push(String(result.error));
  }
  lines.push("```", "");
  return lines.join("\n");
}

export function writeResultFile(filePath, result) {
  writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
