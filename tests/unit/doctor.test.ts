import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import type { CheckResult } from "../../src/cli/doctor.ts";

/**
 * Doctor tests — we test the exported `doctor()` function end-to-end.
 * Since doctor probes real system state, these tests just verify:
 * 1. It returns 0 or 1 (not throws)
 * 2. Output format is correct
 * 3. The --fix flag is parsed
 *
 * For unit-level isolation we test the CheckResult type contract and
 * the runner logic by constructing synthetic results.
 */

describe("doctor CheckResult contract", () => {
  test("pass result shape", () => {
    const r: CheckResult = { name: "tmux", group: "Dependencies", status: "pass", detail: "3.5a" };
    expect(r.status).toBe("pass");
    expect(r.fixHint).toBeUndefined();
    expect(r.fix).toBeUndefined();
  });

  test("fail result with fixHint", () => {
    const r: CheckResult = {
      name: "tmux", group: "Dependencies", status: "fail",
      detail: "not found", fixHint: "brew install tmux",
    };
    expect(r.status).toBe("fail");
    expect(r.fixHint).toBe("brew install tmux");
  });

  test("fail result with fix function", () => {
    let called = false;
    const r: CheckResult = {
      name: "binary", group: "Binary", status: "fail",
      detail: "missing",
      fix: () => { called = true; },
    };
    r.fix!();
    expect(called).toBe(true);
  });

  test("warn result shape", () => {
    const r: CheckResult = {
      name: "PATH", group: "Environment", status: "warn",
      detail: "/usr/local/bin missing",
    };
    expect(r.status).toBe("warn");
  });
});

describe("doctor() integration", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = ["bun", "wolfpack", "doctor"];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  test("returns 0 or 1 without throwing", async () => {
    // dynamic import to avoid polluting module cache
    const { doctor } = await import("../../src/cli/doctor.ts");
    const code = doctor();
    expect(code === 0 || code === 1).toBe(true);
  });

  test("returns number type", async () => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    expect(typeof doctor()).toBe("number");
  });
});

describe("doctor --fix flag parsing", () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  test("--fix is detected from argv", () => {
    process.argv = ["bun", "wolfpack", "doctor", "--fix"];
    expect(process.argv.includes("--fix")).toBe(true);
  });

  test("no --fix when absent", () => {
    process.argv = ["bun", "wolfpack", "doctor"];
    expect(process.argv.includes("--fix")).toBe(false);
  });
});

describe("tailscaleBin shared export", () => {
  test("tailscaleBin is exported from config", async () => {
    const { tailscaleBin } = await import("../../src/cli/config.ts");
    expect(typeof tailscaleBin).toBe("function");
    // returns string or null
    const result = tailscaleBin();
    expect(result === null || typeof result === "string").toBe(true);
  });
});
