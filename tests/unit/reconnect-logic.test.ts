import { describe, expect, test } from "bun:test";
import { createReconnectBackoff, DEFAULTS } from "../../src/reconnect-logic";

describe("createReconnectBackoff", () => {
  describe("exponential backoff", () => {
    test("first delay equals base delay (zero jitter)", () => {
      const b = createReconnectBackoff();
      const r = b.next(1000, 0);
      expect(r.exhausted).toBe(false);
      expect(r.delayMs).toBe(DEFAULTS.baseDelayMs);
    });

    test("delays increase by backoff factor", () => {
      const b = createReconnectBackoff({ baseDelayMs: 100, backoffFactor: 2, maxDelayMs: 10000 });
      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = b.next(1000, 0); // same timestamp, budget not relevant here
        if (r.exhausted) break;
        delays.push(r.delayMs);
      }
      // base=100, then 200, 400, 800, 1600
      expect(delays).toEqual([100, 200, 400, 800, 1600]);
    });

    test("delay is capped at maxDelayMs", () => {
      const b = createReconnectBackoff({ baseDelayMs: 1000, backoffFactor: 10, maxDelayMs: 3000 });
      b.next(0, 0); // 1000, advances to 10000→capped at 3000
      const r = b.next(0, 0);
      expect(r.exhausted).toBe(false);
      expect(r.delayMs).toBe(3000);
    });

    test("jitter adds proportional randomness", () => {
      const b = createReconnectBackoff({ baseDelayMs: 500, maxJitterMs: 200 });
      const r = b.next(1000, 0.5); // jitter = 100ms
      expect(r.delayMs).toBe(600);
    });

    test("jitter=1 adds full maxJitterMs (floored)", () => {
      const b = createReconnectBackoff({ baseDelayMs: 500, maxJitterMs: 200 });
      // jitter just under 1.0
      const r = b.next(1000, 0.999);
      expect(r.delayMs).toBe(500 + Math.floor(0.999 * 200));
    });
  });

  describe("budget exhaustion", () => {
    test("returns exhausted when budget is spent", () => {
      const b = createReconnectBackoff({ budgetMs: 1000 });
      // first call sets startedAt=0
      const r1 = b.next(0, 0);
      expect(r1.exhausted).toBe(false);

      // 1001ms later — budget exceeded
      const r2 = b.next(1001, 0);
      expect(r2.exhausted).toBe(true);
      expect(r2.delayMs).toBe(0);
    });

    test("delay is clamped to remaining budget", () => {
      const b = createReconnectBackoff({ budgetMs: 1000, baseDelayMs: 800 });
      b.next(0, 0); // starts at t=0, delay=800
      // at t=500, remaining=500, next delay would be floor(800*1.8)=1440 but clamped to 500
      const r = b.next(500, 0);
      expect(r.exhausted).toBe(false);
      expect(r.delayMs).toBe(500);
    });

    test("once exhausted, stays exhausted", () => {
      const b = createReconnectBackoff({ budgetMs: 0 });
      const r1 = b.next(0, 0);
      expect(r1.exhausted).toBe(true);
      const r2 = b.next(0, 0);
      expect(r2.exhausted).toBe(true);
    });
  });

  describe("retry blocking", () => {
    test("block() prevents further retries", () => {
      const b = createReconnectBackoff();
      b.next(0, 0); // normal
      b.block();
      const r = b.next(0, 0);
      expect(r.exhausted).toBe(true);
    });

    test("block + unblock allows retries again", () => {
      const b = createReconnectBackoff();
      b.block();
      expect(b.next(0, 0).exhausted).toBe(true);

      b.unblock();
      const r = b.next(1000, 0);
      expect(r.exhausted).toBe(false);
      expect(r.delayMs).toBe(DEFAULTS.baseDelayMs);
    });

    test("unblock resets delay and startedAt", () => {
      const b = createReconnectBackoff({ baseDelayMs: 100, backoffFactor: 2 });
      b.next(0, 0); // delay advances to 200
      b.next(0, 0); // delay advances to 400
      b.block();
      b.unblock();

      const state = b.getState();
      expect(state.delay).toBe(100);
      expect(state.startedAt).toBe(-1);
      expect(state.blocked).toBe(false);
    });
  });

  describe("reset behavior", () => {
    test("reset clears delay, startedAt, and blocked", () => {
      const b = createReconnectBackoff({ baseDelayMs: 100, backoffFactor: 2, budgetMs: 5000 });
      b.next(0, 0);   // delay=100, advances to 200
      b.next(100, 0);  // delay=200, advances to 400

      b.reset();
      const state = b.getState();
      expect(state.delay).toBe(100);
      expect(state.startedAt).toBe(-1);
      expect(state.blocked).toBe(false);
    });

    test("reset after exhaustion allows retries with fresh budget", () => {
      const b = createReconnectBackoff({ budgetMs: 100 });
      b.next(0, 0);
      const r1 = b.next(200, 0);
      expect(r1.exhausted).toBe(true);

      b.reset();
      const r2 = b.next(5000, 0);
      expect(r2.exhausted).toBe(false);
    });

    test("reset restores base delay after escalation", () => {
      const b = createReconnectBackoff({ baseDelayMs: 100, backoffFactor: 2 });
      b.next(0, 0); // 100
      b.next(0, 0); // 200
      b.next(0, 0); // 400

      b.reset();
      const r = b.next(0, 0);
      expect(r.delayMs).toBe(100);
    });
  });

  describe("custom config", () => {
    test("respects all overrides", () => {
      const b = createReconnectBackoff({
        baseDelayMs: 50,
        maxDelayMs: 200,
        budgetMs: 10000,
        backoffFactor: 3,
        maxJitterMs: 0,
      });

      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = b.next(0, 0);
        if (r.exhausted) break;
        delays.push(r.delayMs);
      }
      // 50, 150, 200 (capped), 200, 200
      expect(delays).toEqual([50, 150, 200, 200, 200]);
    });
  });
});
