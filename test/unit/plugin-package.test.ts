import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { buildPlugin, collectProductionPackages } = await import(pathToFileURL(path.join(repository, "scripts/build-plugin.mjs")).href);
const temporary: string[] = [];

async function put(root: string, name: string, contents: string | object) {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "tigercat-plugin-package-"));
  temporary.push(root);
  await put(root, "package.json", {
    name: "fixture", version: "0.1.0", type: "module",
    dependencies: { alpha: "1", shared: "1" },
    devDependencies: { development: "1" },
  });
  await put(root, "node_modules/alpha/package.json", {
    name: "alpha", version: "1.0.0", type: "module", exports: "./index.js",
    dependencies: { shared: "2" },
    peerDependencies: { peer: "1", optionalPeer: "1" },
    peerDependenciesMeta: { optionalPeer: { optional: true } },
    optionalDependencies: { optionalPackage: "1" },
  });
  await put(root, "node_modules/alpha/index.js", 'import shared from "shared"; import peer from "peer"; export default shared + peer;');
  for (const [directory, value] of [["shared", "root-shared"], ["peer", "+peer"], ["alpha/node_modules/shared", "nested-shared"]]) {
    await put(root, `node_modules/${directory}/package.json`, { name: directory.split("/").at(-1), type: "module", exports: "./index.js", version: "1.0.0" });
    await put(root, `node_modules/${directory}/index.js`, `export default ${JSON.stringify(value)};`);
  }
  await put(root, "node_modules/development/package.json", { name: "development", version: "1.0.0" });
  await put(root, "dist/cli.js", [
    'import alpha from "alpha";',
    'import shared from "shared";',
    'import { readFileSync } from "node:fs";',
    'export async function main(args) {',
    '  const rules = readFileSync(new URL("../examples/rules.default.toml", import.meta.url), "utf8");',
    '  console.log(JSON.stringify({ alpha, shared, args, rules })); return 0;',
    '}',
  ].join("\n"));
  await put(root, "dist/redact.js", "export const redactText = (value) => value;");
  await put(root, "examples/rules.default.toml", "fixture-rules");
  await put(root, "LICENSE", "fixture-license");
  const pluginRoot = path.join(root, "plugins/codex");
  await put(pluginRoot, ".codex-plugin/plugin.json", { name: "tigercat", version: "0.1.0", skills: "./skills/", mcpServers: "./.mcp.json" });
  await put(pluginRoot, ".mcp.json", { mcpServers: { tigercat: { command: "node", args: ["server/cli.js", "plugin"], cwd: "." } } });
  await put(pluginRoot, "skills/tigercat/SKILL.md", "---\nname: tigercat\ndescription: Manage TigerCat workers.\n---\n");
  await put(pluginRoot, "README.md", "fixture plugin");
  return { root, pluginRoot };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Codex plugin package", () => {
  it("collects required runtime dependencies, nested versions and peers, excluding development packages", async () => {
    const { root } = await fixture();
    expect((await collectProductionPackages(root)).map((value: string) => value.split(path.sep).join("/"))).toEqual([
      "node_modules/alpha", "node_modules/alpha/node_modules/shared", "node_modules/peer", "node_modules/shared",
    ]);
  });

  it("runs a complete relocated plugin without the repository or developer packages", async () => {
    const { root, pluginRoot } = await fixture();
    await put(root, ".env", "SECRET=must-not-be-copied");
    await put(root, ".tigercat/state.sqlite", "private state");
    await put(root, "node_modules/alpha/.env", "PACKAGE_SECRET=private");
    await put(root, "node_modules/alpha/cache.sqlite", "package private state");
    const destination = path.join(root, "built");
    const result = await buildPlugin({ root, pluginRoot, destination });
    expect(result.dependencyCount).toBe(4);
    expect(existsSync(path.join(destination, ".codex-plugin/plugin.json"))).toBe(true);
    expect(existsSync(path.join(destination, "skills/tigercat/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(destination, "LICENSE"))).toBe(true);
    for (const name of [".env", ".tigercat", "server/node_modules/development", "server/node_modules/alpha/.env", "server/node_modules/alpha/cache.sqlite"]) {
      expect(existsSync(path.join(destination, name)), name).toBe(false);
    }
    const relocated = await mkdtemp(path.join(tmpdir(), "tigercat-plugin-relocated-"));
    temporary.push(relocated);
    await rename(destination, path.join(relocated, "plugin"));
    await rm(path.join(root, "node_modules"), { recursive: true });
    await rm(path.join(root, "dist"), { recursive: true });
    const output = execFileSync(process.execPath, ["server/cli.js", "plugin"], { cwd: path.join(relocated, "plugin"), encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ alpha: "nested-shared+peer", shared: "root-shared", args: ["plugin"], rules: "fixture-rules" });
  });

  it("rebuilds only generated server files without changing the authored plugin", async () => {
    const { root, pluginRoot } = await fixture();
    const manifestBefore = await readFile(path.join(pluginRoot, ".codex-plugin/plugin.json"), "utf8");
    await buildPlugin({ root, pluginRoot });
    await put(pluginRoot, "server/stale-file.txt", "old");
    await buildPlugin({ root, pluginRoot });
    expect(existsSync(path.join(pluginRoot, "server/stale-file.txt"))).toBe(false);
    expect(await readFile(path.join(pluginRoot, ".codex-plugin/plugin.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(path.join(pluginRoot, "server/LICENSE"), "utf8")).toBe("fixture-license");
  });

  it("fails before replacing an existing server when a required dependency is unavailable", async () => {
    const { root, pluginRoot } = await fixture();
    await rm(path.join(root, "node_modules/peer"), { recursive: true });
    await put(pluginRoot, "server/keep.txt", "previous working server");
    await expect(buildPlugin({ root, pluginRoot })).rejects.toThrow("Missing production dependency peer");
    expect(await readFile(path.join(pluginRoot, "server/keep.txt"), "utf8")).toBe("previous working server");
  });

  it("rejects linked dependencies outside the installed tree", async () => {
    const { root } = await fixture();
    const foreign = await mkdtemp(path.join(tmpdir(), "tigercat-plugin-foreign-"));
    temporary.push(foreign);
    await put(foreign, "package.json", { name: "alpha", version: "1.0.0" });
    await rm(path.join(root, "node_modules/alpha"), { recursive: true });
    await symlink(foreign, path.join(root, "node_modules/alpha"), process.platform === "win32" ? "junction" : "dir");
    await expect(collectProductionPackages(root)).rejects.toThrow("outside the installed dependency tree");
  });

  it("wires the authored MCP entry point relative to the distributable plugin root", async () => {
    const plugin = path.join(repository, "plugins/codex");
    const manifest = JSON.parse(await readFile(path.join(plugin, ".codex-plugin/plugin.json"), "utf8"));
    const mcp = JSON.parse(await readFile(path.join(plugin, manifest.mcpServers), "utf8"));
    expect(mcp.mcpServers.tigercat).toEqual({ command: "node", args: ["server/cli.js", "plugin"], cwd: "." });
    expect(existsSync(path.join(plugin, manifest.skills, "tigercat/SKILL.md"))).toBe(true);
  });
});
