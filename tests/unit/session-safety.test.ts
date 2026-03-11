import { describe, expect, test } from "bun:test";
import * as configModule from "../../src/cli/config.js";
import { sessionDirMap, tmuxNewSession } from "../../src/server/tmux.js";

describe("tmuxNewSession map update safety", () => {
  test("does not cache session dir when tmux session creation fails", async () => {
    // Use an invalid session name to force tmux rejection deterministically
    // across environments (rather than relying on PATH behavior).
    const sessionName = "";
    sessionDirMap.delete(sessionName);

    await expect(
      tmuxNewSession(sessionName, "/tmp", "shell", () => ({ agentCmd: "claude" })),
    ).rejects.toThrow();

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
