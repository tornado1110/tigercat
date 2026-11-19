#!/usr/bin/env node
/**
 * Renders acp-tck-result.json into $GITHUB_STEP_SUMMARY.
 *
 * This step is informational. It exits 0 after writing the summary, including
 * when the verdict is NOT CONFORMANT or UNVERIFIED ids are listed. The
 * acp-tck step's exit code is what fails the job.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { emptyResult, renderSummary, resultPathFromEnv } from "./tck-result.mjs";

function loadResult(resultPath) {
  if (!existsSync(resultPath)) {
    return emptyResult("The TCK result file was not written.");
  }
  try {
    const text = readFileSync(resultPath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return emptyResult(`The TCK result file could not be read (${message}).`);
  }
}

const markdown = renderSummary(loadResult(resultPathFromEnv()));
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  appendFileSync(summaryPath, markdown, "utf8");
}
process.stdout.write(markdown);
