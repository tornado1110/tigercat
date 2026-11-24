import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  ["header only", "Original English translation.", /source blob changed without a translation body update/],
  ["source copied", "更新后的中文说明。", /body still matches the Chinese source/],
  ["translation updated", "Updated English translation.", null],
])("audits a committed translation update (%s)", (_name, body, error) => {
  const root = mkdtempSync(path.join(tmpdir(), "tigercat-i18n-"));
  roots.push(root);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (name: string, text: string) => writeFileSync(path.join(root, name), text, "utf8");
  const translate = (hash: string, text: string) =>
    write("README.en.md", `<!-- i18n-source: README.md @ ${hash} -->\n> Machine-assisted translation.\n\n${text}\n`);
  const commit = () => {
    git(["add", "."]);
    git(["-c", "user.email=test@example.org", "-c", "user.name=Test", "commit", "-qm", "fixture"]);
  };

  git(["init", "-q"]);
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(new URL("../../scripts/i18n-check.mjs", import.meta.url), path.join(root, "scripts/i18n-check.mjs"));
  write("README.md", "原来的中文说明。\n");
  translate(git(["hash-object", "README.md"]), "Original English translation.");
  commit();
  const base = git(["rev-parse", "HEAD"]);

  write("README.md", "更新后的中文说明。\n");
  translate(git(["hash-object", "README.md"]), body);
  commit();
  const result = spawnSync(process.execPath, ["scripts/i18n-check.mjs", "--base", base], { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr || result.stdout).toBe(error ? 1 : 0);
  if (error) expect(result.stdout).toMatch(error);
}, 30_000);
