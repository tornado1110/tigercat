#!/usr/bin/env node
/**
 * Report translations that lag the Simplified Chinese source.
 *
 * Each translation records the git blob hash of its Chinese source
 * (`git rev-parse HEAD:<path>`). This compares that value with the blob
 * hash of the same file in the working tree, after CRLF is turned into LF.
 * Commit SHAs are not used: a rebase merge rewrites them. This only
 * reports. The process always exits 0.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
  return source.length > 0 && !source.startsWith("/") && !source.split("/").includes("..");
}

function blobHash(source) {
  const raw = readFileSync(join(root, source));
  const normalized = Buffer.from(String(raw).replace(/\r\n/g, "\n"), "utf8");
  return execFileSync("git", ["hash-object", "--stdin"], {
    cwd: root,
    input: normalized,
    encoding: "utf8",
  }).trim();
}

function report() {
  const lines = [];
  for (const file of translations()) {
    const rel = relative(root, file).split("\\").join("/");
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      lines.push(`stale ${rel}: file is missing`);
      continue;
    }
    const first = text.split(/\r?\n/, 1)[0];
    const match = HEADER.exec(first);
    if (!match) {
      lines.push(`stale ${rel}: missing i18n-source blob header`);
      continue;
    }
    const source = match[1];
    const recorded = match[2];
    if (!sourcePathOk(source)) {
      lines.push(`stale ${rel}: source path ${source} is outside the repo`);
      continue;
    }
    let actual = "";
    try {
      actual = blobHash(source);
    } catch {
      actual = "";
    }
    if (!actual) {
      lines.push(`stale ${rel}: cannot hash ${source} (records ${recorded})`);
      continue;
    }
    if (actual !== recorded) {
      lines.push(`stale ${rel}: records ${source} @ ${recorded}, working tree is ${actual}`);
    }
  }
  return lines;
}

try {
  for (const line of report()) console.log(line);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`stale check failed: ${message}`);
}
process.exit(0);
