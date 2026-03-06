/**
 * WebSocket handlers — terminal (capture-pane polling) and PTY (xterm.js direct).
 */
import type { WebSocket } from "ws";
import {
  WS_ALLOWED_KEYS,
  clampCols,
  clampRows,
} from "../validation.js";
import {
  TMUX,
  exec,
  tmuxSend,
  tmuxSendKey,
  tmuxResize,
  capturePane,
} from "./tmux.js";
import { isAllowedSession } from "./http.js";

// ── PTY session tracking ──

const PTY_TEARDOWN_GRACE_MS = 15_000;

export const activePtySessions = new Map<string, {
  viewers: Set<WebSocket>;
  proc: ReturnType<typeof Bun.spawn>;
  ptySession: string;
  alive: boolean;
  teardownTimer?: ReturnType<typeof setTimeout> | null;
}>();

/** Test hook: expose activePtySessions for assertions */
export function __getActivePtySessions(): Map<string, { viewers: Set<any>; alive: boolean }> {
  if (!process.env.WOLFPACK_TEST) throw new Error("__getActivePtySessions() is only available in test mode (WOLFPACK_TEST=1)");
  return activePtySessions as any;
}

// ── Terminal WS handler (mobile — capture-pane polling) ──

export function handleTerminalWs(ws: WebSocket, session: string): void {
  let prev = "";
  let alive = true;
  let sized = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let updating = false;
  let nextSessionCheckAt = 0;

  async function sendUpdate() {
    if (!alive || updating) return;
    updating = true;
    try {
      const now = Date.now();
      if (now >= nextSessionCheckAt) {
        nextSessionCheckAt = now + 1000;
        if (!(await isAllowedSession(session))) {
          alive = false;
          updating = false;
          try { ws.close(4001, "session ended"); } catch {}
          return;
        }
      }
      const pane = await capturePane(session);
      if (pane !== prev) {
        prev = pane;
        ws.send(JSON.stringify({ type: "output", data: pane }));
      }
    } catch {}
    updating = false;
    schedulePoll();
  }

  function schedulePoll() {
    if (!alive) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(sendUpdate, 50);
  }

  schedulePoll();

  const pingTimer = setInterval(() => {
    if (alive && ws.readyState === 1) {
      try { ws.ping(); } catch {}
    } else {
      clearInterval(pingTimer);
    }
  }, 25000);

  let rlTokens = 60;
  let rlLast = Date.now();

  ws.on("message", async (raw) => {
    const now = Date.now();
    rlTokens = Math.min(60, rlTokens + ((now - rlLast) / 1000) * 60);
    rlLast = now;
    if (rlTokens < 1) return;
    rlTokens--;

    try {
      const str = String(raw);
      if (str.length > 65536) return;
      const msg = JSON.parse(str);
      if (msg.type === "input" && typeof msg.data === "string") {
        await tmuxSend(session, msg.data, true);
        setTimeout(sendUpdate, 15);
      } else if (msg.type === "key" && typeof msg.key === "string") {
        if (WS_ALLOWED_KEYS.has(msg.key)) {
          await tmuxSendKey(session, msg.key);
          setTimeout(sendUpdate, 15);
        }
      } else if (
        msg.type === "resize" &&
        typeof msg.cols === "number" &&
        typeof msg.rows === "number"
      ) {
        if (!activePtySessions.has(session)) {
          await tmuxResize(session, clampCols(msg.cols), clampRows(msg.rows));
        }
        if (!sized) {
          sized = true;
          setTimeout(sendUpdate, 50);
        }
      }
    } catch (err: any) {
      if (err instanceof SyntaxError) return;
      console.error(`WS error [${session}]:`, err?.message || err);
    }
  });

  ws.on("close", () => {
    alive = false;
    clearInterval(pingTimer);
    if (pollTimer) clearTimeout(pollTimer);
  });

  ws.on("error", () => {
    alive = false;
    clearInterval(pingTimer);
    if (pollTimer) clearTimeout(pollTimer);
  });
}

// ── PTY WS handler (desktop — xterm.js direct) ──

function schedulePtyTeardown(session: string): void {
  const entry = activePtySessions.get(session);
  if (!entry || !entry.alive) return;
  if (entry.teardownTimer) return;
  entry.teardownTimer = setTimeout(() => {
    entry.teardownTimer = null;
    if (entry.viewers.size === 0) teardownPty(session);
  }, PTY_TEARDOWN_GRACE_MS);
}

export function teardownPty(session: string): void {
  const entry = activePtySessions.get(session);
  if (!entry) return;
  if (entry.teardownTimer) {
    clearTimeout(entry.teardownTimer);
    entry.teardownTimer = null;
  }
  entry.alive = false;
  activePtySessions.delete(session);
  if (entry.proc) {
    try { entry.proc.terminal!.close(); } catch {}
    try { entry.proc.kill(); } catch {}
  }
  exec(TMUX, ["kill-session", "-t", entry.ptySession], { timeout: 2000 }).catch(() => {});
}

export function handlePtyWs(ws: WebSocket, session: string): void {
  const ptySession = `wp_${session}`;
  const existing = activePtySessions.get(session);

  if (existing && existing.alive) {
    if (existing.teardownTimer) {
      clearTimeout(existing.teardownTimer);
      existing.teardownTimer = null;
    }
    if (!existing.proc) {
      existing.viewers.add(ws);
      const pingTimer = setInterval(() => {
        if (ws.readyState === 1) { try { ws.ping(); } catch {} }
        else clearInterval(pingTimer);
      }, 25000);
      function detach() {
        clearInterval(pingTimer);
        existing.viewers.delete(ws);
        if (existing.viewers.size === 0) schedulePtyTeardown(session);
      }
      ws.on("close", detach);
      ws.on("error", detach);
      return;
    }
    existing.viewers.add(ws);
    const pingTimer = setInterval(() => {
      if (ws.readyState === 1) { try { ws.ping(); } catch {} }
      else clearInterval(pingTimer);
    }, 25000);

    let rlTokens = 60;
    let rlLast = Date.now();
    ws.on("message", (raw: Buffer | string) => {
      if (!existing.alive) return;
      const now = Date.now();
      rlTokens = Math.min(60, rlTokens + ((now - rlLast) / 1000) * 60);
      rlLast = now;
      if (rlTokens < 1) return;
      rlTokens--;
      try {
        if (typeof raw === "string" || (Buffer.isBuffer(raw) && raw[0] === 0x7b)) {
          const msg = JSON.parse(String(raw));
          if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
            const cols = clampCols(msg.cols);
            const rows = clampRows(msg.rows);
            try {
              existing.proc.terminal!.resize(Math.max(20, cols - 1), rows);
            } catch {}
            existing.proc.terminal!.resize(cols, rows);
            // Also force tmux resize — Claude Code may have re-applied window-size=manual
            exec(TMUX, ["set-option", "-t", session, "window-size", "latest"], { timeout: 2000 })
              .then(() => exec(TMUX, ["resize-window", "-t", session, "-x", String(cols), "-y", String(rows)], { timeout: 2000 }))
              .catch(() => {});
          }
        } else if (existing.proc) {
          if (Buffer.isBuffer(raw) && raw.length > 16384) return;
          existing.proc.terminal!.write(raw as Buffer);
        }
      } catch (err: any) {
        if (err instanceof SyntaxError) return;
        console.error(`PTY WS error [${session}]:`, err?.message || err);
      }
    });

    function detach() {
      clearInterval(pingTimer);
      existing.viewers.delete(ws);
      if (existing.viewers.size === 0) schedulePtyTeardown(session);
    }
    ws.on("close", detach);
    ws.on("error", detach);
    return;
  }

  // First viewer — create new PTY entry
  const entry = {
    viewers: new Set<WebSocket>([ws]),
    proc: null as ReturnType<typeof Bun.spawn> | null,
    ptySession,
    alive: true,
  };
  activePtySessions.set(session, entry as any);

  async function spawnPty(cols: number, rows: number) {
    if (entry.proc) return;

    try {
      await exec(TMUX, ["has-session", "-t", session], { timeout: 2000 });
    } catch {
      entry.alive = false;
      activePtySessions.delete(session);
      for (const viewer of entry.viewers) {
        try { viewer.close(4001, "session unavailable"); } catch {}
      }
      entry.viewers.clear();
      return;
    }

    await exec(TMUX, ["kill-session", "-t", ptySession], { timeout: 2000 }).catch(() => {});
    await exec(TMUX, ["new-session", "-d", "-t", session, "-s", ptySession], { timeout: 3000 }).catch(() => {});
    await exec(TMUX, ["set-option", "-t", ptySession, "status", "off"], { timeout: 2000 }).catch(() => {});
    await exec(TMUX, ["set-option", "-t", ptySession, "mouse", "on"], { timeout: 2000 }).catch(() => {});
    // Claude Code sets window-size=manual on sessions to protect its TUI.
    // Override on both sessions so resize-window actually works.
    await exec(TMUX, ["set-option", "-t", session, "window-size", "latest"], { timeout: 2000 }).catch(() => {});
    await exec(TMUX, ["set-option", "-t", ptySession, "window-size", "latest"], { timeout: 2000 }).catch(() => {});

    if (!entry.alive) return;

    const spawnedAt = Date.now();
    entry.proc = Bun.spawn([TMUX, "attach-session", "-t", ptySession], {
      env: { ...process.env, TERM: "xterm-256color" },
      terminal: {
        cols,
        rows,
        data(_terminal: unknown, data: Buffer) {
          if (!entry.alive) return;
          for (const viewer of entry.viewers) {
            if (viewer.readyState === 1) {
              try { viewer.send(data); } catch {}
            }
          }
        },
        exit(_terminal: unknown, _code: number, _signal?: number) {
          if (!entry.alive) return;
          entry.alive = false;
          activePtySessions.delete(session);
          const rapid = Date.now() - spawnedAt < 3000;
          const code = rapid ? 4001 : 1000;
          const reason = rapid ? "session unavailable" : "pty exited";
          for (const viewer of entry.viewers) {
            try { viewer.close(code, reason); } catch {}
          }
          entry.viewers.clear();
          exec(TMUX, ["kill-session", "-t", ptySession], { timeout: 2000 }).catch(() => {});
        },
      },
    });
    activePtySessions.set(session, entry as any);
    setTimeout(async () => {
      if (!entry.alive || !entry.proc) return;
      try {
        // Re-force latest in case Claude Code re-applied manual during spawn
        await exec(TMUX, ["set-option", "-t", session, "window-size", "latest"], { timeout: 2000 });
        await exec(TMUX, ["resize-window", "-t", session, "-x", String(cols), "-y", String(rows)], { timeout: 2000 });
      } catch {}
      try {
        entry.proc.terminal!.resize(Math.max(20, cols - 1), rows);
        entry.proc.terminal!.resize(cols, rows);
      } catch {}
    }, 100);
  }

  let rlTokens = 60;
  let rlLast = Date.now();

  ws.on("message", (raw: Buffer | string) => {
    if (!entry.alive) return;
    const now = Date.now();
    rlTokens = Math.min(60, rlTokens + ((now - rlLast) / 1000) * 60);
    rlLast = now;
    if (rlTokens < 1) return;
    rlTokens--;
    try {
      if (typeof raw === "string" || (Buffer.isBuffer(raw) && raw[0] === 0x7b)) {
        const msg = JSON.parse(String(raw));
        if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          const cols = clampCols(msg.cols);
          const rows = clampRows(msg.rows);
          if (!entry.proc) {
            spawnPty(cols, rows);
          } else {
            entry.proc.terminal!.resize(cols, rows);
            exec(TMUX, ["set-option", "-t", session, "window-size", "latest"], { timeout: 2000 })
              .then(() => exec(TMUX, ["resize-window", "-t", session, "-x", String(cols), "-y", String(rows)], { timeout: 2000 }))
              .catch(() => {});
          }
        }
      } else if (entry.proc) {
        if (Buffer.isBuffer(raw) && raw.length > 16384) return;
        entry.proc.terminal!.write(raw as Buffer);
      }
    } catch (err: any) {
      if (err instanceof SyntaxError) return;
      console.error(`PTY WS error [${session}]:`, err?.message || err);
    }
  });

  const pingTimer = setInterval(() => {
    if (ws.readyState === 1) { try { ws.ping(); } catch {} }
    else clearInterval(pingTimer);
  }, 25000);

  function detach() {
    clearInterval(pingTimer);
    entry.viewers.delete(ws);
    if (entry.viewers.size === 0) schedulePtyTeardown(session);
  }
  ws.on("close", detach);
  ws.on("error", detach);
}
