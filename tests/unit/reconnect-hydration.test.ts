/**
 * Reconnect hydration logic — verifies that WebSocket reconnection properly
 * clears stale terminal content and restarts hydration with server prefill.
 *
 * Tests the two key decisions extracted from index.html:
 * 1. shouldRehydrate: whether to clear terminal + restart hydration on (re)connect
 * 2. skipPrefill: whether to request server scrollback prefill on attach
 *
 * These functions mirror the exact logic in createPtyTerminalController and
 * createPtySocketClient respectively.
 */
import { describe, expect, test } from "bun:test";

// ── Extracted logic from createPtyTerminalController onOpen (index.html) ──

/**
 * Determines if terminal should be cleared and hydration restarted on WS open.
 *
 * - wasReconnect: true when same ptySocketClient reconnects (auto-reconnect)
 * - hydrationStarted: true after first connect (tracks controller lifetime)
 * - skipInitialPrefill: from opts — grid cells set this to skip prefill on fresh ptyClient
 *
 * Auto-reconnect always gets prefill (wasReconnect=true → rehydrate).
 * Manual retry (new ptyClient, hydrationStarted=true) gets prefill unless
 * skipInitialPrefill is set (grid cells skip, desktop doesn't).
 */
function shouldRehydrate(
  wasReconnect: boolean,
  hydrationStarted: boolean,
  skipInitialPrefill: boolean,
): boolean {
  return wasReconnect || (hydrationStarted && !skipInitialPrefill);
}

// ── Extracted logic from createPtySocketClient sendAttachHandshake (index.html) ──

/**
 * Determines if prefill should be skipped in the attach handshake.
 * After removing the wasReconnect→skipPrefill behavior, only the
 * skipInitialPrefill opt (consumed once on first attach) controls this.
 */
function computeSkipPrefill(skipInitialPrefill: boolean): boolean {
  return skipInitialPrefill;
}

// ── shouldRehydrate tests ──

describe("reconnect hydration: shouldRehydrate decision", () => {
  test("first connect (no prior hydration) → false", () => {
    expect(shouldRehydrate(false, false, false)).toBe(false);
  });

  test("first connect with skipInitialPrefill → false", () => {
    expect(shouldRehydrate(false, false, true)).toBe(false);
  });

  test("auto-reconnect (same ptyClient) → true", () => {
    expect(shouldRehydrate(true, true, false)).toBe(true);
  });

  test("auto-reconnect on grid cell (skipInitialPrefill) → true", () => {
    // Auto-reconnect always rehydrates, even for grid cells.
    // skipInitialPrefill was consumed on first connect; auto-reconnect
    // uses the same ptyClient where it's already false.
    expect(shouldRehydrate(true, true, true)).toBe(true);
  });

  test("auto-reconnect before hydration started (edge case) → true", () => {
    // wasReconnect alone is sufficient
    expect(shouldRehydrate(true, false, false)).toBe(true);
  });

  test("manual retry on desktop terminal → true", () => {
    // New ptyClient (wasReconnect=false), but hydration already started
    // and skipInitialPrefill is not set → rehydrate with prefill
    expect(shouldRehydrate(false, true, false)).toBe(true);
  });

  test("manual retry on grid cell (skipInitialPrefill) → false", () => {
    // New ptyClient, hydration started, but skipInitialPrefill prevents
    // prefill on fresh ptyClient → don't clear terminal
    expect(shouldRehydrate(false, true, true)).toBe(false);
  });
});

// ── skipPrefill tests ──

describe("reconnect hydration: skipPrefill on attach", () => {
  test("default (no skip) → false", () => {
    expect(computeSkipPrefill(false)).toBe(false);
  });

  test("skipInitialPrefill set → true", () => {
    expect(computeSkipPrefill(true)).toBe(true);
  });
});

// ── Stateful prefill lifecycle simulation ──

describe("reconnect hydration: prefill lifecycle across connects", () => {
  /**
   * Simulates the stateful skipPrefill behavior across multiple connections
   * on the same ptySocketClient (auto-reconnect path).
   */
  function createPrefillTracker(initialSkip: boolean) {
    let skipInitialPrefill = initialSkip;
    return {
      /** Returns skipPrefill for current attach, then consumes the flag. */
      attach(): boolean {
        const skip = skipInitialPrefill;
        skipInitialPrefill = false;
        return skip;
      },
    };
  }

  test("desktop: first connect gets prefill, reconnect gets prefill", () => {
    const tracker = createPrefillTracker(false);
    expect(tracker.attach()).toBe(false);  // first connect → prefill
    expect(tracker.attach()).toBe(false);  // reconnect → prefill
    expect(tracker.attach()).toBe(false);  // reconnect again → still prefill
  });

  test("grid: first connect skips prefill, reconnect gets prefill", () => {
    const tracker = createPrefillTracker(true);
    expect(tracker.attach()).toBe(true);   // first connect → skip (grid opt)
    expect(tracker.attach()).toBe(false);  // reconnect → prefill (flag consumed)
    expect(tracker.attach()).toBe(false);  // reconnect again → still prefill
  });

  /**
   * Simulates the full reconnect hydration decision across the lifecycle
   * of a controller with auto-reconnects.
   */
  test("full lifecycle: desktop auto-reconnect clears + rehydrates each time", () => {
    let hydrationStarted = false;
    const skipInitialPrefill = false;

    // First connect
    const firstConnect = shouldRehydrate(false, hydrationStarted, skipInitialPrefill);
    expect(firstConnect).toBe(false); // don't clear on first connect
    hydrationStarted = true;

    // Auto-reconnect #1
    const reconnect1 = shouldRehydrate(true, hydrationStarted, skipInitialPrefill);
    expect(reconnect1).toBe(true); // clear + rehydrate

    // Auto-reconnect #2
    const reconnect2 = shouldRehydrate(true, hydrationStarted, skipInitialPrefill);
    expect(reconnect2).toBe(true); // still clears
  });

  test("full lifecycle: grid auto-reconnect clears despite skipInitialPrefill", () => {
    let hydrationStarted = false;
    const skipInitialPrefill = true;

    // First connect
    const firstConnect = shouldRehydrate(false, hydrationStarted, skipInitialPrefill);
    expect(firstConnect).toBe(false);
    hydrationStarted = true;

    // Auto-reconnect (wasReconnect=true overrides skipInitialPrefill)
    const reconnect1 = shouldRehydrate(true, hydrationStarted, skipInitialPrefill);
    expect(reconnect1).toBe(true);
  });

  test("full lifecycle: grid manual retry does NOT clear (skipInitialPrefill)", () => {
    let hydrationStarted = false;
    const skipInitialPrefill = true;

    // First connect
    hydrationStarted = true;

    // Manual retry (new ptyClient, wasReconnect=false)
    const retry = shouldRehydrate(false, hydrationStarted, skipInitialPrefill);
    expect(retry).toBe(false); // grid: don't clear, no prefill coming
  });
});

// ── Rehydration action simulation ──

describe("reconnect hydration: rehydration actions", () => {
  /** Simulate the rehydration sequence from createPtyTerminalController onOpen. */
  function simulateRehydration(opts: {
    wasReconnect: boolean;
    hydrationStarted: boolean;
    skipInitialPrefill: boolean;
    hasTerm: boolean;
    hasHydration: boolean;
    hasElement: boolean;
  }) {
    const actions: string[] = [];
    const rehydrate = shouldRehydrate(opts.wasReconnect, opts.hydrationStarted, opts.skipInitialPrefill);
    if (rehydrate && opts.hasTerm) {
      actions.push("term.reset");
      actions.push("counters.reset");
      if (opts.hasHydration) actions.push("hydration.start");
      if (opts.hasElement) {
        actions.push("css.hydrating");
        actions.push("css.remove-hydrated");
      }
    }
    return actions;
  }

  test("auto-reconnect with all components → full rehydration", () => {
    const actions = simulateRehydration({
      wasReconnect: true,
      hydrationStarted: true,
      skipInitialPrefill: false,
      hasTerm: true,
      hasHydration: true,
      hasElement: true,
    });
    expect(actions).toEqual([
      "term.reset",
      "counters.reset",
      "hydration.start",
      "css.hydrating",
      "css.remove-hydrated",
    ]);
  });

  test("first connect → no rehydration actions", () => {
    const actions = simulateRehydration({
      wasReconnect: false,
      hydrationStarted: false,
      skipInitialPrefill: false,
      hasTerm: true,
      hasHydration: true,
      hasElement: true,
    });
    expect(actions).toEqual([]);
  });

  test("reconnect without terminal → no actions (disposed)", () => {
    const actions = simulateRehydration({
      wasReconnect: true,
      hydrationStarted: true,
      skipInitialPrefill: false,
      hasTerm: false,
      hasHydration: true,
      hasElement: true,
    });
    expect(actions).toEqual([]);
  });

  test("reconnect without hydration controller → skip hydration.start", () => {
    const actions = simulateRehydration({
      wasReconnect: true,
      hydrationStarted: true,
      skipInitialPrefill: false,
      hasTerm: true,
      hasHydration: false,
      hasElement: true,
    });
    expect(actions).toEqual([
      "term.reset",
      "counters.reset",
      "css.hydrating",
      "css.remove-hydrated",
    ]);
  });

  test("reconnect without element → skip CSS changes", () => {
    const actions = simulateRehydration({
      wasReconnect: true,
      hydrationStarted: true,
      skipInitialPrefill: false,
      hasTerm: true,
      hasHydration: true,
      hasElement: false,
    });
    expect(actions).toEqual([
      "term.reset",
      "counters.reset",
      "hydration.start",
    ]);
  });

  test("grid manual retry → no rehydration", () => {
    const actions = simulateRehydration({
      wasReconnect: false,
      hydrationStarted: true,
      skipInitialPrefill: true,
      hasTerm: true,
      hasHydration: true,
      hasElement: true,
    });
    expect(actions).toEqual([]);
  });

  test("desktop manual retry → full rehydration", () => {
    const actions = simulateRehydration({
      wasReconnect: false,
      hydrationStarted: true,
      skipInitialPrefill: false,
      hasTerm: true,
      hasHydration: true,
      hasElement: true,
    });
    expect(actions).toEqual([
      "term.reset",
      "counters.reset",
      "hydration.start",
      "css.hydrating",
      "css.remove-hydrated",
    ]);
  });
});
