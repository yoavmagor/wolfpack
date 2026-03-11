import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRalphLog } from "../../src/server/ralph.ts";

let tmpProjectDir: string;

function writePlan(content = "- [ ] task\n"): void {
  writeFileSync(join(tmpProjectDir, "PLAN.md"), content);
}

function writeLog(content: string): void {
  writeFileSync(join(tmpProjectDir, ".ralph.log"), content);
}

function buildHeader(pid: number): string {
  return [
    "🥋 ralph — 5 iterations",
    "agent: claude",
    "plan: PLAN.md",
    "progress: progress.txt",
    "phase_cleanup: on",
    "phase_audit_fix: off",
    `pid: ${pid}`,
    "started: Mon Jan 01 2024 12:00:00",
    "",
  ].join("\n");
}

describe("parseRalphLog phase status and config", () => {
  beforeEach(() => {
    tmpProjectDir = mkdtempSync(join(tmpdir(), "ralph-phase-status-"));
    writePlan();
  });

  afterEach(() => {
    rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  test("parses phase config flags from log header", () => {
    const deadPid = 999999;
    writeLog(
      [
        "🥋 ralph — 5 iterations",
        "agent: claude",
        "plan: PLAN.md",
        "progress: progress.txt",
        "phase_cleanup: off",
        "phase_audit_fix: on",
        `pid: ${deadPid}`,
        "started: Mon Jan 01 2024 12:00:00",
        "finished: Mon Jan 01 2024 12:10:00",
        "",
      ].join("\n"),
    );

    const status = parseRalphLog(tmpProjectDir);
    expect(status).not.toBeNull();
    expect(status?.cleanupEnabled).toBe(false);
    expect(status?.auditFixEnabled).toBe(true);
  });

  test("audit=true while Wax Inspect is running", () => {
    writeLog(
      buildHeader(process.pid)
      + "\n=== 🥋 Wax Inspect — starting audit+fix — now ===\n"
      + "checking files...\n",
    );

    const status = parseRalphLog(tmpProjectDir);
    expect(status).not.toBeNull();
    expect(status?.active).toBe(true);
    expect(status?.audit).toBe(true);
    expect(status?.cleanup).toBe(false);
  });

  test("audit=false once Wax Inspect completes", () => {
    writeLog(
      buildHeader(process.pid)
      + "\n=== 🥋 Wax Inspect — starting audit+fix — now ===\n"
      + "checking files...\n"
      + "=== ✅ Wax Inspect complete — now ===\n",
    );

    const status = parseRalphLog(tmpProjectDir);
    expect(status).not.toBeNull();
    expect(status?.active).toBe(true);
    expect(status?.audit).toBe(false);
  });
});
