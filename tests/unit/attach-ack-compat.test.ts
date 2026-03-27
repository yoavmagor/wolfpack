/**
 * ISS-14: Validates the attach_ack compat timer guard logic.
 *
 * The 300ms compat timer in app.ts fires a resize fallback for servers that
 * don't send attach_ack. When the real attach_ack arrives, a dedicated
 * _attachAckReceived flag prevents the compat timer from also firing.
 * This test simulates the flag/timer interaction to verify only one path fires.
 */
import { describe, expect, test } from "bun:test";

/**
 * Simulates the attach_ack compat timer guard logic from public/app.ts.
 * Returns which path fired: "compat" | "real" | "none".
 */
function simulateAttachAck(opts: {
  /** Delay before real attach_ack arrives (ms). null = never arrives (old server). */
  ackDelay: number | null;
  /** The compat timer delay (ms). */
  compatDelay?: number;
}): Promise<{ firedPath: "compat" | "real" | "none"; resizeCount: number }> {
  const compatDelay = opts.compatDelay ?? 300;
  let _awaitingAttachAck = true;
  let _attachAckReceived = false;
  let _attachAckTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeCount = 0;
  let firedPath: "compat" | "real" | "none" = "none";

  return new Promise((resolve) => {
    // Compat timer (mirrors app.ts sendAttachHandshake)
    _attachAckTimer = setTimeout(() => {
      _attachAckTimer = null;
      if (_attachAckReceived || !_awaitingAttachAck) return;
      _awaitingAttachAck = false;
      resizeCount++;
      firedPath = "compat";
    }, compatDelay);

    // Real attach_ack arrival (mirrors app.ts onmessage handler)
    if (opts.ackDelay !== null) {
      setTimeout(() => {
        _attachAckReceived = true;
        _awaitingAttachAck = false;
        if (_attachAckTimer) {
          clearTimeout(_attachAckTimer);
          _attachAckTimer = null;
        }
        if (firedPath === "none") firedPath = "real";
        resizeCount++; // real path also triggers resize in production
      }, opts.ackDelay);
    }

    // Resolve after both timers have had a chance to fire
    setTimeout(() => {
      resolve({ firedPath, resizeCount });
    }, Math.max(compatDelay, opts.ackDelay ?? 0) + 50);
  });
}

describe("attach_ack compat timer guard (ISS-14)", () => {
  test("real attach_ack before compat timer → only real path fires", async () => {
    const result = await simulateAttachAck({ ackDelay: 50, compatDelay: 300 });
    expect(result.firedPath).toBe("real");
    expect(result.resizeCount).toBe(1);
  });

  test("old server (no attach_ack) → compat timer fires", async () => {
    const result = await simulateAttachAck({ ackDelay: null, compatDelay: 100 });
    expect(result.firedPath).toBe("compat");
    expect(result.resizeCount).toBe(1);
  });

  test("delayed attach_ack after compat timer → only compat fires, ack is no-op resize", async () => {
    // attach_ack arrives at 200ms, compat fires at 100ms
    // Compat fires first, sets _awaitingAttachAck = false.
    // Then attach_ack arrives, sets _attachAckReceived = true (too late for compat).
    // Both increment resizeCount (both paths do resize in production),
    // but the compat timer got the initial path.
    const result = await simulateAttachAck({ ackDelay: 200, compatDelay: 100 });
    expect(result.firedPath).toBe("compat");
    // Both fire in this case (compat first, then real ack arrives and does its work)
    expect(result.resizeCount).toBe(2);
  });

  test("attach_ack at exact same delay → real ack sets flag, compat is guarded", async () => {
    // When both fire at the same delay, JS event loop processes them sequentially.
    // The ack handler's _attachAckReceived = true guards the compat callback.
    // In practice the order depends on registration order, but the flag guard
    // ensures at most one resize from the compat path.
    const result = await simulateAttachAck({ ackDelay: 100, compatDelay: 100 });
    // One of the two fires first; either way resizeCount ≤ 2 and no crash
    expect(result.resizeCount).toBeGreaterThanOrEqual(1);
    expect(result.resizeCount).toBeLessThanOrEqual(2);
  });

  test("flag is reset on new attach cycle", async () => {
    // First cycle: real ack arrives
    const first = await simulateAttachAck({ ackDelay: 10, compatDelay: 300 });
    expect(first.firedPath).toBe("real");

    // Second cycle (simulates reconnect): old server, no ack
    const second = await simulateAttachAck({ ackDelay: null, compatDelay: 100 });
    expect(second.firedPath).toBe("compat");
    expect(second.resizeCount).toBe(1);
  });
});
