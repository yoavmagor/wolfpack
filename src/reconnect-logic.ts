/**
 * Reconnect backoff logic extracted from the frontend WebSocket clients.
 * Pure state machine — no timers, no side effects. Caller drives scheduling.
 */

export interface ReconnectConfig {
  baseDelayMs?: number;
  maxDelayMs?: number;
  budgetMs?: number;
  backoffFactor?: number;
  maxJitterMs?: number;
}

export interface ReconnectState {
  delay: number;
  startedAt: number;
  blocked: boolean;
}

export const DEFAULTS = {
  baseDelayMs: 500,
  maxDelayMs: 5000,
  budgetMs: 2 * 60 * 1000,
  backoffFactor: 1.8,
  maxJitterMs: 200,
} as const;

export interface ReconnectSchedule {
  delayMs: number;
  exhausted: false;
}

export interface ReconnectExhausted {
  delayMs: 0;
  exhausted: true;
}

export type ScheduleResult = ReconnectSchedule | ReconnectExhausted;

export function createReconnectBackoff(config: ReconnectConfig = {}) {
  const cfg = { ...DEFAULTS, ...config };

  let delay = cfg.baseDelayMs;
  let startedAt = -1;
  let blocked = false;

  /**
   * Compute next reconnect delay. Returns `exhausted: true` if budget is spent.
   * @param now - current timestamp (ms)
   * @param jitter - random value in [0, 1) for deterministic testing
   */
  function next(now: number, jitter: number = Math.random()): ScheduleResult {
    if (blocked) return { delayMs: 0, exhausted: true };

    if (startedAt < 0) startedAt = now;
    const elapsed = now - startedAt;
    const remaining = cfg.budgetMs - elapsed;

    if (remaining <= 0) {
      blocked = true;
      return { delayMs: 0, exhausted: true };
    }

    const jitterMs = Math.floor(jitter * cfg.maxJitterMs);
    const delayMs = Math.min(delay + jitterMs, cfg.maxDelayMs, remaining);

    // advance for next call
    delay = Math.min(Math.floor(delay * cfg.backoffFactor), cfg.maxDelayMs);

    return { delayMs, exhausted: false };
  }

  /** Called on successful connection — resets backoff state. */
  function reset() {
    delay = cfg.baseDelayMs;
    startedAt = -1;
    blocked = false;
  }

  /** Block further retries (e.g. on intentional close). */
  function block() {
    blocked = true;
  }

  /** Unblock and reset (e.g. user navigates back to session). */
  function unblock() {
    blocked = false;
    startedAt = -1;
    delay = cfg.baseDelayMs;
  }

  function getState(): ReconnectState {
    return { delay, startedAt, blocked };
  }

  return { next, reset, block, unblock, getState };
}
