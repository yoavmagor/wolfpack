/**
 * Ralph loop management — log parsing, project scanning, task counting.
 */
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { countTasksInContent, validatePlanFormat } from "../wolfpack-context.js";
import { DEV_DIR } from "./tmux.js";

export interface RalphStatus {
  project: string;
  active: boolean;
  completed: boolean;
  audit: boolean;
  cleanup: boolean;
  cleanupEnabled: boolean;
  auditFixEnabled: boolean;
  iteration: number;
  totalIterations: number;
  agent: string;
  planFile: string;
  progressFile: string;
  started: string;
  finished: string;
  lastOutput: string;
  pid: number;
  tasksDone: number;
  tasksTotal: number;
}

export function listDevProjects(): string[] {
  try {
    return readdirSync(DEV_DIR)
      .filter((f) => {
        try {
          return statSync(join(DEV_DIR, f)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

export function countPlanTasks(planPath: string): { done: number; total: number; issues: string[] } {
  try {
    const plan = readFileSync(planPath, "utf-8");
    const { issues } = validatePlanFormat(plan);
    const { done, total } = countTasksInContent(plan);
    return { done, total, issues };
  } catch {
    return { done: 0, total: 0, issues: [] };
  }
}

export function parseRalphLog(projectDir: string): RalphStatus | null {
  const logPath = join(projectDir, ".ralph.log");
  if (!existsSync(logPath)) return null;

  const project = projectDir.split("/").pop() ?? "";
  const status: RalphStatus = {
    project,
    active: false,
    completed: false,
    audit: false,
    cleanup: false,
    cleanupEnabled: true,
    auditFixEnabled: false,
    iteration: 0,
    totalIterations: 0,
    agent: "",
    planFile: "",
    progressFile: "",
    started: "",
    finished: "",
    lastOutput: "",
    pid: 0,
    tasksDone: 0,
    tasksTotal: 0,
  };

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n");

    // parse header
    for (const line of lines.slice(0, 16)) {
      const agentMatch = line.match(/^agent:\s*(.+)/);
      if (agentMatch) status.agent = agentMatch[1].trim();
      const planMatch = line.match(/^plan:\s*(.+)/);
      if (planMatch) status.planFile = planMatch[1].trim();
      const progMatch = line.match(/^progress:\s*(.+)/);
      if (progMatch) status.progressFile = progMatch[1].trim();
      const cleanupMatch = line.match(/^phase_cleanup:\s*(on|off)/);
      if (cleanupMatch) status.cleanupEnabled = cleanupMatch[1] === "on";
      const auditFixMatch = line.match(/^phase_audit_fix:\s*(on|off)/);
      if (auditFixMatch) status.auditFixEnabled = auditFixMatch[1] === "on";
      const startMatch = line.match(/^started:\s*(.+)/);
      if (startMatch) status.started = startMatch[1].trim();
      const pidMatch = line.match(/^pid:\s*(\d+)/);
      if (pidMatch) status.pid = Number(pidMatch[1]);
    }

    // parse total iterations from header line
    const totalMatch = content.match(/ralph — (\d+) iterations/);
    if (totalMatch) status.totalIterations = Number(totalMatch[1]);

    // find iterations (supports both old "Iteration" and new "Wax On" format)
    const iterRegex = /=== (?:Iteration|🥋 Wax On) (\d+)\/(\d+)/g;
    let match;
    while ((match = iterRegex.exec(content)) !== null) {
      status.iteration = Number(match[1]);
      status.totalIterations = Number(match[2]);
    }

    // check completion
    const finishedMatch = content.match(/^finished:\s*(.+)/m);
    if (finishedMatch) {
      status.finished = finishedMatch[1].trim();
    }

    // detect active: pid alive check
    if (status.pid > 1) {
      try {
        process.kill(status.pid, 0);
        status.active = true;
        status.completed = false;
        if (content.includes("Wax Inspect") && !content.includes("Wax Inspect complete") && !content.includes("Wax Inspect FAILED")) {
          status.audit = true;
        }
        if (content.includes("🥋 Wax Off") && !content.includes("Wax Off complete") && !content.includes("Wax Off FAILED")) {
          status.cleanup = true;
        }
      } catch {
        status.active = false;
        const lockPath = join(projectDir, ".ralph.lock");
        try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch (err: any) {
          console.warn(`parseRalphLog: failed to remove stale lock:`, err?.message);
        }
      }
    }

    // last output lines (skip markers and blanks)
    const meaningful = lines.filter(
      (l) => l.trim() && !l.startsWith("===") && !l.startsWith("plan:") &&
        !l.startsWith("progress:") && !l.startsWith("started:") &&
        !l.startsWith("finished:") && !l.startsWith("pid:") &&
        !l.startsWith("agent:") && !l.startsWith("phase_cleanup:") &&
        !l.startsWith("phase_audit_fix:") && !l.startsWith("🥋"),
    );
    status.lastOutput = meaningful.slice(-5).join("\n");

    // count tasks from plan file
    if (status.planFile) {
      const tasks = countPlanTasks(join(projectDir, status.planFile));
      status.tasksDone = tasks.done;
      status.tasksTotal = tasks.total;
      if (tasks.done > 0 && tasks.done === tasks.total && !status.active) {
        status.completed = true;
      }
    }

    return status;
  } catch {
    return null;
  }
}

export function scanRalphLoops(): RalphStatus[] {
  const projects = listDevProjects();
  const results: RalphStatus[] = [];
  for (const p of projects) {
    const dir = join(DEV_DIR, p);
    const status = parseRalphLog(dir);
    if (!status) continue;
    if (status.planFile && !existsSync(join(dir, status.planFile))) continue;
    results.push(status);
  }
  return results;
}
