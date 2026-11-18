import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Workspace {
  cwd: string;
  worktree: boolean;
  baseCwd: string;
}

export async function prepareWorkspace(baseCwd: string, workerId: string): Promise<Workspace> {
  if (await isGitRepo(baseCwd)) {
    const cwd = path.join(baseCwd, ".tigercat", "worktrees", workerId);
    await mkdir(path.dirname(cwd), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "--detach", cwd], { cwd: baseCwd });
    return { cwd, worktree: true, baseCwd };
  }
  const cwd = path.join(baseCwd, ".tigercat", "workers", workerId);
  await mkdir(cwd, { recursive: true });
  return { cwd, worktree: false, baseCwd };
}

export async function removeWorkspace(workspace: Workspace): Promise<void> {
  if (workspace.worktree) {
    await execFileAsync("git", ["worktree", "remove", "--force", workspace.cwd], {
      cwd: workspace.baseCwd,
    }).catch(() => undefined);
    return;
  }
  await rm(workspace.cwd, { recursive: true, force: true });
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}
