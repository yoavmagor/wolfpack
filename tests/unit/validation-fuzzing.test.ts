/**
 * Validation fuzzing — edge cases that live outside happy-path coverage.
 *
 * Covers: null bytes, control chars, unicode, boundary lengths,
 * path traversal variants, branch injection sequences.
 */
import { describe, expect, test } from "bun:test";
import {
  isValidSessionName,
  isValidProjectName,
  isValidPlanFile,
  BRANCH_REGEX,
  shellEscape,
} from "../../src/validation.ts";

// ── shellEscape: null bytes, control chars, unicode ──

describe("shellEscape — hostile input", () => {
  test("null byte is preserved inside quotes (not truncated)", () => {
    const result = shellEscape("a\0b");
    // Shell single-quoting preserves content literally — null byte stays inside quotes
    expect(result).toBe("'a\0b'");
    // Critical: result must still start and end with single quote
    expect(result.startsWith("'")).toBe(true);
    expect(result.endsWith("'")).toBe(true);
  });

  test("control chars (BEL, ESC, BS, DEL) are preserved inside quotes", () => {
    const input = "\x07\x1b\x08\x7f";
    const result = shellEscape(input);
    expect(result).toBe(`'${input}'`);
  });

  test("carriage return is preserved inside quotes", () => {
    const result = shellEscape("line1\rline2");
    expect(result).toBe("'line1\rline2'");
  });

  test("tab characters are preserved", () => {
    expect(shellEscape("a\tb")).toBe("'a\tb'");
  });

  test("mixed control chars + single quotes", () => {
    const result = shellEscape("it's\x00evil\x1b[31m");
    // Single quotes get escaped, everything else stays literal
    expect(result).toContain("'\\''");
    expect(result.startsWith("'")).toBe(true);
    expect(result.endsWith("'")).toBe(true);
  });

  test("unicode emoji", () => {
    expect(shellEscape("🐺")).toBe("'🐺'");
  });

  test("unicode CJK characters", () => {
    expect(shellEscape("日本語")).toBe("'日本語'");
  });

  test("unicode RTL override (U+202E)", () => {
    const rtl = "\u202E";
    expect(shellEscape(`${rtl}evil`)).toBe(`'${rtl}evil'`);
  });

  test("zero-width joiner / zero-width space", () => {
    const zwj = "\u200D";
    const zws = "\u200B";
    expect(shellEscape(`a${zwj}b${zws}c`)).toBe(`'a${zwj}b${zws}c'`);
  });

  test("very long string (100KB) doesn't throw", () => {
    const long = "x".repeat(100_000);
    const result = shellEscape(long);
    expect(result.length).toBe(100_002); // 'x...x'
  });
});

// ── isValidSessionName: boundary and hostile input ──

describe("isValidSessionName — boundary + fuzzing", () => {
  test("exactly 100 chars → valid", () => {
    expect(isValidSessionName("a".repeat(100))).toBe(true);
  });

  test("exactly 101 chars → invalid", () => {
    expect(isValidSessionName("a".repeat(101))).toBe(false);
  });

  test("empty string → invalid", () => {
    expect(isValidSessionName("")).toBe(false);
  });

  test("single char → valid", () => {
    expect(isValidSessionName("x")).toBe(true);
  });

  test("null byte mid-string", () => {
    expect(isValidSessionName("foo\0bar")).toBe(false);
  });

  test("null byte at start", () => {
    expect(isValidSessionName("\0session")).toBe(false);
  });

  test("control chars (BEL, ESC, BS)", () => {
    expect(isValidSessionName("foo\x07bar")).toBe(false);
    expect(isValidSessionName("foo\x1bbar")).toBe(false);
    expect(isValidSessionName("foo\x08bar")).toBe(false);
  });

  test("ANSI escape sequence", () => {
    expect(isValidSessionName("\x1b[31mred\x1b[0m")).toBe(false);
  });

  test("unicode emoji rejected", () => {
    expect(isValidSessionName("wolf🐺pack")).toBe(false);
  });

  test("unicode CJK rejected", () => {
    expect(isValidSessionName("テスト")).toBe(false);
  });

  test("unicode RTL override rejected", () => {
    expect(isValidSessionName("\u202Eevil")).toBe(false);
  });

  test("newline injection", () => {
    expect(isValidSessionName("foo\nbar")).toBe(false);
  });

  test("carriage return injection", () => {
    expect(isValidSessionName("foo\rbar")).toBe(false);
  });

  test("tab character", () => {
    expect(isValidSessionName("foo\tbar")).toBe(false);
  });

  test("space-padded name", () => {
    expect(isValidSessionName(" session ")).toBe(false);
  });

  test("dot (tmux restriction)", () => {
    expect(isValidSessionName("foo.bar")).toBe(false);
  });

  test("colon (tmux restriction)", () => {
    expect(isValidSessionName("foo:bar")).toBe(false);
  });
});

// ── isValidPlanFile: path traversal variants ──

describe("isValidPlanFile — path traversal", () => {
  test("../../etc/passwd → rejected", () => {
    expect(isValidPlanFile("../../etc/passwd")).toBe(false);
  });

  test("../evil.md → rejected (slash)", () => {
    expect(isValidPlanFile("../evil.md")).toBe(false);
  });

  test("..%2f..%2fetc%2fpasswd → rejected (non-alnum)", () => {
    expect(isValidPlanFile("..%2f..%2fetc%2fpasswd")).toBe(false);
  });

  test("....//....//etc/passwd → rejected", () => {
    expect(isValidPlanFile("....//....//etc/passwd")).toBe(false);
  });

  test("subdir/plan.md → rejected (has slash)", () => {
    expect(isValidPlanFile("subdir/plan.md")).toBe(false);
  });

  test("plan.md\\..\\..\\windows\\system32 → rejected (backslash)", () => {
    expect(isValidPlanFile("plan.md\\..\\..\\windows\\system32")).toBe(false);
  });

  test("null byte before .md → rejected", () => {
    expect(isValidPlanFile("evil\0.md")).toBe(false);
  });

  test("null byte after .md → rejected (doesn't end with .md)", () => {
    expect(isValidPlanFile("evil.md\0")).toBe(false);
  });

  test("just .. → rejected", () => {
    expect(isValidPlanFile("..")).toBe(false);
  });

  test("just . → rejected", () => {
    expect(isValidPlanFile(".")).toBe(false);
  });

  test(".md alone → rejected (no filename before extension)", () => {
    expect(isValidPlanFile(".md")).toBe(false);
  });

  test("empty string → rejected", () => {
    expect(isValidPlanFile("")).toBe(false);
  });

  test("valid plan file still accepted", () => {
    expect(isValidPlanFile("PLAN.md")).toBe(true);
    expect(isValidPlanFile("my-plan.md")).toBe(true);
    expect(isValidPlanFile("v2.0 roadmap.md")).toBe(true);
  });

  test("plan file with control chars → rejected", () => {
    expect(isValidPlanFile("PLAN\x00.md")).toBe(false);
    expect(isValidPlanFile("PLAN\x1b.md")).toBe(false);
    expect(isValidPlanFile("PLAN\n.md")).toBe(false);
  });

  test("plan file with unicode → rejected", () => {
    expect(isValidPlanFile("PLAN🐺.md")).toBe(false);
    expect(isValidPlanFile("計画.md")).toBe(false);
  });
});

// ── BRANCH_REGEX: ../ sequences and injection ──

describe("BRANCH_REGEX — traversal and injection", () => {
  test("../main → rejected (has dots but no dot-dot traversal risk?)", () => {
    // BRANCH_REGEX allows dots and slashes — ../main matches [a-zA-Z0-9._\-/]+
    // This is a documentation test: BRANCH_REGEX alone does NOT prevent traversal.
    // The regex accepts it — the safety comes from git itself + isUnderDevDir checks.
    const result = BRANCH_REGEX.test("../main");
    expect(result).toBe(true); // regex allows dots+slashes
  });

  test("../../etc/passwd — also passes regex (dots+slashes allowed)", () => {
    expect(BRANCH_REGEX.test("../../etc/passwd")).toBe(true);
  });

  test("feature/../../main — passes regex", () => {
    expect(BRANCH_REGEX.test("feature/../../main")).toBe(true);
  });

  // These ARE rejected by the regex:
  test("branch with space → rejected", () => {
    expect(BRANCH_REGEX.test("my branch")).toBe(false);
  });

  test("branch with semicolon → rejected", () => {
    expect(BRANCH_REGEX.test("main;rm -rf /")).toBe(false);
  });

  test("branch with backtick → rejected", () => {
    expect(BRANCH_REGEX.test("`whoami`")).toBe(false);
  });

  test("branch with $() → rejected", () => {
    expect(BRANCH_REGEX.test("$(cat /etc/passwd)")).toBe(false);
  });

  test("branch with null byte → rejected", () => {
    expect(BRANCH_REGEX.test("main\0evil")).toBe(false);
  });

  test("branch with newline → rejected", () => {
    expect(BRANCH_REGEX.test("main\nevil")).toBe(false);
  });

  test("branch with unicode → rejected", () => {
    expect(BRANCH_REGEX.test("feature/🐺")).toBe(false);
  });

  test("empty string → rejected", () => {
    expect(BRANCH_REGEX.test("")).toBe(false);
  });

  test("branch with backslash → rejected", () => {
    expect(BRANCH_REGEX.test("feature\\evil")).toBe(false);
  });

  test("branch with pipe → rejected", () => {
    expect(BRANCH_REGEX.test("main|evil")).toBe(false);
  });

  test("branch with ampersand → rejected", () => {
    expect(BRANCH_REGEX.test("main&&evil")).toBe(false);
  });

  test("valid branches still accepted", () => {
    expect(BRANCH_REGEX.test("feature/login")).toBe(true);
    expect(BRANCH_REGEX.test("fix-bug-123")).toBe(true);
    expect(BRANCH_REGEX.test("release/v2.0.1")).toBe(true);
    expect(BRANCH_REGEX.test("user/feature/sub-task")).toBe(true);
  });
});

// ── isValidProjectName: edge cases ──

describe("isValidProjectName — fuzzing", () => {
  test("null byte", () => {
    expect(isValidProjectName("foo\0bar")).toBe(false);
  });

  test("control chars", () => {
    expect(isValidProjectName("foo\x07bar")).toBe(false);
    expect(isValidProjectName("foo\x1bbar")).toBe(false);
  });

  test("unicode emoji", () => {
    expect(isValidProjectName("wolf🐺pack")).toBe(false);
  });

  test("unicode CJK", () => {
    expect(isValidProjectName("プロジェクト")).toBe(false);
  });

  test("newline injection", () => {
    expect(isValidProjectName("project\nrm -rf /")).toBe(false);
  });

  test("carriage return injection", () => {
    expect(isValidProjectName("project\revil")).toBe(false);
  });

  test("space-padded", () => {
    expect(isValidProjectName(" project ")).toBe(false);
  });

  test("slash (path traversal)", () => {
    expect(isValidProjectName("../etc")).toBe(false);
    expect(isValidProjectName("foo/bar")).toBe(false);
  });

  test("backslash (Windows traversal)", () => {
    expect(isValidProjectName("foo\\bar")).toBe(false);
  });

  test("URL-encoded traversal", () => {
    expect(isValidProjectName("..%2F..%2Fetc")).toBe(false);
  });
});
