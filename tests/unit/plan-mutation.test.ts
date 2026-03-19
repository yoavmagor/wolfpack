import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, appendFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Matches plan task headers: ## 1. Title, ### 2a. Title, etc. ──
const TASK_HEADER = /^#{2,3} (?:~~)?(?:\w+ )?\d+[a-z]?[\.\):]\s+/;

// ── Progress-based completion tracking (mirrors ralph-macchio.ts) ──

function taskSectionHeader(task: string): string | null {
  const line = task.split("\n")[0];
  return TASK_HEADER.test(line) ? line : null;
}

function readCompletedTasks(progressPath: string): Set<string> {
  const completed = new Set<string>();
  try {
    const content = readFileSync(progressPath, "utf-8");
    for (const line of content.split("\n")) {
      if (line.startsWith("DONE: ")) completed.add(line.slice(6));
    }
  } catch { /* no progress file yet */ }
  return completed;
}

function markTaskCompleted(progressPath: string, task: string, checkbox: boolean): void {
  const key = checkbox ? `checkbox: ${task}` : `section: ${taskSectionHeader(task) || task.split("\n")[0]}`;
  appendFileSync(progressPath, `DONE: ${key}\n`);
}

function extractCurrentTask(planPath: string, progressPath: string): { task: string; checkbox: boolean } | null {
  try {
    const plan = readFileSync(planPath, "utf-8");
    const completed = readCompletedTasks(progressPath);

    // try checkboxes first
    for (const line of plan.split("\n")) {
      const cbMatch = line.match(/^- \[ \] (.+)$/);
      if (cbMatch && !completed.has(`checkbox: ${cbMatch[1]}`)) {
        return { task: cbMatch[1], checkbox: true };
      }
    }

    // then section headers
    const lines = plan.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (TASK_HEADER.test(line) && !line.includes("~~")) {
        if (completed.has(`section: ${line}`)) continue;
        const level = line.match(/^(#{2,3})/)?.[1] || "##";
        const sectionLines = [line];
        for (let j = i + 1; j < lines.length; j++) {
          const nextMatch = lines[j].match(/^(#{1,3}) /);
          if (nextMatch && nextMatch[1].length <= level.length) break;
          sectionLines.push(lines[j]);
        }
        const children = sectionLines.filter(l => /^- \[ \] /.test(l));
        const allChildrenDone = children.length > 0 && children.every(l => {
          const text = l.match(/^- \[ \] (.+)$/)?.[1];
          return text && completed.has(`checkbox: ${text}`);
        });
        if (allChildrenDone) continue;
        return { task: sectionLines.join("\n").trim(), checkbox: false };
      }
    }
    return null;
  } catch { return null; }
}

// ── appendSubtasksToPlan (unchanged from ralph-macchio.ts) ──

function appendSubtasksToPlan(planPath: string, subtasks: string[]): void {
  const safe = subtasks.map(t => t.replace(/^#+\s*/, "").replace(/~~/g, "").trim()).filter(Boolean);
  const lines = safe.map(t => `- [ ] ${t}`).join("\n");
  appendFileSync(planPath, "\n" + lines + "\n");
}

// ── dedupCheckboxes (unchanged from ralph-macchio.ts) ──

function dedupCheckboxes(planPath: string): void {
  try {
    const plan = readFileSync(planPath, "utf-8");
    const lines = plan.split("\n");
    const seen = new Set<string>();
    const checkedTexts = new Set<string>();

    for (const line of lines) {
      const m = line.match(/^- \[x\] (.+)$/);
      if (m) checkedTexts.add(m[1]);
    }

    const out: string[] = [];
    for (const line of lines) {
      const m = line.match(/^- \[ \] (.+)$/);
      if (m) {
        const text = m[1];
        if (checkedTexts.has(text) || seen.has(text)) continue;
        seen.add(text);
      }
      out.push(line);
    }

    if (out.length !== lines.length) {
      writeFileSync(planPath, out.join("\n"));
    }
  } catch {}
}

// ── Test helpers ──

let tmpDir: string;
let planPath: string;
let progressPath: string;

function writePlan(content: string): void {
  writeFileSync(planPath, content);
}

function readPlan(): string {
  return readFileSync(planPath, "utf-8");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "plan-mutation-"));
  planPath = join(tmpDir, "PLAN.md");
  progressPath = join(tmpDir, "progress.txt");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// dedupCheckboxes
// ═══════════════════════════════════════════════════════════════════════════

describe("dedupCheckboxes", () => {
  test("removes exact duplicate - [ ] entries", () => {
    writePlan("- [ ] Write tests\n- [ ] Deploy\n- [ ] Write tests\n");
    dedupCheckboxes(planPath);
    const result = readPlan();
    const matches = result.match(/- \[ \] Write tests/g);
    expect(matches?.length).toBe(1);
    expect(result).toContain("- [ ] Deploy");
  });

  test("removes - [ ] when - [x] exists for same text", () => {
    writePlan("- [x] Write tests\n- [ ] Write tests\n- [ ] Deploy\n");
    dedupCheckboxes(planPath);
    const result = readPlan();
    expect(result).toContain("- [x] Write tests");
    expect(result).not.toContain("- [ ] Write tests");
    expect(result).toContain("- [ ] Deploy");
  });

  test("preserves non-duplicate entries", () => {
    const plan = "- [ ] Task A\n- [x] Task B\n- [ ] Task C\n";
    writePlan(plan);
    dedupCheckboxes(planPath);
    expect(readPlan()).toBe(plan);
  });

  test("handles multiple duplicates", () => {
    writePlan("- [ ] A\n- [ ] B\n- [ ] A\n- [ ] B\n- [ ] A\n");
    dedupCheckboxes(planPath);
    const result = readPlan();
    expect((result.match(/- \[ \] A/g) || []).length).toBe(1);
    expect((result.match(/- \[ \] B/g) || []).length).toBe(1);
  });

  test("no-op on plan with no checkboxes", () => {
    const plan = "## 1. Section task\nSome body\n";
    writePlan(plan);
    dedupCheckboxes(planPath);
    expect(readPlan()).toBe(plan);
  });

  test("keeps checked duplicates (only dedup unchecked)", () => {
    writePlan("- [x] Done\n- [x] Done\n");
    dedupCheckboxes(planPath);
    const result = readPlan();
    expect((result.match(/- \[x\] Done/g) || []).length).toBe(2);
  });

  test("preserves non-checkbox lines interleaved", () => {
    writePlan("# Plan\n\n- [ ] Task A\nsome notes\n- [ ] Task A\n");
    dedupCheckboxes(planPath);
    const result = readPlan();
    expect((result.match(/- \[ \] Task A/g) || []).length).toBe(1);
    expect(result).toContain("some notes");
    expect(result).toContain("# Plan");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// markTaskCompleted + readCompletedTasks (progress-file based)
// ═══════════════════════════════════════════════════════════════════════════

describe("markTaskCompleted", () => {
  test("records checkbox completion in progress file", () => {
    writeFileSync(progressPath, "# Progress\n");
    markTaskCompleted(progressPath, "Write tests", true);
    const content = readFileSync(progressPath, "utf-8");
    expect(content).toContain("DONE: checkbox: Write tests");
  });

  test("records section completion in progress file", () => {
    writeFileSync(progressPath, "# Progress\n");
    markTaskCompleted(progressPath, "## 1. Build the widget\nSome body text", false);
    const content = readFileSync(progressPath, "utf-8");
    expect(content).toContain("DONE: section: ## 1. Build the widget");
  });

  test("appends without overwriting existing content", () => {
    writeFileSync(progressPath, "# Progress\nDONE: checkbox: First\n");
    markTaskCompleted(progressPath, "Second", true);
    const content = readFileSync(progressPath, "utf-8");
    expect(content).toContain("DONE: checkbox: First");
    expect(content).toContain("DONE: checkbox: Second");
  });

  test("creates progress file if missing", () => {
    expect(existsSync(progressPath)).toBe(false);
    markTaskCompleted(progressPath, "Task", true);
    expect(existsSync(progressPath)).toBe(true);
    expect(readFileSync(progressPath, "utf-8")).toContain("DONE: checkbox: Task");
  });
});

describe("readCompletedTasks", () => {
  test("returns empty set when no progress file", () => {
    const completed = readCompletedTasks(progressPath);
    expect(completed.size).toBe(0);
  });

  test("parses checkbox DONE lines", () => {
    writeFileSync(progressPath, "# Progress\nDONE: checkbox: Write tests\nDONE: checkbox: Deploy\n");
    const completed = readCompletedTasks(progressPath);
    expect(completed.has("checkbox: Write tests")).toBe(true);
    expect(completed.has("checkbox: Deploy")).toBe(true);
  });

  test("parses section DONE lines", () => {
    writeFileSync(progressPath, "DONE: section: ## 1. Build widget\n");
    const completed = readCompletedTasks(progressPath);
    expect(completed.has("section: ## 1. Build widget")).toBe(true);
  });

  test("ignores non-DONE lines", () => {
    writeFileSync(progressPath, "# Progress\nSome freeform notes\nDONE: checkbox: Real task\nMore notes\n");
    const completed = readCompletedTasks(progressPath);
    expect(completed.size).toBe(1);
    expect(completed.has("checkbox: Real task")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// extractCurrentTask (progress-based skip logic)
// ═══════════════════════════════════════════════════════════════════════════

describe("extractCurrentTask", () => {
  test("returns first unchecked checkbox", () => {
    writePlan("- [ ] Task A\n- [ ] Task B\n");
    const result = extractCurrentTask(planPath, progressPath);
    expect(result).toEqual({ task: "Task A", checkbox: true });
  });

  test("skips checkboxes marked done in progress file", () => {
    writePlan("- [ ] Task A\n- [ ] Task B\n");
    writeFileSync(progressPath, "DONE: checkbox: Task A\n");
    const result = extractCurrentTask(planPath, progressPath);
    expect(result).toEqual({ task: "Task B", checkbox: true });
  });

  test("returns first non-struck section header", () => {
    writePlan("## 1. First task\nBody\n## 2. Second task\nMore body\n");
    const result = extractCurrentTask(planPath, progressPath);
    expect(result?.checkbox).toBe(false);
    expect(result?.task).toContain("## 1. First task");
  });

  test("skips sections marked done in progress file", () => {
    writePlan("## 1. First task\nBody\n## 2. Second task\nMore body\n");
    writeFileSync(progressPath, "DONE: section: ## 1. First task\n");
    const result = extractCurrentTask(planPath, progressPath);
    expect(result?.task).toContain("## 2. Second task");
  });

  test("returns null when all tasks completed", () => {
    writePlan("- [ ] Task A\n- [ ] Task B\n");
    writeFileSync(progressPath, "DONE: checkbox: Task A\nDONE: checkbox: Task B\n");
    const result = extractCurrentTask(planPath, progressPath);
    expect(result).toBeNull();
  });

  test("skips section when all child checkboxes are completed", () => {
    writePlan("## 1. Setup\n- [ ] Install deps\n- [ ] Configure\n\n## 2. Build\nBody\n");
    writeFileSync(progressPath, "DONE: checkbox: Install deps\nDONE: checkbox: Configure\n");
    const result = extractCurrentTask(planPath, progressPath);
    expect(result?.task).toContain("## 2. Build");
  });

  test("does not skip section with uncompleted children", () => {
    writePlan("## 1. Setup\n- [ ] Install deps\n- [ ] Configure\n");
    writeFileSync(progressPath, "DONE: checkbox: Install deps\n");
    const result = extractCurrentTask(planPath, progressPath);
    // Section 1 still has uncompleted children → return checkbox
    expect(result).toEqual({ task: "Configure", checkbox: true });
  });

  test("returns null when no progress file and no tasks", () => {
    writePlan("# Just a title\n");
    const result = extractCurrentTask(planPath, progressPath);
    expect(result).toBeNull();
  });

  test("plan file is NOT mutated by completion tracking", () => {
    writePlan("- [ ] Task A\n- [ ] Task B\n");
    const before = readPlan();
    markTaskCompleted(progressPath, "Task A", true);
    expect(readPlan()).toBe(before); // plan unchanged
    const result = extractCurrentTask(planPath, progressPath);
    expect(result).toEqual({ task: "Task B", checkbox: true });
  });

  test("discard resets progress — all tasks available again", () => {
    writePlan("- [ ] Task A\n- [ ] Task B\n");
    writeFileSync(progressPath, "DONE: checkbox: Task A\nDONE: checkbox: Task B\n");
    expect(extractCurrentTask(planPath, progressPath)).toBeNull();
    // simulate discard: delete progress file
    rmSync(progressPath, { force: true });
    const result = extractCurrentTask(planPath, progressPath);
    expect(result).toEqual({ task: "Task A", checkbox: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// appendSubtasksToPlan
// ═══════════════════════════════════════════════════════════════════════════

describe("appendSubtasksToPlan", () => {
  test("appends subtasks as unchecked checkboxes", () => {
    writePlan("# Plan\n");
    appendSubtasksToPlan(planPath, ["Task A", "Task B"]);
    expect(readPlan()).toBe("# Plan\n\n- [ ] Task A\n- [ ] Task B\n");
  });

  test("strips markdown header prefixes from subtasks", () => {
    writePlan("");
    appendSubtasksToPlan(planPath, ["## Headed task", "### Sub headed"]);
    const result = readPlan();
    expect(result).toContain("- [ ] Headed task");
    expect(result).toContain("- [ ] Sub headed");
    expect(result).not.toContain("##");
  });

  test("strips strikethrough markers from subtasks", () => {
    writePlan("");
    appendSubtasksToPlan(planPath, ["~~struck~~ text", "clean text"]);
    const result = readPlan();
    expect(result).toContain("- [ ] struck text");
    expect(result).toContain("- [ ] clean text");
    expect(result).not.toContain("~~");
  });

  test("filters out empty/whitespace-only subtasks", () => {
    writePlan("");
    appendSubtasksToPlan(planPath, ["Real task", "", "  ", "Another task"]);
    const result = readPlan();
    expect(result).toContain("- [ ] Real task");
    expect(result).toContain("- [ ] Another task");
    const checkboxes = result.match(/- \[ \] /g);
    expect(checkboxes?.length).toBe(2);
  });

  test("handles all-empty subtasks array", () => {
    writePlan("# Plan\n");
    appendSubtasksToPlan(planPath, ["", "  "]);
    expect(readPlan()).toBe("# Plan\n\n\n");
  });

  test("handles empty subtasks array", () => {
    writePlan("# Plan\n");
    appendSubtasksToPlan(planPath, []);
    expect(readPlan()).toBe("# Plan\n\n\n");
  });

  test("sanitizes combined header + strikethrough", () => {
    writePlan("");
    appendSubtasksToPlan(planPath, ["### ~~Old task~~"]);
    const result = readPlan();
    expect(result).toContain("- [ ] Old task");
    expect(result).not.toContain("#");
    expect(result).not.toContain("~~");
  });

  test("trims whitespace from subtask text", () => {
    writePlan("");
    appendSubtasksToPlan(planPath, ["  padded task  ", "\ttabbed\t"]);
    const result = readPlan();
    expect(result).toContain("- [ ] padded task");
    expect(result).toContain("- [ ] tabbed");
  });

  test("preserves existing plan content", () => {
    writePlan("# Plan\n\n- [ ] Pending task\n");
    appendSubtasksToPlan(planPath, ["New subtask"]);
    const result = readPlan();
    expect(result).toContain("- [ ] Pending task");
    expect(result).toContain("- [ ] New subtask");
  });

  test("handles subtasks with regex-special characters", () => {
    writePlan("");
    appendSubtasksToPlan(planPath, ["Fix (bug) in [module]", "Handle $var + *.log"]);
    const result = readPlan();
    expect(result).toContain("- [ ] Fix (bug) in [module]");
    expect(result).toContain("- [ ] Handle $var + *.log");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// subtask emission + parent completion via progress file
// ═══════════════════════════════════════════════════════════════════════════

describe("subtask emission + progress-based completion", () => {
  test("parent marked done in progress, subtasks picked next", () => {
    writePlan("- [ ] Big task\n");
    appendSubtasksToPlan(planPath, ["Sub A", "Sub B"]);
    markTaskCompleted(progressPath, "Big task", true);
    // plan is NOT mutated
    expect(readPlan()).toContain("- [ ] Big task");
    // next task should be Sub A (Big task skipped via progress)
    const result = extractCurrentTask(planPath, progressPath);
    expect(result).toEqual({ task: "Sub A", checkbox: true });
  });

  test("section parent marked done in progress, next section picked", () => {
    writePlan("## 1. Big task\nSome details\n\n## 2. Other task\nMore details\n");
    appendSubtasksToPlan(planPath, ["Sub A", "Sub B"]);
    markTaskCompleted(progressPath, "## 1. Big task\nSome details", false);
    // next should be Sub A (checkbox), not section 2
    const result = extractCurrentTask(planPath, progressPath);
    expect(result).toEqual({ task: "Sub A", checkbox: true });
  });

  test("completing all subtasks and parent makes section fully done", () => {
    writePlan("## 1. Setup\n- [ ] Step A\n- [ ] Step B\n\n## 2. Build\nBody\n");
    markTaskCompleted(progressPath, "Step A", true);
    markTaskCompleted(progressPath, "Step B", true);
    // section 1 has all children done → should skip to section 2
    const result = extractCurrentTask(planPath, progressPath);
    expect(result?.task).toContain("## 2. Build");
  });
});
