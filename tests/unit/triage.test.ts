import { describe, expect, test } from "bun:test";
import { classifySession, TRIAGE_ORDER, type TriageStatus } from "../../src/triage.ts";

describe("classifySession", () => {
  // ── needs-input ──

  test("detects y/n prompt", () => {
    expect(classifySession("Overwrite file? (y/n)", 999)).toBe("needs-input");
  });

  test("detects [Y/n] prompt", () => {
    expect(classifySession("Install? [Y/n]", 999)).toBe("needs-input");
  });

  test("detects [yes/no] prompt", () => {
    expect(classifySession("Are you sure? [yes/no]", 999)).toBe("needs-input");
  });

  test("detects Do you want to", () => {
    expect(classifySession("Do you want to continue?", 999)).toBe("needs-input");
  });

  test("detects Press Enter", () => {
    expect(classifySession("Press Enter to continue", 999)).toBe("needs-input");
  });

  test("detects permission request", () => {
    expect(classifySession("Need permission to write /etc/hosts", 999)).toBe("needs-input");
  });

  test("detects approve prompt", () => {
    expect(classifySession("Approve this deployment?", 999)).toBe("needs-input");
    expect(classifySession("Please approve the changes", 999)).toBe("needs-input");
  });

  test("detects waiting for", () => {
    expect(classifySession("waiting for input", 999)).toBe("needs-input");
  });

  test("detects (yes/no) prompt", () => {
    expect(classifySession("Remove entry (yes/no)", 999)).toBe("needs-input");
  });

  test("detects trailing ? with bracket choices", () => {
    expect(classifySession("Continue? [y/N]", 999)).toBe("needs-input");
  });

  test("detects auth prompts", () => {
    expect(classifySession("Enter your password:", 999)).toBe("needs-input");
    expect(classifySession("Enter a passphrase for key:", 999)).toBe("needs-input");
    expect(classifySession("type your token:", 999)).toBe("needs-input");
    expect(classifySession("Enter username:", 999)).toBe("needs-input");
  });

  test("detects 'are you sure' prompts", () => {
    expect(classifySession("Are you sure you want to delete?", 999)).toBe("needs-input");
    expect(classifySession("are you sure (y/n)?", 999)).toBe("needs-input");
  });

  test("detects bracketed [y] default", () => {
    expect(classifySession("Proceed? [y]", 999)).toBe("needs-input");
  });

  // ── error ──

  test("detects Error: prefix", () => {
    expect(classifySession("Error: module not found", 999)).toBe("error");
  });

  test("detects error[ prefix", () => {
    expect(classifySession("error[E0001]: type mismatch", 999)).toBe("error");
  });

  test("detects build/test/compile failed", () => {
    expect(classifySession("build failed with 3 errors", 999)).toBe("error");
    expect(classifySession("test failed — 2 assertions", 999)).toBe("error");
    expect(classifySession("compile failed", 999)).toBe("error");
  });

  test("detects ❌ emoji", () => {
    expect(classifySession("❌ Tests failed", 999)).toBe("error");
  });

  test("detects panic:", () => {
    expect(classifySession("panic: runtime error", 999)).toBe("error");
  });

  test("detects FATAL", () => {
    expect(classifySession("FATAL exception in main", 999)).toBe("error");
  });

  test("detects unhandled exception/rejection", () => {
    expect(classifySession("unhandled rejection at Promise", 999)).toBe("error");
    expect(classifySession("unhandled exception in worker", 999)).toBe("error");
  });

  test("detects segfault", () => {
    expect(classifySession("segfault at 0x0", 999)).toBe("error");
  });

  // ── running ──

  test("running when activity age <= 45s", () => {
    expect(classifySession("$ compiling...", 10)).toBe("running");
  });

  test("running at exactly 45s", () => {
    expect(classifySession("normal output", 45)).toBe("running");
  });

  // ── idle ──

  test("idle when activity age > 45s", () => {
    expect(classifySession("$ ", 46)).toBe("idle");
  });

  test("idle with old activity", () => {
    expect(classifySession("normal output", 300)).toBe("idle");
  });

  // ── priority: input > error > running > idle ──

  test("input takes priority over error patterns", () => {
    // "build failed" is error pattern, but "Do you want to continue" is input
    expect(classifySession("Build failed. Do you want to continue?", 5)).toBe("needs-input");
  });

  test("error takes priority over running (even if recent activity)", () => {
    expect(classifySession("Error: compilation failed", 5)).toBe("error");
  });

  // ── edge cases ──

  test("empty string with old activity = idle", () => {
    expect(classifySession("", 999)).toBe("idle");
  });

  test("empty string with recent activity = running", () => {
    expect(classifySession("", 5)).toBe("running");
  });
});

describe("multi-line triage (per-line classification)", () => {
  // Simulates the routes.ts logic: classify each line independently, pick highest priority
  function classifyMultiLine(last2: string[], activityAge: number): TriageStatus {
    return last2.reduce<TriageStatus>((best, line) => {
      const t = classifySession(line, activityAge);
      return TRIAGE_ORDER[t] < TRIAGE_ORDER[best] ? t : best;
    }, classifySession("", activityAge));
  }

  test("prompt split across two lines still detects needs-input", () => {
    // "Do you want to continue?" split by newline
    expect(classifyMultiLine(["Do you want", "to continue? (y/n)"], 999)).toBe("needs-input");
  });

  test("second line has input pattern", () => {
    expect(classifyMultiLine(["some output", "Press Enter to continue"], 999)).toBe("needs-input");
  });

  test("first line has error, second is normal", () => {
    expect(classifyMultiLine(["Error: build failed", "$ "], 999)).toBe("error");
  });

  test("both lines normal, old activity = idle", () => {
    expect(classifyMultiLine(["normal output", "$ "], 999)).toBe("idle");
  });

  test("both lines normal, recent activity = running", () => {
    expect(classifyMultiLine(["normal output", "$ "], 5)).toBe("running");
  });
});
