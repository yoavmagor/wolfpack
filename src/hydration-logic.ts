/**
 * Hydration state machine for xterm.js terminal initial-load reveal.
 * Pure state machine — no DOM, no timers. Caller provides side-effect callbacks.
 *
 * Lifecycle: idle → start() → pending → finish()/cancel()/timeout
 *
 * The "opens-at-bottom" invariant: finish() always calls scrollToBottom
 * before revealing, so the user sees the latest output, not the top.
 */

export interface HydrationConfig {
  timeoutMs?: number;
}

export const DEFAULTS = {
  timeoutMs: 1000,
} as const;

export type HydrationStatus = "idle" | "pending" | "finished" | "cancelled";

export interface HydrationCallbacks {
  /** Reveal the terminal container (e.g. set visibility: visible) */
  reveal: () => void;
  /** Scroll the terminal to the bottom */
  scrollToBottom: () => void;
  /** Optionally focus the terminal */
  focus: () => void;
  /** Schedule a timeout callback. Returns an opaque handle for clearing. */
  scheduleTimeout: (fn: () => void, ms: number) => unknown;
  /** Clear a previously-scheduled timeout. */
  clearTimeout: (handle: unknown) => void;
}

export interface HydrationController {
  readonly status: HydrationStatus;
  readonly pending: boolean;
  start: () => void;
  finish: () => void;
  cancel: () => void;
}

export function createHydrationStateMachine(
  callbacks: HydrationCallbacks,
  config?: HydrationConfig
): HydrationController {
  const timeoutMs = config?.timeoutMs ?? DEFAULTS.timeoutMs;
  let _status: HydrationStatus = "idle";
  let _timerHandle: unknown = null;

  function finish() {
    if (_status !== "pending") return;
    _status = "finished";
    if (_timerHandle != null) {
      callbacks.clearTimeout(_timerHandle);
      _timerHandle = null;
    }
    callbacks.reveal();
    callbacks.scrollToBottom();
    callbacks.focus();
  }

  function start() {
    if (_status !== "idle") return;
    _status = "pending";
    if (_timerHandle != null) callbacks.clearTimeout(_timerHandle);
    _timerHandle = callbacks.scheduleTimeout(finish, timeoutMs);
  }

  function cancel() {
    if (_status !== "pending") return;
    _status = "cancelled";
    if (_timerHandle != null) {
      callbacks.clearTimeout(_timerHandle);
      _timerHandle = null;
    }
  }

  return {
    get status() { return _status; },
    get pending() { return _status === "pending"; },
    start,
    finish,
    cancel,
  };
}
