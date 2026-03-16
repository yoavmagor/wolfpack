import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  slugifyTaskName,
  createWorktree,
  removeWorktree,
  listWorktrees,
  cleanupAllExceptFinal,
} from "../../src/worktree.js";

// ── slugifyTaskName tests ──

describe("slugifyTaskName", () => {
  test("extracts title from numbered header", () => {
    expect(slugifyTaskName("## 1. Add auth middleware")).toBe(
      "add-auth-middleware",
    );
  });

  test("handles multi-digit task numbers", () => {
    expect(slugifyTaskName("## 12. Deploy to production")).toBe(
      "deploy-to-production",
    );
  });

  test("lowercases and kebab-cases", () => {
    expect(slugifyTaskName("## 3. Write Unit Tests")).toBe("write-unit-tests");
  });

  test("strips special characters", () => {
    expect(slugifyTaskName("## 1. Add API (v2) & docs!")).toBe(
      "add-api-v2-docs",
    );
  });

  test("truncates to 40 chars", () => {
    const long =
      "## 1. This is a very long task name that should definitely be truncated at forty characters";
    const result = slugifyTaskName(long);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toBe(
      "this-is-a-very-long-task-name-that-shoul",
    );
  });

  test("strips trailing hyphens after truncation", () => {
    // 40-char truncation might land mid-word leaving a trailing hyphen
    const header = "## 1. aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbb";
    const result = slugifyTaskName(header);
    expect(result).not.toMatch(/-$/);
  });

  test("handles plain string without header prefix", () => {
    expect(slugifyTaskName("Some task title")).toBe("some-task-title");
  });

  test("handles extra whitespace", () => {
    expect(slugifyTaskName("##  5.   Trim   spaces  ")).toBe("trim-spaces");
  });
});

// ── worktree lifecycle tests (require a real git repo) ──

describe("worktree lifecycle", () => {
  let repoDir: string;

  beforeAll(() => {
    // Create a temp git repo with an initial commit
    repoDir = realpathSync(mkdtempSync(join(tmpdir(), "wt-test-")));
    execFileSync("git", ["init", repoDir], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "init"], {
      stdio: "pipe",
    });
  });

  afterAll(() => {
    // Clean up all worktrees first, then remove temp dir
    try {
      const wts = listWorktrees(repoDir);
      for (const wt of wts) {
        if (wt.path !== repoDir) {
          try { removeWorktree(wt.path, repoDir); } catch { /* already removed */ }
        }
      }
    } catch { /* best effort */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("createWorktree creates a worktree and returns path", () => {
    const wtPath = createWorktree(repoDir, "ralph/1-test-task", "HEAD");
    expect(wtPath).toContain(".wolfpack/worktrees/1-test-task");

    const wts = listWorktrees(repoDir);
    const found = wts.find((w) => w.branch === "ralph/1-test-task");
    expect(found).toBeDefined();

    // Cleanup
    removeWorktree(wtPath, repoDir);
  });

  test("listWorktrees returns main worktree", () => {
    const wts = listWorktrees(repoDir);
    expect(wts.length).toBeGreaterThanOrEqual(1);
    expect(wts[0].path).toBe(repoDir);
  });

  test("removeWorktree removes a worktree", () => {
    const wtPath = createWorktree(repoDir, "ralph/2-remove-me", "HEAD");
    removeWorktree(wtPath, repoDir);

    const wts = listWorktrees(repoDir);
    const found = wts.find((w) => w.branch === "ralph/2-remove-me");
    expect(found).toBeUndefined();
  });

  test("cleanupAllExceptFinal keeps only the last worktree", () => {
    createWorktree(repoDir, "ralph/3-first", "HEAD");
    createWorktree(repoDir, "ralph/4-second", "HEAD");
    createWorktree(repoDir, "ralph/5-third", "HEAD");

    const result = cleanupAllExceptFinal(repoDir);

    expect(result.removed).toContain("ralph/3-first");
    expect(result.removed).toContain("ralph/4-second");
    expect(result.kept).toBe("ralph/5-third");

    // Only main + final worktree should remain
    const wts = listWorktrees(repoDir);
    const managedWts = wts.filter((w) => w.path !== repoDir);
    expect(managedWts.length).toBe(1);
    expect(managedWts[0].branch).toBe("ralph/5-third");

    // Cleanup
    removeWorktree(managedWts[0].path, repoDir);
  });

  test("cleanupAllExceptFinal with no managed worktrees returns empty", () => {
    const result = cleanupAllExceptFinal(repoDir);
    expect(result.removed).toEqual([]);
    expect(result.kept).toBe("");
  });
});
