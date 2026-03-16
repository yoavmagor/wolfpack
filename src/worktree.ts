/**
 * Worktree lifecycle utilities for ralph task isolation.
 *
 * Each task (or plan) gets its own git worktree under .wolfpack/worktrees/,
 * allowing concurrent agents to work without file conflicts.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { realpathSync } from "node:fs";

const WORKTREE_DIR = ".wolfpack/worktrees";

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
}

/**
 * Extract task title from a `## N. Title` header, lowercase, kebab-case,
 * truncated to 40 chars.
 */
export function slugifyTaskName(header: string): string {
  const match = header.match(/^##\s*\d+\.\s*(.+)/);
  const title = match ? match[1].trim() : header.trim();
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/**
 * Create a git worktree at .wolfpack/worktrees/<slug> on a new branch.
 * Returns the absolute worktree path.
 */
export function createWorktree(
  projectDir: string,
  branchName: string,
  baseBranch: string,
): string {
  const slug = branchName.replace(/^ralph\//, "").replace(/[^a-z0-9-]/g, "-");
  const realProjectDir = realpathSync(projectDir);
  const worktreePath = join(realProjectDir, WORKTREE_DIR, slug);
  execFileSync(
    "git",
    ["worktree", "add", worktreePath, "-b", branchName, baseBranch],
    { cwd: realProjectDir, stdio: "pipe" },
  );
  return worktreePath;
}

/**
 * Remove a git worktree by path.
 */
export function removeWorktree(worktreePath: string, projectDir?: string): void {
  const opts = projectDir
    ? { cwd: realpathSync(projectDir), stdio: "pipe" as const }
    : { stdio: "pipe" as const };
  execFileSync("git", ["worktree", "remove", worktreePath, "--force"], opts);
}

/**
 * List all git worktrees for the repo at projectDir.
 */
export function listWorktrees(projectDir: string): WorktreeInfo[] {
  const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: realpathSync(projectDir),
    encoding: "utf-8",
  });

  const entries: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "") {
      if (current.path) {
        entries.push({
          path: current.path,
          branch: current.branch ?? "",
          head: current.head ?? "",
          bare: current.bare ?? false,
        });
      }
      current = {};
    }
  }

  return entries;
}

/**
 * Remove all worktrees under .wolfpack/worktrees/ except the last one
 * (by alphabetical order of directory name, which matches creation order
 * when branch names are prefixed with task number).
 */
export function cleanupAllExceptFinal(
  projectDir: string,
): { removed: string[]; kept: string } {
  const realProjectDir = realpathSync(projectDir);
  const worktrees = listWorktrees(realProjectDir);
  const wtDir = join(realProjectDir, WORKTREE_DIR);

  const managed = worktrees.filter((w) => w.path.startsWith(wtDir));

  if (managed.length === 0) {
    return { removed: [], kept: "" };
  }

  // Sort by path — task numbering ensures chronological order
  managed.sort((a, b) => a.path.localeCompare(b.path));

  const final = managed[managed.length - 1];
  const toRemove = managed.slice(0, -1);

  const removed: string[] = [];
  for (const wt of toRemove) {
    removeWorktree(wt.path, realProjectDir);
    removed.push(wt.branch);
  }

  // Prune stale worktree refs
  execFileSync("git", ["worktree", "prune"], {
    cwd: realProjectDir,
    stdio: "pipe",
  });

  return { removed, kept: final.branch };
}
