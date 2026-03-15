/**
 * Reconnect hydration logic — tests the production shouldRehydrate function
 * that determines whether to clear terminal content and restart hydration
 * when a WebSocket connection opens.
 */
import { describe, expect, test } from "bun:test";
import { shouldRehydrate } from "../../src/reconnect-hydration";

// ── shouldRehydrate decision tests ──

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

// ── Stateful prefill lifecycle simulation ──
// These tests verify the expected behavior across the full lifecycle
// of a controller using shouldRehydrate as the decision function.

describe("reconnect hydration: prefill lifecycle across connects", () => {
  test("full lifecycle: desktop auto-reconnect clears + rehydrates each time", () => {
    let hydrationStarted = false;
    const skipInitialPrefill = false;

    // First connect
    expect(shouldRehydrate(false, hydrationStarted, skipInitialPrefill)).toBe(false);
    hydrationStarted = true;

    // Auto-reconnect #1
    expect(shouldRehydrate(true, hydrationStarted, skipInitialPrefill)).toBe(true);

    // Auto-reconnect #2
    expect(shouldRehydrate(true, hydrationStarted, skipInitialPrefill)).toBe(true);
  });

  test("full lifecycle: grid auto-reconnect clears despite skipInitialPrefill", () => {
    let hydrationStarted = false;
    const skipInitialPrefill = true;

    // First connect
    expect(shouldRehydrate(false, hydrationStarted, skipInitialPrefill)).toBe(false);
    hydrationStarted = true;

    // Auto-reconnect (wasReconnect=true overrides skipInitialPrefill)
    expect(shouldRehydrate(true, hydrationStarted, skipInitialPrefill)).toBe(true);
  });

  test("full lifecycle: grid manual retry does NOT clear (skipInitialPrefill)", () => {
    const hydrationStarted = true;
    const skipInitialPrefill = true;

    // Manual retry (new ptyClient, wasReconnect=false)
    expect(shouldRehydrate(false, hydrationStarted, skipInitialPrefill)).toBe(false);
  });
});

// ── Rehydration action simulation ──
// Simulates the sequence of actions taken in createPtyTerminalController's
// onOpen callback based on shouldRehydrate's decision.

describe("reconnect hydration: rehydration actions", () => {
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
