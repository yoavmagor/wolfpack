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
  DESKTOP_PREFILL_HISTORY_LINES,
  exec,
  tmuxSend,
  tmuxSendKey,
  tmuxResize,
  capturePane,
} from "./tmux.js";
import { isAllowedSession } from "./http.js";

/** Token bucket rate limiter. */
function createRateLimiter(rate: number) {
  let tokens = rate;
  let last = Date.now();
  return {
    allow(): boolean {
      const now = Date.now();
      tokens = Math.min(rate, tokens + ((now - last) / 1000) * rate);
      last = now;
      if (tokens < 1) return false;
      tokens--;
      return true;
    },
  };
}

// ── PTY session tracking ──

export const activePtySessions = new Map<string, {
  viewer: WebSocket | null;
  pendingViewer: WebSocket | null;
  proc: ReturnType<typeof Bun.spawn>;
  alive: boolean;
}>();

/** Test hook: expose activePtySessions for assertions */
export function __getActivePtySessions(): Map<string, { viewer: any; alive: boolean }> {
  if (!process.env.WOLFPACK_TEST) throw new Error("__getActivePtySessions() is only available in test mode (WOLFPACK_TEST=1)");
  return activePtySessions as any;
}

const ptySpawnAttempts = new Map<string, number>();
const DESKTOP_PREFILL_MAX_BYTES = 256 * 1024;

/** Test hook: expose PTY spawn-attempt counts per session */
export function __getPtySpawnAttempts(): Map<string, number> {
  if (!process.env.WOLFPACK_TEST) throw new Error("__getPtySpawnAttempts() is only available in test mode (WOLFPACK_TEST=1)");
  return ptySpawnAttempts;
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

  const rl = createRateLimiter(60);

  ws.on("message", async (raw) => {
    if (!rl.allow()) return;

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
}

export function handlePtyWs(ws: WebSocket, session: string, reset = false): void {
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

    function pendingMessage(raw: Buffer | string) {
      try {
        const str = String(raw);
        const msg = JSON.parse(str);
        if (msg.type === "take_control") {
          // Null out viewer BEFORE closing — prevents old detach handler
          // from calling teardownPty() which would destroy the NEW entry
          const oldViewer = existing.viewer;
          existing.viewer = null;
          if (oldViewer) {
            try { oldViewer.close(4002, "displaced"); } catch {}
          }
          // Tear down old PTY proc (no tmux session to clean up anymore)
          const oldProc = existing.proc;
          existing.alive = false;
          activePtySessions.delete(session);
          if (oldProc) {
            try { oldProc.terminal!.close(); } catch {}
            try { oldProc.kill(); } catch {}
          }

          // Remove pending handlers before promoting — prevents duplicate handlers
          clearInterval(pingTimer);
          ws.removeListener("message", pendingMessage);
          ws.removeListener("close", cleanup);
          ws.removeListener("error", cleanup);
          existing.pendingViewer = null;

          // Promote this viewer — spawn fresh PTY on first resize
          setupNewPtyEntry(ws, session);
          // Tell client takeover succeeded so it re-sends resize
          try { ws.send(JSON.stringify({ type: "control_granted" })); } catch {}
        }
      } catch {}
    }

    function cleanup() {
      clearInterval(pingTimer);
      ws.removeListener("message", pendingMessage);
      ws.removeListener("close", cleanup);
      ws.removeListener("error", cleanup);
      if (existing.pendingViewer === ws) {
        existing.pendingViewer = null;
      }
    }
    ws.on("message", pendingMessage);
    ws.on("close", cleanup);
    ws.on("error", cleanup);
    return;
  }

  // No active PTY — create new entry
  setupNewPtyEntry(ws, session);
}

function setupNewPtyEntry(ws: WebSocket, session: string): void {
  const entry = {
    viewer: ws as WebSocket | null,
    pendingViewer: null as WebSocket | null,
    proc: null as ReturnType<typeof Bun.spawn> | null,
    alive: true,
  };
  activePtySessions.set(session, entry as any);
  let spawning = false;
  let latestRequestedSize: { cols: number; rows: number } | null = null;
  let pendingSkipPrefill = false;

  async function spawnPty(
    cols: number,
    rows: number,
    options?: { skipPrefill?: boolean },
  ) {
    if (options?.skipPrefill === true) pendingSkipPrefill = true;
    latestRequestedSize = { cols, rows };
    if (entry.proc || spawning) return;
    spawning = true;
    if (process.env.WOLFPACK_TEST) {
      ptySpawnAttempts.set(session, (ptySpawnAttempts.get(session) || 0) + 1);
    }
    const skipPrefill = pendingSkipPrefill;
    pendingSkipPrefill = false;
    let prefill = Buffer.alloc(0);

    try {
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

      // Override window-size so resize-window works
      await exec(TMUX, ["set-option", "-t", session, "window-size", "latest"], { timeout: 2000 }).catch(() => {});

      if (!entry.alive || activePtySessions.get(session) !== entry || entry.viewer !== ws) return;

      // Pre-fill viewer with tmux scrollback so xterm.js has content to scroll through.
      // The attach path can replay part of the visible pane, so strip any overlap from
      // the first PTY bytes only after the prefill has been delivered successfully.
      if (!skipPrefill) {
        try {
          const { stdout } = await exec(TMUX, [
            "capture-pane", "-t", session, "-p", "-e", "-S", `-${DESKTOP_PREFILL_HISTORY_LINES}`,
          ], { timeout: 3000 });
          if (stdout && entry.viewer && entry.viewer.readyState === 1) {
            const rawPrefill = Buffer.from(stdout);
            if (rawPrefill.length > DESKTOP_PREFILL_MAX_BYTES) {
              // Keep only the most recent chunk to avoid long first-frame paint stalls.
              let start = rawPrefill.length - DESKTOP_PREFILL_MAX_BYTES;
              while (start < rawPrefill.length && rawPrefill[start] !== 0x0a) start++;
              if (start < rawPrefill.length) start++;
              prefill = rawPrefill.subarray(start);
            } else {
              prefill = rawPrefill;
            }
            try {
              entry.viewer.send(prefill);
            } catch (err: any) {
              console.error(`PTY prefill send failed [${session}]:`, err?.message || err);
            }
          }
        } catch {}
      }

      if (!entry.alive || activePtySessions.get(session) !== entry || entry.viewer !== ws) return;

      const initialSize = latestRequestedSize || { cols, rows };
      const spawnedAt = Date.now();
      entry.proc = Bun.spawn([TMUX, "attach-session", "-t", session], {
        env: { ...process.env, TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        terminal: {
          cols: initialSize.cols,
          rows: initialSize.rows,
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
          },
        }
      });
      activePtySessions.set(session, entry as any);
      setTimeout(async () => {
        if (!entry.alive || !entry.proc) return;
        const latestSize = latestRequestedSize || initialSize;
        try {
          // Re-force latest in case Claude Code re-applied manual during spawn
          await exec(TMUX, ["set-option", "-t", session, "window-size", "latest"], { timeout: 2000 });
          await exec(TMUX, ["resize-window", "-t", session, "-x", String(latestSize.cols), "-y", String(latestSize.rows)], { timeout: 2000 });
        } catch {}
        try {
          entry.proc.terminal!.resize(latestSize.cols, latestSize.rows);
        } catch {}
      }, 100);
    } finally {
      spawning = false;
    }
  }

  const rl = createRateLimiter(60);
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  ws.on("message", (raw: Buffer | string, isBinary: boolean) => {
    if (!entry.alive) return;
    if (!rl.allow()) return;
    try {
      if (!isBinary) {
        const msg = JSON.parse(String(raw));
        if (
          msg.type === "attach" &&
          typeof msg.cols === "number" &&
          typeof msg.rows === "number"
        ) {
          // Attach handshake is a one-time bootstrap for a fresh WS viewer.
          // It spawns the PTY without forcing an extra tmux resize if dims are unchanged.
          latestRequestedSize = { cols: clampCols(msg.cols), rows: clampRows(msg.rows) };
          if (!entry.proc) {
            spawnPty(latestRequestedSize.cols, latestRequestedSize.rows, {
              skipPrefill: msg.skipPrefill === true,
            });
          }
          if (entry.viewer && entry.viewer.readyState === 1) {
            try { entry.viewer.send(JSON.stringify({ type: "attach_ack" })); } catch {}
          }
        } else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          const cols = clampCols(msg.cols);
          const rows = clampRows(msg.rows);
          latestRequestedSize = { cols, rows };
          if (!entry.proc) {
            // Backward compatibility: older clients still bootstrap PTY via first resize.
            spawnPty(cols, rows);
          } else {
            // Debounce resize to prevent storms crashing TUI apps
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              resizeTimer = null;
              if (!entry.alive || !entry.proc) return;
              entry.proc.terminal!.resize(cols, rows);
              exec(TMUX, ["set-option", "-t", session, "window-size", "latest"], { timeout: 2000 })
                .then(() => exec(TMUX, ["resize-window", "-t", session, "-x", String(cols), "-y", String(rows)], { timeout: 2000 }))
                .catch(() => {});
            }, 80);
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
    // Only tear down if OUR entry is still the active one in the map.
    // A new entry may have replaced it (e.g. grid view reconnect with reset=1).
    if (entry.alive && entry.viewer === ws && activePtySessions.get(session) === entry) {
      entry.viewer = null;
      teardownPty(session);
    }
  }
  ws.on("close", detach);
  ws.on("error", detach);
}
