import { describe, it, expect } from "bun:test";
import {
  createHydrationStateMachine,
  DEFAULTS,
  type HydrationCallbacks,
} from "../../src/hydration-logic";

/** Create mock callbacks that record calls. */
function makeMocks() {
  const calls: string[] = [];
  let timerId = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();

  const callbacks: HydrationCallbacks = {
    reveal: () => calls.push("reveal"),
    scrollToBottom: () => calls.push("scrollToBottom"),
    focus: () => calls.push("focus"),
    scheduleTimeout: (fn, ms) => {
      const id = ++timerId;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };

  return {
    callbacks,
    calls,
    timers,
    /** Fire the timeout for a given handle */
    fireTimer(handle: number) {
      const t = timers.get(handle);
      if (t) {
        timers.delete(handle);
        t.fn();
      }
    },
    /** Fire the most recently scheduled timer */
    fireLatestTimer() {
      const lastKey = [...timers.keys()].pop();
      if (lastKey != null) this.fireTimer(lastKey);
    },
  };
}

describe("createHydrationStateMachine", () => {
  describe("initial state", () => {
    it("starts in idle status", () => {
      const { callbacks } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      expect(sm.status).toBe("idle");
      expect(sm.pending).toBe(false);
    });
  });

  describe("pending transitions", () => {
    it("start() transitions idle → pending", () => {
      const { callbacks } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      expect(sm.status).toBe("pending");
      expect(sm.pending).toBe(true);
    });

    it("start() is a no-op if already pending", () => {
      const { callbacks, timers } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      const timerCount = timers.size;
      sm.start(); // second call
      expect(timers.size).toBe(timerCount); // no extra timer
      expect(sm.status).toBe("pending");
    });

    it("start() is a no-op after finish", () => {
      const { callbacks } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      sm.finish();
      sm.start(); // should not go back to pending
      expect(sm.status).toBe("finished");
    });

    it("start() is a no-op after cancel", () => {
      const { callbacks } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      sm.cancel();
      sm.start();
      expect(sm.status).toBe("cancelled");
    });

    it("finish() transitions pending → finished", () => {
      const { callbacks } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      sm.finish();
      expect(sm.status).toBe("finished");
      expect(sm.pending).toBe(false);
    });

    it("finish() is a no-op from idle", () => {
      const { callbacks, calls } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.finish();
      expect(sm.status).toBe("idle");
      expect(calls).toEqual([]);
    });

    it("finish() is a no-op if already finished (idempotent)", () => {
      const { callbacks, calls } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      sm.finish();
      const callCount = calls.length;
      sm.finish(); // second finish
      expect(calls.length).toBe(callCount); // no additional side effects
    });
  });

  describe("finish triggers scroll (opens-at-bottom invariant)", () => {
    it("calls scrollToBottom before focus on finish", () => {
      const { callbacks, calls } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      sm.finish();
      expect(calls).toEqual(["reveal", "scrollToBottom", "focus"]);
    });

    it("scrollToBottom is called on timeout-triggered finish too", () => {
      const m = makeMocks();
      const sm = createHydrationStateMachine(m.callbacks);
      sm.start();
      m.fireLatestTimer(); // simulate timeout
      expect(m.calls).toContain("scrollToBottom");
      expect(m.calls.indexOf("scrollToBottom")).toBeLessThan(
        m.calls.indexOf("focus")
      );
    });

    it("reveal is called before scrollToBottom", () => {
      const { callbacks, calls } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      sm.finish();
      expect(calls.indexOf("reveal")).toBeLessThan(
        calls.indexOf("scrollToBottom")
      );
    });
  });

  describe("timeout fallback", () => {
    it("schedules a timeout on start()", () => {
      const { callbacks, timers } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      expect(timers.size).toBe(1);
    });

    it("uses default timeout of 1000ms", () => {
      const { callbacks, timers } = makeMocks();
      createHydrationStateMachine(callbacks).start();
      const [entry] = [...timers.values()];
      expect(entry.ms).toBe(DEFAULTS.timeoutMs);
      expect(entry.ms).toBe(1000);
    });

    it("respects custom timeoutMs", () => {
      const { callbacks, timers } = makeMocks();
      createHydrationStateMachine(callbacks, { timeoutMs: 500 }).start();
      const [entry] = [...timers.values()];
      expect(entry.ms).toBe(500);
    });

    it("timeout fires finish() and transitions to finished", () => {
      const m = makeMocks();
      const sm = createHydrationStateMachine(m.callbacks);
      sm.start();
      expect(sm.status).toBe("pending");
      m.fireLatestTimer();
      expect(sm.status).toBe("finished");
      expect(m.calls).toEqual(["reveal", "scrollToBottom", "focus"]);
    });

    it("clears timeout when finish() is called before timeout", () => {
      const { callbacks, timers } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      expect(timers.size).toBe(1);
      sm.finish();
      expect(timers.size).toBe(0);
    });
  });

  describe("cancel", () => {
    it("cancel() transitions pending → cancelled", () => {
      const { callbacks } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      sm.cancel();
      expect(sm.status).toBe("cancelled");
      expect(sm.pending).toBe(false);
    });

    it("cancel() clears the timeout timer", () => {
      const { callbacks, timers } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      expect(timers.size).toBe(1);
      sm.cancel();
      expect(timers.size).toBe(0);
    });

    it("cancel() does NOT call reveal/scroll/focus", () => {
      const { callbacks, calls } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      sm.cancel();
      expect(calls).toEqual([]);
    });

    it("cancel() is a no-op from idle", () => {
      const { callbacks } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.cancel();
      expect(sm.status).toBe("idle"); // stays idle, not cancelled
    });

    it("cancel() is a no-op after finish", () => {
      const { callbacks } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      sm.finish();
      sm.cancel(); // should not change status
      expect(sm.status).toBe("finished");
    });

    it("finish() is a no-op after cancel", () => {
      const { callbacks, calls } = makeMocks();
      const sm = createHydrationStateMachine(callbacks);
      sm.start();
      sm.cancel();
      calls.length = 0; // reset
      sm.finish();
      expect(sm.status).toBe("cancelled");
      expect(calls).toEqual([]); // no side effects
    });
  });
});
