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

export const activePtySessions = new Map<string, {
  viewer: WebSocket | null;
  pendingViewer: WebSocket | null;
  proc: ReturnType<typeof Bun.spawn>;
  ptySession: string;
  alive: boolean;
}>();

/** Test hook: expose activePtySessions for assertions */
export function __getActivePtySessions(): Map<string, { viewer: any; alive: boolean }> {
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

export function teardownPty(session: string): void {
  const entry = activePtySessions.get(session);
  if (!entry) return;
  entry.alive = false;
  activePtySessions.delete(session);
  if (entry.viewer) {
    try { entry.viewer.close(1000, "pty teardown"); } catch {}
    entry.viewer = null;
  }
  if (entry.pendingViewer) {
    try { entry.pendingViewer.close(1000, "pty teardown"); } catch {}
    entry.pendingViewer = null;
  }
  if (entry.proc) {
    try { entry.proc.terminal!.close(); } catch {}
    try { entry.proc.kill(); } catch {}
  }
  exec(TMUX, ["kill-session", "-t", entry.ptySession], { timeout: 2000 }).catch(() => {});
}

export function handlePtyWs(ws: WebSocket, session: string, reset = false): void {
  const ptySession = `wp_${session}`;

  // Force teardown existing PTY so a fresh one is spawned at the caller's dimensions
  if (reset) {
    const stale = activePtySessions.get(session);
    if (stale && stale.alive) {
      teardownPty(session);
    }
  }

  const existing = activePtySessions.get(session);

  if (existing && existing.alive) {
    // Session occupied — send conflict, hold connection open as pending
    ws.send(JSON.stringify({ type: "viewer_conflict" }));

    // If there's already a pending viewer, close it
    if (existing.pendingViewer) {
      try { existing.pendingViewer.close(4002, "displaced"); } catch {}
    }
    existing.pendingViewer = ws;

    const pingTimer = setInterval(() => {
      if (ws.readyState === 1) { try { ws.ping(); } catch {} }
      else clearInterval(pingTimer);
    }, 25000);

    ws.on("message", (raw: Buffer | string) => {
      try {
        const str = String(raw);
        if (typeof str !== "string" && !(Buffer.isBuffer(raw) && raw[0] === 0x7b)) return;
        const msg = JSON.parse(str);
        if (msg.type === "take_control") {
          // Close old viewer with displaced code
          if (existing.viewer) {
            try { existing.viewer.close(4002, "displaced"); } catch {}
          }
          // Tear down old PTY
          const oldProc = existing.proc;
          existing.alive = false;
          activePtySessions.delete(session);
          if (oldProc) {
            try { oldProc.terminal!.close(); } catch {}
            try { oldProc.kill(); } catch {}
          }
          exec(TMUX, ["kill-session", "-t", existing.ptySession], { timeout: 2000 }).catch(() => {});

          // Promote this viewer — spawn fresh PTY on first resize
          clearInterval(pingTimer);
          existing.pendingViewer = null;
          setupNewPtyEntry(ws, session, ptySession);
        }
      } catch {}
    });

    function cleanup() {
      clearInterval(pingTimer);
      if (existing.pendingViewer === ws) {
        existing.pendingViewer = null;
      }
    }
    ws.on("close", cleanup);
    ws.on("error", cleanup);
    return;
  }

  // No active PTY — create new entry
  setupNewPtyEntry(ws, session, ptySession);
}

function setupNewPtyEntry(ws: WebSocket, session: string, ptySession: string): void {
  const entry = {
    viewer: ws as WebSocket | null,
    pendingViewer: null as WebSocket | null,
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
      if (entry.viewer) {
        try { entry.viewer.close(4001, "session unavailable"); } catch {}
        entry.viewer = null;
      }
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
          if (entry.viewer && entry.viewer.readyState === 1) {
            try { entry.viewer.send(data); } catch {}
          }
        },
        exit(_terminal: unknown, _code: number, _signal?: number) {
          if (!entry.alive) return;
          entry.alive = false;
          activePtySessions.delete(session);
          const rapid = Date.now() - spawnedAt < 3000;
          const code = rapid ? 4001 : 1000;
          const reason = rapid ? "session unavailable" : "pty exited";
          if (entry.viewer) {
            try { entry.viewer.close(code, reason); } catch {}
            entry.viewer = null;
          }
          if (entry.pendingViewer) {
            try { entry.pendingViewer.close(code, reason); } catch {}
            entry.pendingViewer = null;
          }
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
    if (entry.viewer === ws) {
      entry.viewer = null;
      // Immediate teardown — no grace period
      teardownPty(session);
    }
  }
  ws.on("close", detach);
  ws.on("error", detach);
}
