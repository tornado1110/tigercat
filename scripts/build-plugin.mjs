import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function dependencyDirectory(root, from, name) {
  if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid dependency name: ${name}`);
  }
  for (let directory = from; inside(root, directory); directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", name);
    if (await exists(path.join(candidate, "package.json"))) {
      const resolved = await realpath(candidate);
      if (!inside(path.join(root, "node_modules"), resolved)) {
        throw new Error(`Dependency ${name} points outside the installed dependency tree`);
      }
      if (resolved !== candidate) throw new Error(`Linked dependency ${name} must be installed as a regular package before bundling`);
      return candidate;
    }
    if (directory === root) break;
  }
  return undefined;
}

/** The installed production graph, preserving nested versions and required peers. */
export async function collectProductionPackages(root) {
  root = await realpath(root);
  const seen = new Set();
  async function visit(directory, manifest) {
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    for (const [name, metadata] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
      if (metadata.optional) optional.add(name);
    }
    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const name of names) {
      const dependency = await dependencyDirectory(root, directory, name);
      if (!dependency) {
        if (optional.has(name)) continue;
        throw new Error(`Missing production dependency ${name}; run npm ci before building the plugin`);
      }
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      await visit(dependency, await json(path.join(dependency, "package.json")));
    }
  }
  await visit(root, await json(path.join(root, "package.json")));
  return [...seen].map((directory) => path.relative(root, directory)).sort();
}

async function copyPackage(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: async (file) => {
      if (file !== source && ["node_modules", ".git", ".tigercat"].includes(path.basename(file))) return false;
      const name = path.basename(file);
      if (name === ".env" || name.startsWith(".env.") || /\.sqlite(?:-(?:wal|shm|journal))?$/.test(name)) return false;
      if ((await lstat(file)).isSymbolicLink()) throw new Error(`Cannot bundle a symbolic link: ${path.relative(source, file)}`);
      return true;
    },
  });
}

/** Build a movable plugin without network calls, installs, or lifecycle scripts. */
export async function buildPlugin({ root = repositoryRoot, pluginRoot, destination } = {}) {
  root = await realpath(root);
  pluginRoot = path.resolve(pluginRoot ?? path.join(root, "plugins", "codex"));
  destination = path.resolve(destination ?? pluginRoot);
  const packageManifest = await json(path.join(root, "package.json"));
  const pluginManifest = await json(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  if (pluginManifest.version !== packageManifest.version) throw new Error("Plugin and package versions differ; update the plugin manifest before bundling");
  if (!(await exists(path.join(root, "dist", "cli.js")))) throw new Error("Missing dist/cli.js; run npm run build first");
  const dependencies = await collectProductionPackages(root);
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(destination), ".tigercat-plugin-"));
  try {
    const server = path.join(staging, "server");
    await mkdir(server);
    await cp(path.join(root, "dist"), path.join(server, "dist"), { recursive: true });
    await cp(path.join(root, "examples"), path.join(server, "examples"), { recursive: true });
    await writeFile(path.join(server, "package.json"), JSON.stringify({
      name: "tigercat-plugin-server", version: packageManifest.version, private: true, type: "module", engines: packageManifest.engines,
    }, null, 2) + "\n");
    await writeFile(path.join(server, "cli.js"), [
      '#!/usr/bin/env node',
      'import { main } from "./dist/cli.js";',
      'import { redactText } from "./dist/redact.js";',
      'main(process.argv.slice(2)).then(',
      '  (code) => { if (typeof code === "number") process.exitCode = code; },',
      '  (error) => { console.error(redactText(error instanceof Error ? error.message : String(error))); process.exitCode = 1; },',
      ');',
      '',
    ].join("\n"));
    for (const dependency of dependencies) {
      await copyPackage(path.join(root, dependency), path.join(server, dependency));
    }
    // A distinct destination is a complete package, not just its server directory.
    if (destination !== pluginRoot) {
      for (const entry of [".codex-plugin", ".mcp.json", "skills", "README.md"]) {
        await cp(path.join(pluginRoot, entry), path.join(staging, entry), { recursive: true });
      }
      await cp(path.join(root, "LICENSE"), path.join(staging, "LICENSE"));
      if (await exists(destination)) throw new Error("Plugin destination already exists; choose a new directory");
      await rename(staging, destination);
    } else {
      await cp(path.join(root, "LICENSE"), path.join(server, "LICENSE"));
      await rm(path.join(destination, "server"), { recursive: true, force: true });
      await rename(server, path.join(destination, "server"));
    }
    return { destination, dependencyCount: dependencies.length };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildPlugin().then(
    ({ destination, dependencyCount }) => console.log(`Built ${destination} with ${dependencyCount} production packages.`),
    (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
