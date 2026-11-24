#!/usr/bin/env node
/**
 * Report translations that lag the Simplified Chinese source.
 *
 * Each translation records the git blob hash of its Chinese source
 * (`git rev-parse HEAD:<path>`). This compares that value with the blob
 * hash of the same file in the working tree, after CRLF is turned into LF.
 * Use --base <revision> to audit committed updates against a PR base.
 * Ordinary stale translations are advisory. Invalid updates fail the check.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEADER = /^<!--\s*i18n-source:\s*(\S+)\s+@\s*([0-9a-f]{40})\s*-->$/;
const README_NAMES = ["README.en.md", "README.ja.md", "README.ko.md", "README.es.md"];
const LANGS = ["en", "ja", "ko", "es"];

function walk(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (name.endsWith(".md")) files.push(path);
  }
  return files;
}

function translations() {
  const files = README_NAMES.map((name) => join(root, name));
  const expectedDocs = new Set();
  for (const lang of LANGS) {
    for (const file of walk(join(root, "docs", "i18n", lang))) {
      expectedDocs.add(relative(join(root, "docs", "i18n", lang), file));
    }
  }
  for (const lang of LANGS) {
    const directory = join(root, "docs", "i18n", lang);
    for (const relativeFile of expectedDocs) files.push(join(directory, relativeFile));
  }
  return files.sort();
}

function sourcePathOk(source) {
  return source.length > 0 && !source.startsWith("/") && !/[:\\]/.test(source) && !source.split("/").includes("..");
}

function blobHash(sourceText) {
  return execFileSync("git", ["hash-object", "--stdin"], {
    cwd: root,
    input: sourceText.replace(/\r\n/g, "\n"),
    encoding: "utf8",
  }).trim();
}

function translationBody(text) {
  const lines = text.split(/\r?\n/);
  if (HEADER.test(lines[0])) {
    lines.shift();
    if (lines[0]?.startsWith("> ")) lines.shift();
  }
  return lines.join("\n").replace(/\s+/g, " ").trim();
}

function previousTranslations(base) {
  const paths = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", base], { cwd: root, encoding: "utf8" });
  return new Set(paths.split("\0"));
}

function report(base) {
  const previousPaths = previousTranslations(base);
  let invalid = false;
  for (const file of translations()) {
    const rel = relative(root, file).split("\\").join("/");
    function fail(reason) {
      console.log(`invalid ${rel}: ${reason}`);
      invalid = true;
    }
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      console.log(`stale ${rel}: file is missing`);
      continue;
    }
    const first = text.split(/\r?\n/, 1)[0];
    const match = HEADER.exec(first);
    if (!match) {
      console.log(`stale ${rel}: missing i18n-source blob header`);
      continue;
    }
    const source = match[1];
    const recorded = match[2];
    if (!sourcePathOk(source)) {
      console.log(`stale ${rel}: source path ${source} is outside the repo`);
      continue;
    }
    let sourceText;
    try {
      sourceText = readFileSync(join(root, source), "utf8");
    } catch {
      console.log(`stale ${rel}: cannot read ${source} (records ${recorded})`);
      continue;
    }
    const actual = blobHash(sourceText);
    if (actual !== recorded) {
      console.log(`stale ${rel}: records ${source} @ ${recorded}, working tree is ${actual}`);
    }
    const body = translationBody(text);
    if (body === translationBody(sourceText)) {
      fail("body still matches the Chinese source");
      continue;
    }
    if (previousPaths.has(rel)) {
      const previous = execFileSync("git", ["show", `${base}:${rel}`], { cwd: root, encoding: "utf8" });
      const previousHeader = HEADER.exec(previous.split(/\r?\n/, 1)[0]);
      if (previousHeader && previousHeader[2] !== recorded && translationBody(previous) === body) {
        fail("source blob changed without a translation body update");
      }
    }
  }
  return invalid ? 1 : 0;
}

try {
  const { values } = parseArgs({ options: { base: { type: "string", default: "HEAD" } } });
  const base = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  process.exitCode = report(base);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`stale check failed: ${message}`);
  process.exitCode = 1;
}
