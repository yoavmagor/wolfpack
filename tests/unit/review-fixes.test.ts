import { describe, expect, test } from "bun:test";
import * as configModule from "../../src/cli/config.js";
import { sessionDirMap, tmuxNewSession } from "../../src/server/tmux.js";

describe("tmuxNewSession map update safety", () => {
  test("does not cache session dir when tmux session creation fails", async () => {
    const sessionName = `review-fix-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const originalPath = process.env.PATH;
    sessionDirMap.delete(sessionName);
    process.env.PATH = "";
    try {
      await expect(
        tmuxNewSession(sessionName, "/tmp", "shell", () => ({ agentCmd: "claude" })),
      ).rejects.toThrow();
    } finally {
      process.env.PATH = originalPath;
    }

    expect(sessionDirMap.has(sessionName)).toBe(false);
  });
});

describe("process command resolution for killPortHolder", () => {
  const resolveProcessCommandForValidation = (configModule as any)
    .resolveProcessCommandForValidation as
    | ((comm: string, args: string) => string)
    | undefined;

  test("falls back to args when comm is a generic wrapper binary", () => {
    expect(resolveProcessCommandForValidation).toBeDefined();
    expect(
      resolveProcessCommandForValidation?.(
        "bun",
        "bun /Users/home/Dev/wolfpack/cli.ts",
      ),
    ).toContain("wolfpack");
  });

  test("keeps comm when comm already identifies wolfpack", () => {
    expect(resolveProcessCommandForValidation).toBeDefined();
    expect(
      resolveProcessCommandForValidation?.(
        "/Users/home/.wolfpack/bin/wolfpack",
        "bun /Users/home/Dev/wolfpack/cli.ts",
      ),
    ).toBe("/Users/home/.wolfpack/bin/wolfpack");
  });
});
