/**
 * tmux helpers — exec wrappers, test hooks, capture-pane.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import { shellEscape } from "../validation.js";
import { INTERACTIVE_CONTEXT } from "../wolfpack-context.js";

const exec = promisify(execFile);

export const TMUX = "tmux";

export const DEV_DIR =
  process.env.WOLFPACK_DEV_DIR || join(homedir(), "Dev");

// resolve user's shell — Ubuntu defaults to bash, macOS to zsh
export const SHELL = (() => {
  const envShell = process.env.SHELL;
  if (envShell) {
    try { execFileSync("test", ["-x", envShell]); return envShell; } catch {}
  }
  for (const p of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    try { execFileSync("test", ["-x", p]); return p; } catch {}
  }
  return "/bin/sh";
})();

// ── Test mode assertion ──

function assertTestMode(hook: string): void {
  if (!process.env.WOLFPACK_TEST) throw new Error(`${hook}() is only available in test mode (WOLFPACK_TEST=1)`);
}

// ── tmuxList ──

async function _realTmuxList(): Promise<string[]> {
  try {
    const { stdout } = await exec(TMUX, [
      "list-sessions",
      "-F",
      "#{session_name}|||#{pane_current_path}",
    ]);
    const SEP = "|||";
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        const idx = line.indexOf(SEP);
        return idx !== -1 && line.substring(idx + SEP.length).startsWith(DEV_DIR);
      })
      .map((line) => line.substring(0, line.indexOf(SEP)))
      .filter((name) => !name.startsWith("wp_"));
  } catch {
    return [];
  }
}

async function _realTmuxListWithActivity(): Promise<{ name: string; activity: number }[]> {
  try {
    const { stdout } = await exec(TMUX, [
      "list-sessions",
      "-F",
      "#{session_name}|||#{pane_current_path}|||#{session_activity}",
    ]);
    const SEP = "|||";
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        const parts = line.split(SEP);
        return parts.length >= 3 && parts[1].startsWith(DEV_DIR);
      })
      .filter((line) => !line.split(SEP)[0].startsWith("wp_"))
      .map((line) => {
        const parts = line.split(SEP);
        return { name: parts[0], activity: parseInt(parts[2], 10) || 0 };
      });
  } catch {
    return [];
  }
}

let _tmuxListFn: () => Promise<string[]> = _realTmuxList;
let _tmuxListWithActivityFn: () => Promise<{ name: string; activity: number }[]> = _realTmuxListWithActivity;

/** Test hook: override tmuxList to avoid requiring real tmux */
export function __setTmuxList(fn: () => Promise<string[]>): void {
  assertTestMode("__setTmuxList");
  _tmuxListFn = fn;
}

/** Test hook: override tmuxListWithActivity */
export function __setTmuxListWithActivity(fn: () => Promise<{ name: string; activity: number }[]>): void {
  assertTestMode("__setTmuxListWithActivity");
  _tmuxListWithActivityFn = fn;
}

export async function tmuxList(): Promise<string[]> {
  return _tmuxListFn();
}

export async function tmuxListWithActivity(): Promise<{ name: string; activity: number }[]> {
  return _tmuxListWithActivityFn();
}

// ── tmuxSend / tmuxSendKey ──

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function _realTmuxSend(session: string, text: string, noEnter = false): Promise<void> {
  await exec(TMUX, ["send-keys", "-l", "-t", session, text]);
  if (!noEnter) {
    await sleep(50);
    await exec(TMUX, ["send-keys", "-t", session, "Enter"]);
  }
}

async function _realTmuxSendKey(session: string, key: string): Promise<void> {
  await exec(TMUX, ["send-keys", "-t", session, key]);
}

let _tmuxSendFn: (session: string, text: string, noEnter?: boolean) => Promise<void> = _realTmuxSend;
let _tmuxSendKeyFn: (session: string, key: string) => Promise<void> = _realTmuxSendKey;

/** Test hook: override tmuxSend */
export function __setTmuxSend(fn: (session: string, text: string, noEnter?: boolean) => Promise<void>): void {
  assertTestMode("__setTmuxSend");
  _tmuxSendFn = fn;
}

/** Test hook: override tmuxSendKey */
export function __setTmuxSendKey(fn: (session: string, key: string) => Promise<void>): void {
  assertTestMode("__setTmuxSendKey");
  _tmuxSendKeyFn = fn;
}

export async function tmuxSend(session: string, text: string, noEnter = false): Promise<void> {
  return _tmuxSendFn(session, text, noEnter);
}

export async function tmuxSendKey(session: string, key: string): Promise<void> {
  return _tmuxSendKeyFn(session, key);
}

// ── tmuxResize ──

async function _realTmuxResize(session: string, cols: number, rows: number): Promise<void> {
  await exec(TMUX, ["resize-window", "-t", session, "-x", String(cols), "-y", String(rows)]);
}

let _tmuxResizeFn: (session: string, cols: number, rows: number) => Promise<void> = _realTmuxResize;

/** Test hook: override tmuxResize */
export function __setTmuxResize(fn: (session: string, cols: number, rows: number) => Promise<void>): void {
  assertTestMode("__setTmuxResize");
  _tmuxResizeFn = fn;
}

export async function tmuxResize(session: string, cols: number, rows: number): Promise<void> {
  return _tmuxResizeFn(session, cols, rows);
}

// ── capturePane ──

let _capturePane: (session: string) => Promise<string> = async (session) => {
  try {
    const { stdout } = await exec(TMUX, [
      "capture-pane", "-t", session, "-p", "-J", "-S", "-2000",
    ]);
    return stdout;
  } catch {
    return "";
  }
};

export async function capturePane(session: string): Promise<string> {
  return _capturePane(session);
}

// Separate cache for /api/sessions triage — avoids O(n) tmux execs on rapid polling
const _triageCacheMap = new Map<string, { content: string; ts: number }>();
const TRIAGE_CACHE_TTL_MS = 500;

export async function capturePaneForTriage(session: string): Promise<string> {
  const cached = _triageCacheMap.get(session);
  if (cached && Date.now() - cached.ts < TRIAGE_CACHE_TTL_MS) return cached.content;
  const content = await _capturePane(session);
  _triageCacheMap.set(session, { content, ts: Date.now() });
  return content;
}

/** Test hook: override capturePane */
export function __setCapturePane(fn: (session: string) => Promise<string>): void {
  assertTestMode("__setCapturePane");
  _capturePane = fn;
}

// ── tmuxNewSession ──

const RALPH_AGENTS = new Set(["claude", "codex", "gemini"]);

/** Detect which agent an agentCmd refers to */
export function detectAgent(agentCmd: string): "claude" | "gemini" | "codex" | null {
  for (const agent of RALPH_AGENTS) {
    if (new RegExp(`^${agent}\\b`).test(agentCmd)) return agent as "claude" | "gemini" | "codex";
  }
  return null;
}

/**
 * Build the full command with context injection for the detected agent.
 */
export function injectAgentContext(agentCmd: string): string {
  const agent = detectAgent(agentCmd);
  switch (agent) {
    case "claude": {
      const withCtx = agentCmd + " --append-system-prompt " + shellEscape(INTERACTIVE_CONTEXT);
      return withCtx + " || " + agentCmd;
    }
    case "gemini": {
      return agentCmd + " -i " + shellEscape(INTERACTIVE_CONTEXT);
    }
    default:
      return agentCmd;
  }
}

export async function tmuxNewSession(
  name: string,
  cwd: string,
  cmd: string | undefined,
  loadSettings: () => { agentCmd: string },
): Promise<void> {
  const agentCmd = cmd || loadSettings().agentCmd || "claude";
  if (agentCmd === "shell") {
    await exec(TMUX, ["new-session", "-d", "-s", name, "-c", cwd, SHELL]);
    return;
  }
  const fullCmd = injectAgentContext(agentCmd);
  const shellCmd = `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT ${SHELL} -lic ${shellEscape(fullCmd + "; exec " + SHELL)}`;
  await exec(TMUX, ["new-session", "-d", "-s", name, "-c", cwd, shellCmd]);
}

// ── Cleanup ──

export async function cleanupOrphanPtySessions(): Promise<void> {
  try {
    const { stdout } = await exec(TMUX, ["list-sessions", "-F", "#{session_name}"], { timeout: 3000 });
    for (const name of stdout.split("\n")) {
      if (name.startsWith("wp_")) {
        await exec(TMUX, ["kill-session", "-t", name], { timeout: 2000 }).catch(() => {});
      }
    }
  } catch {}
}

export { exec, RALPH_AGENTS };
