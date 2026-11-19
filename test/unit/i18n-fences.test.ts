import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

const README_TRANSLATIONS = ["README.en.md", "README.ja.md", "README.ko.md", "README.es.md"];
const LANGS = ["en", "ja", "ko", "es"];

describe("translated fenced blocks match the Chinese source", () => {
  it("compares every fence, in order, across README and docs/i18n", () => {
    for (const name of README_TRANSLATIONS) {
      const translation = readRepo(name);
      const sourceName = sourcePath(translation, name);
      assertFencedBlocksMatch(readRepo(sourceName), translation, name);
    }
    for (const lang of LANGS) {
      const dir = new URL(`docs/i18n/${lang}/`, root);
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const rel = `docs/i18n/${lang}/${file}`;
        const translation = readRepo(rel);
        const sourceName = sourcePath(translation, rel);
        assertFencedBlocksMatch(readRepo(sourceName), translation, rel);
      }
    }
  });

  it("fails when one character inside the README.ko.md cc-connect toml block changes", () => {
    const source = readRepo("README.md");
    const original = readRepo("README.ko.md");
    const changed = original.replace('type = "acp"', 'type = "acP"');
    expect(changed).not.toBe(original);
    expect(fencedBlocks(changed).some((block) => block.includes('type = "acP"'))).toBe(true);
    expect(() => assertFencedBlocksMatch(source, changed, "README.ko.md")).toThrow(/fence \d+ differs/);
  });

  it("fails when the translation has a different number of fenced blocks", () => {
    const source = readRepo("README.md");
    const extra = `${readRepo("README.ko.md")}\n\`\`\`\nextra\n\`\`\`\n`;
    expect(() => assertFencedBlocksMatch(source, extra, "README.ko.md")).toThrow(/fence count/);
  });
});

function readRepo(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

function sourcePath(translation: string, label: string): string {
  const header = translation.split(/\r?\n/, 1)[0] ?? "";
  const match = /^<!--\s*i18n-source:\s*(\S+)\s+@\s*[0-9a-f]{40}\s*-->$/.exec(header);
  if (!match?.[1]) throw new Error(`${label}: missing i18n-source header`);
  return match[1];
}

export function assertFencedBlocksMatch(source: string, translation: string, label: string): void {
  const left = fencedBlocks(source);
  const right = fencedBlocks(translation);
  if (left.length !== right.length) {
    throw new Error(`${label}: fence count ${right.length} != ${left.length}`);
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      throw new Error(`${label}: fence ${i} differs`);
    }
  }
}

export function fencedBlocks(markdown: string): string[] {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? "");
    if (!open || (open[2]?.[0] === "`" && (open[3] ?? "").includes("`"))) {
      i += 1;
      continue;
    }
    const marker = open[2]?.[0] === "~" ? "~" : "`";
    const size = open[2]?.length ?? 3;
    const close = new RegExp(`^ {0,3}${marker}{${size},}[ \\t]*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end] ?? "")) end += 1;
    const closed = end < lines.length;
    const raw = lines.slice(i, closed ? end + 1 : lines.length);
    blocks.push(dedentFence(raw).join("\n"));
    i = closed ? end + 1 : lines.length;
  }
  return blocks;
}

function dedentFence(lines: string[]): string[] {
  let common = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const spaces = /^( *)/.exec(line)?.[1].length ?? 0;
    if (spaces < common) common = spaces;
  }
  if (!Number.isFinite(common) || common === 0) return lines;
  return lines.map((line) => (line.trim() === "" ? line : line.slice(common)));
}
