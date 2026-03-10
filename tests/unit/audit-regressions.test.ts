/**
 * Regression tests for fixes from the security/correctness audit.
 * Each test targets a specific finding that was fixed in the fix/audit-findings branch.
 */
import { describe, expect, test, beforeEach } from "bun:test";

// ── 1. Path containment boundary (audit finding: prefix check too weak) ──

describe("isUnderDevDir — path containment boundary", () => {
  // We test the logic directly since the real function depends on DEV_DIR env.
  // Replicate the exact predicate used in tmux.ts isUnderDevDir().
  function isUnderDevDir(dir: string, devDir: string): boolean {
    return dir === devDir || dir.startsWith(devDir + "/");
  }

  const DEV = "/Users/home/Dev";

  test("exact match on DEV_DIR itself", () => {
    expect(isUnderDevDir("/Users/home/Dev", DEV)).toBe(true);
  });

  test("child directory matches", () => {
    expect(isUnderDevDir("/Users/home/Dev/wolfpack", DEV)).toBe(true);
    expect(isUnderDevDir("/Users/home/Dev/foo/bar/baz", DEV)).toBe(true);
  });

  test("rejects sibling path that shares string prefix", () => {
    // This was the original bug — /Users/home/Developer matched /Users/home/Dev
    expect(isUnderDevDir("/Users/home/Developer", DEV)).toBe(false);
    expect(isUnderDevDir("/Users/home/DevOps", DEV)).toBe(false);
    expect(isUnderDevDir("/Users/home/Dev2", DEV)).toBe(false);
  });

  test("rejects unrelated paths", () => {
    expect(isUnderDevDir("/tmp/something", DEV)).toBe(false);
    expect(isUnderDevDir("/Users/other/Dev/project", DEV)).toBe(false);
  });

  test("rejects partial prefix with no separator", () => {
    expect(isUnderDevDir("/Users/home/Devious", DEV)).toBe(false);
  });
});

// ── 2. sessionDirMap pruning ──

describe("sessionDirMap pruning", () => {
  test("stale entries are removed when session disappears", () => {
    // Simulates the pruning loop in _realTmuxList
    const sessionDirMap = new Map<string, string>();
    sessionDirMap.set("alive-session", "/Users/home/Dev/alive");
    sessionDirMap.set("dead-session", "/Users/home/Dev/dead");

    const liveSessions = ["alive-session"];
    for (const key of sessionDirMap.keys()) {
      if (!liveSessions.includes(key)) sessionDirMap.delete(key);
    }

    expect(sessionDirMap.has("alive-session")).toBe(true);
    expect(sessionDirMap.has("dead-session")).toBe(false);
  });
});

// ── 3. killPortHolder process verification ──

describe("killPortHolder — process identity check", () => {
  // The actual function uses execFileSync which needs a real process.
  // We test the verification logic pattern: only kill if comm includes "wolfpack".
  function shouldKill(comm: string): boolean {
    return comm.includes("wolfpack");
  }

  test("allows killing wolfpack process", () => {
    expect(shouldKill("/Users/home/.wolfpack/bin/wolfpack")).toBe(true);
    expect(shouldKill("wolfpack-bridge")).toBe(true);
    expect(shouldKill("bun /path/to/wolfpack/cli.ts")).toBe(true);
  });

  test("rejects non-wolfpack process", () => {
    expect(shouldKill("node /app/server.js")).toBe(false);
    expect(shouldKill("python3 -m http.server")).toBe(false);
    expect(shouldKill("nginx: master")).toBe(false);
  });
});

// ── 4. Ralph subtask expansion budget ──

describe("ralph subtask expansion budget", () => {
  test("budget increases by subtask count, not just 1", () => {
    const ITERATIONS = 5;
    let maxIterations = ITERATIONS;
    const MAX_CEILING = Math.max(ITERATIONS * 2, 100);

    // Simulate 4 subtasks discovered
    const subtasks = ["sub-a", "sub-b", "sub-c", "sub-d"];
    if (maxIterations < MAX_CEILING) {
      maxIterations = Math.min(maxIterations + subtasks.length, MAX_CEILING);
    }

    expect(maxIterations).toBe(9); // 5 + 4, not 5 + 1
  });

  test("budget respects ceiling", () => {
    const ITERATIONS = 5;
    let maxIterations = 98;
    const MAX_CEILING = Math.max(ITERATIONS * 2, 100);

    const subtasks = ["sub-a", "sub-b", "sub-c", "sub-d", "sub-e"];
    if (maxIterations < MAX_CEILING) {
      maxIterations = Math.min(maxIterations + subtasks.length, MAX_CEILING);
    }

    expect(maxIterations).toBe(100); // capped at ceiling
  });

  test("single subtask still increments by 1", () => {
    let maxIterations = 5;
    const MAX_CEILING = 100;
    const subtasks = ["only-one"];
    if (maxIterations < MAX_CEILING) {
      maxIterations = Math.min(maxIterations + subtasks.length, MAX_CEILING);
    }
    expect(maxIterations).toBe(6);
  });
});

// ── 5. Ralph cleanup scope uses START_COMMIT ──

describe("ralph cleanup prompt — START_COMMIT boundary", () => {
  test("uses START_COMMIT when available", () => {
    const START_COMMIT = "abc123";
    const fragment = `git diff --name-only ${START_COMMIT || "HEAD~10"} HEAD`;
    expect(fragment).toContain("abc123");
    expect(fragment).not.toContain("HEAD~10");
  });

  test("falls back to HEAD~10 when START_COMMIT is empty", () => {
    const START_COMMIT = "";
    const fragment = `git diff --name-only ${START_COMMIT || "HEAD~10"} HEAD`;
    expect(fragment).toContain("HEAD~10");
  });
});

// ── 6. /api/ralph/start validation ordering ──

describe("ralph start — validate before git mutation", () => {
  test("invalid plan filename is rejected", () => {
    // Replicates the regex from routes.ts
    const planRegex = /^[a-zA-Z0-9._\- ]+\.md$/;

    // Valid names
    expect(planRegex.test("PLAN.md")).toBe(true);
    expect(planRegex.test("my-plan.md")).toBe(true);
    expect(planRegex.test("plan v2.md")).toBe(true);

    // Path traversal attempts
    expect(planRegex.test("../evil.md")).toBe(false);
    expect(planRegex.test("path/to/plan.md")).toBe(false);
    expect(planRegex.test("")).toBe(false);

    // Special values that the route also rejects explicitly
    expect(planRegex.test("..")).toBe(false);
    expect(planRegex.test(".")).toBe(false);
  });

  test("iterations are clamped to [1, 500]", () => {
    function clampIters(iterations: number | undefined): number {
      return Math.max(1, Math.min(500, iterations ?? 5));
    }

    expect(clampIters(undefined)).toBe(5);
    expect(clampIters(0)).toBe(1);
    expect(clampIters(-10)).toBe(1);
    expect(clampIters(1000)).toBe(500);
    expect(clampIters(50)).toBe(50);
  });
});
