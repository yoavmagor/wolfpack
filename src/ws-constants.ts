/**
 * Shared WebSocket close codes and reason strings.
 *
 * Both server (websocket.ts) and client (take-control-logic.ts) reference
 * these constants so the string contract is enforced at compile time.
 */

// ── Close codes ──

export const CLOSE_CODE_NORMAL = 1000;
export const CLOSE_CODE_SESSION_UNAVAILABLE = 4001;
export const CLOSE_CODE_DISPLACED = 4002;

// ── Close reason strings ──

export const WS_CLOSE_REASONS = {
  PTY_EXITED: "pty exited",
  SESSION_UNAVAILABLE: "session unavailable",
  DISPLACED: "displaced",
  PTY_TEARDOWN: "pty teardown",
  SESSION_ENDED: "session ended",
} as const;
