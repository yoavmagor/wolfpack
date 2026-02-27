import { describe, expect, test } from "bun:test";
import { isInputPrompt, isJunkLine } from "../../src/triage.ts";

describe("isInputPrompt", () => {
  test("detects y/n prompt", () => {
    expect(isInputPrompt("Overwrite file? (y/n)")).toBe(true);
  });

  test("detects [Y/n] prompt", () => {
    expect(isInputPrompt("Install? [Y/n]")).toBe(true);
  });

  test("detects [yes/no] prompt", () => {
    expect(isInputPrompt("Are you sure? [yes/no]")).toBe(true);
  });

  test("detects Do you want to", () => {
    expect(isInputPrompt("Do you want to continue?")).toBe(true);
  });

  test("detects Press Enter", () => {
    expect(isInputPrompt("Press Enter to continue")).toBe(true);
  });

  test("detects permission request", () => {
    expect(isInputPrompt("Need permission to write /etc/hosts")).toBe(true);
  });

  test("detects approve prompt", () => {
    expect(isInputPrompt("Approve this deployment?")).toBe(true);
    expect(isInputPrompt("Please approve the changes")).toBe(true);
  });

  test("detects waiting for", () => {
    expect(isInputPrompt("waiting for input")).toBe(true);
  });

  test("detects (yes/no) prompt", () => {
    expect(isInputPrompt("Remove entry (yes/no)")).toBe(true);
  });

  test("detects trailing ? with bracket choices", () => {
    expect(isInputPrompt("Continue? [y/N]")).toBe(true);
  });

  test("detects auth prompts", () => {
    expect(isInputPrompt("Enter your password:")).toBe(true);
    expect(isInputPrompt("Enter a passphrase for key:")).toBe(true);
    expect(isInputPrompt("type your token:")).toBe(true);
    expect(isInputPrompt("Enter username:")).toBe(true);
  });

  test("detects 'are you sure' prompts", () => {
    expect(isInputPrompt("Are you sure you want to delete?")).toBe(true);
    expect(isInputPrompt("are you sure (y/n)?")).toBe(true);
  });

  test("detects bracketed [y] default", () => {
    expect(isInputPrompt("Proceed? [y]")).toBe(true);
  });

  test("does not match normal output", () => {
    expect(isInputPrompt("compiling...")).toBe(false);
    expect(isInputPrompt("Running 10 tests using 5 workers")).toBe(false);
    expect(isInputPrompt("✽ Cerebrating…")).toBe(false);
    expect(isInputPrompt("")).toBe(false);
  });
});

describe("isJunkLine", () => {
  // ── box-drawing lines ──
  test("matches lines of box-drawing chars", () => {
    expect(isJunkLine("─────────────────────")).toBe(true);
    expect(isJunkLine("━━━━━━━━━━━━")).toBe(true);
    expect(isJunkLine("═══════════════")).toBe(true);
    expect(isJunkLine("╔═══════════════╗")).toBe(true);
    expect(isJunkLine("│               │")).toBe(true);
    expect(isJunkLine("┌───────────────┐")).toBe(true);
    expect(isJunkLine("╭───────────────╮")).toBe(true);
  });

  test("does not match lines with text content among box-drawing", () => {
    expect(isJunkLine("│ hello world │")).toBe(false);
    expect(isJunkLine("┌ error: something ┐")).toBe(false);
  });

  // ── Claude Code hint bar ──
  test("matches Claude Code hint bar (accept edits)", () => {
    expect(isJunkLine("  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt")).toBe(true);
  });

  test("matches esc to interrupt", () => {
    expect(isJunkLine("esc to interrupt")).toBe(true);
  });

  // ── bare prompts ──
  test("matches bare shell prompts", () => {
    expect(isJunkLine("$ ")).toBe(true);
    expect(isJunkLine("❯ ")).toBe(true);
    expect(isJunkLine("% ")).toBe(true);
    expect(isJunkLine("> ")).toBe(true);
    expect(isJunkLine("  $ ")).toBe(true);
  });

  test("does not match prompts with commands after them", () => {
    expect(isJunkLine("$ ls -la")).toBe(false);
    expect(isJunkLine("❯ npm test")).toBe(false);
  });

  // ── whitespace ──
  test("matches whitespace-only lines", () => {
    expect(isJunkLine("")).toBe(true);
    expect(isJunkLine("   ")).toBe(true);
    expect(isJunkLine("\t")).toBe(true);
    expect(isJunkLine("  \t  ")).toBe(true);
  });

  // ── real content is not junk ──
  test("does not match real content", () => {
    expect(isJunkLine("Error: module not found")).toBe(false);
    expect(isJunkLine("✽ Cerebrating…")).toBe(false);
    expect(isJunkLine("compiling...")).toBe(false);
    expect(isJunkLine("Running 10 tests using 5 workers")).toBe(false);
    expect(isJunkLine("Do you want to continue? (y/n)")).toBe(false);
  });
});
