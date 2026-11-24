import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHarness } from "../harness/engine.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("read() workspace metadata", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("returns parsed changed files, the checked-out branch, event links, and related.cwd", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "tigercat-read-meta-"));
    roots.push(root);
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "tigercat-test@example.com"]);
    git(root, ["config", "user.name", "tigercat-test"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    writeFileSync(path.join(root, "keep.txt"), "keep\n");
    writeFileSync(path.join(root, "old-name.txt"), "old\n");
    git(root, ["add", "keep.txt", "old-name.txt"]);
    git(root, ["commit", "-m", "init"]);

    const harness = await startHarness({ root, durationMs: 60_000 });
    try {
      const spawned = await harness.engine.spawn({
        runtime: "worker",
        task: "edit the workspace",
        cwd: root,
      });
      await harness.engine.settle();
      const session = await harness.store.getSession(spawned.workerId);
      if (!session?.cwd || !session.baseCwd) throw new Error("worker workspace was not recorded");
      const worktree = session.cwd;

      writeFileSync(path.join(worktree, "committed.txt"), "committed\n");
      git(worktree, ["add", "committed.txt"]);
      git(worktree, ["commit", "-m", "worker change"]);
      writeFileSync(path.join(root, "base-only.txt"), "base\n");
      git(root, ["add", "base-only.txt"]);
      git(root, ["commit", "-m", "base moves"]);

      git(worktree, ["mv", "old-name.txt", "new name.txt"]);
      writeFileSync(path.join(worktree, "my file.txt"), "space\n");
      // One code point, so macOS normalization does not change the path git reports.
      writeFileSync(path.join(worktree, "π.txt"), "unicode\n");
      const quotedName = "say \"hi\".txt";
      if (process.platform !== "win32") writeFileSync(path.join(worktree, quotedName), "quote\n");
      git(worktree, ["checkout", "-b", "worker-feature"]);

      await harness.engine.observePath(spawned.workerId, "from-agent.txt");
      await harness.store.appendEvent({
        workerId: spawned.workerId,
        type: "worker.update",
        createdAt: harness.clock.now(),
        payload: {
          url: "https://example.com/change",
          link: "https://example.com/link",
          prUrl: "https://example.com/pr/1",
          pullRequestUrl: "https://example.com/pull/1",
          links: ["https://example.com/from-links", "", 12],
          ignored: "https://example.com/not-a-link-field",
        },
      });

      const summary = await harness.engine.read(spawned.workerId) as {
        changedFiles: string[];
        branch: string | null;
        links: string[];
        related: { cwd?: string; baseCwd: string | null };
      };
      const expected = [
        "from-agent.txt",
        "committed.txt",
        "new name.txt",
        "my file.txt",
        "π.txt",
      ];
      if (process.platform !== "win32") expected.push(quotedName);

      expect(new Set(summary.changedFiles)).toEqual(new Set(expected));
      expect(summary.changedFiles.some((filePath) => filePath.includes("->") || filePath.startsWith("\""))).toBe(false);
      expect(summary.branch).toBe("worker-feature");
      expect(summary.links).toEqual([
        "https://example.com/change",
        "https://example.com/link",
        "https://example.com/pr/1",
        "https://example.com/pull/1",
        "https://example.com/from-links",
      ]);
      expect(summary.related.cwd).toBe(worktree);
      expect(summary.related).not.toHaveProperty("worktree");
      expect(summary.related.baseCwd).toBe(session.baseCwd);
    } finally {
      await harness.engine.close();
      await harness.store.close();
    }
  });
});
