import { describe, test, expect } from "bun:test";
import {
  MAX_GRID_CELLS,
  gridLayoutClass,
  isGridActive,
  addToGridState,
  removeFromGridState,
  gridTemplate,
  gridArrowNav,
  canAcceptInput,
  canSendResize,
  canAcceptInputDefault,
  computeInputGate,
  type GridSession,
  type InputGateState,
} from "../../src/grid-logic";

describe("gridLayoutClass", () => {
  test("returns grid-N for 2-6", () => {
    expect(gridLayoutClass(2)).toBe("grid-2");
    expect(gridLayoutClass(3)).toBe("grid-3");
    expect(gridLayoutClass(4)).toBe("grid-4");
    expect(gridLayoutClass(5)).toBe("grid-5");
    expect(gridLayoutClass(6)).toBe("grid-6");
  });

  test("falls back to grid-2 for out of range", () => {
    expect(gridLayoutClass(0)).toBe("grid-2");
    expect(gridLayoutClass(1)).toBe("grid-2");
    expect(gridLayoutClass(7)).toBe("grid-2");
  });
});

describe("isGridActive", () => {
  test("inactive with 0 or 1 sessions", () => {
    expect(isGridActive([])).toBe(false);
    expect(isGridActive([{ session: "a", machine: "" }])).toBe(false);
  });

  test("active with 2+ sessions", () => {
    expect(isGridActive([
      { session: "a", machine: "" },
      { session: "b", machine: "" },
    ])).toBe(true);
  });
});

describe("addToGridState", () => {
  test("adds session to empty grid — also adds current session", () => {
    const result = addToGridState([], "new-session", "", "current", "");
    expect(result).not.toBeNull();
    expect(result!.sessions).toHaveLength(2);
    expect(result!.sessions[0].session).toBe("current");
    expect(result!.sessions[1].session).toBe("new-session");
    expect(result!.focusIndex).toBe(1);
  });

  test("adds session to empty grid — same as current, no duplicate", () => {
    const result = addToGridState([], "current", "", "current", "");
    expect(result).not.toBeNull();
    expect(result!.sessions).toHaveLength(1);
    expect(result!.sessions[0].session).toBe("current");
  });

  test("adds session to existing grid", () => {
    const existing: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
    ];
    const result = addToGridState(existing, "c", "", "a", "");
    expect(result).not.toBeNull();
    expect(result!.sessions).toHaveLength(3);
    expect(result!.focusIndex).toBe(2);
  });

  test("rejects duplicate session", () => {
    const existing: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
    ];
    const result = addToGridState(existing, "a", "", "a", "");
    expect(result).toBeNull();
  });

  test("rejects when at max capacity", () => {
    const existing: GridSession[] = Array.from({ length: MAX_GRID_CELLS }, (_, i) => ({
      session: `s${i}`,
      machine: "",
    }));
    const result = addToGridState(existing, "overflow", "", "s0", "");
    expect(result).toBeNull();
  });

  test("distinguishes sessions by machine", () => {
    const existing: GridSession[] = [
      { session: "app", machine: "host-a" },
      { session: "app", machine: "host-b" },
    ];
    // Same session name, different machine — should be in grid
    expect(existing).toHaveLength(2);
    // Adding same session+machine — rejected
    const dup = addToGridState(existing, "app", "host-a", "app", "host-a");
    expect(dup).toBeNull();
    // Adding same session, new machine — accepted
    const ok = addToGridState(existing, "app", "host-c", "app", "host-a");
    expect(ok).not.toBeNull();
    expect(ok!.sessions).toHaveLength(3);
  });
});

describe("removeFromGridState", () => {
  const three: GridSession[] = [
    { session: "a", machine: "" },
    { session: "b", machine: "" },
    { session: "c", machine: "" },
  ];

  test("removes middle session, grid stays active", () => {
    const result = removeFromGridState(three, 1, 1);
    expect(result.exitGrid).toBe(false);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map(s => s.session)).toEqual(["a", "c"]);
  });

  test("removes last session from 2-cell grid — exits grid", () => {
    const two: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
    ];
    const result = removeFromGridState(two, 1, 1);
    expect(result.exitGrid).toBe(true);
    expect(result.restoreSession?.session).toBe("a");
    expect(result.sessions).toHaveLength(0);
  });

  test("focus adjusts when removing last cell", () => {
    const result = removeFromGridState(three, 2, 2);
    expect(result.focusIndex).toBe(1);
    expect(result.exitGrid).toBe(false);
  });

  test("focus shifts left when removing cell before focused one", () => {
    const result = removeFromGridState(three, 0, 2);
    // focus was 2, removed index 0, so focused session "c" is now at index 1
    expect(result.focusIndex).toBe(1);
    expect(result.sessions[1].session).toBe("c");
    expect(result.exitGrid).toBe(false);
  });

  test("focus stays when removing cell after focused one", () => {
    const result = removeFromGridState(three, 2, 0);
    // focus was 0, removed index 2 — focus should remain at 0
    expect(result.focusIndex).toBe(0);
    expect(result.sessions[0].session).toBe("a");
    expect(result.exitGrid).toBe(false);
  });

  test("4-cell grid: focus tracks correct session when earlier cell removed", () => {
    const four: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
      { session: "c", machine: "" },
      { session: "d", machine: "" },
    ];
    // Focus on "d" (index 3), remove "b" (index 1)
    const result = removeFromGridState(four, 1, 3);
    expect(result.focusIndex).toBe(2);
    expect(result.sessions[2].session).toBe("d");
    expect(result.exitGrid).toBe(false);
  });

  test("invalid index returns unchanged", () => {
    const result = removeFromGridState(three, -1, 0);
    expect(result.sessions).toEqual(three);
    expect(result.exitGrid).toBe(false);
  });

  test("removing from 2 → exits grid with remaining session", () => {
    const two: GridSession[] = [
      { session: "x", machine: "m1" },
      { session: "y", machine: "m2" },
    ];
    const result = removeFromGridState(two, 0, 0);
    expect(result.exitGrid).toBe(true);
    expect(result.restoreSession).toEqual({ session: "y", machine: "m2" });
  });
});

describe("gridTemplate", () => {
  test("2 cells: side-by-side", () => {
    const t = gridTemplate(2);
    expect(t.columns).toBe("1fr 1fr");
    expect(t.rows).toBe("1fr");
  });

  test("4 cells: 2x2", () => {
    const t = gridTemplate(4);
    expect(t.columns).toBe("1fr 1fr");
    expect(t.rows).toBe("1fr 1fr");
  });

  test("6 cells: 3x2", () => {
    const t = gridTemplate(6);
    expect(t.columns).toBe("1fr 1fr 1fr");
    expect(t.rows).toBe("1fr 1fr");
  });
});

describe("gridArrowNav", () => {
  test("2 cells: left/right navigation", () => {
    expect(gridArrowNav("right", 0, 2)).toBe(1);
    expect(gridArrowNav("left", 1, 2)).toBe(0);
    // boundary: can't go past edges
    expect(gridArrowNav("left", 0, 2)).toBe(0);
    expect(gridArrowNav("right", 1, 2)).toBe(1);
  });

  test("2 cells: up/down does nothing (single row)", () => {
    expect(gridArrowNav("up", 0, 2)).toBe(0);
    expect(gridArrowNav("down", 0, 2)).toBe(0);
    expect(gridArrowNav("down", 1, 2)).toBe(1);
  });

  test("4 cells (2x2): full navigation", () => {
    // Layout: [0][1]
    //         [2][3]
    expect(gridArrowNav("right", 0, 4)).toBe(1);
    expect(gridArrowNav("down", 0, 4)).toBe(2);
    expect(gridArrowNav("down", 1, 4)).toBe(3);
    expect(gridArrowNav("up", 2, 4)).toBe(0);
    expect(gridArrowNav("up", 3, 4)).toBe(1);
    expect(gridArrowNav("left", 3, 4)).toBe(2);
  });

  test("6 cells (3x2): navigation", () => {
    // Layout: [0][1][2]
    //         [3][4][5]
    expect(gridArrowNav("right", 0, 6)).toBe(1);
    expect(gridArrowNav("right", 1, 6)).toBe(2);
    expect(gridArrowNav("down", 0, 6)).toBe(3);
    expect(gridArrowNav("up", 5, 6)).toBe(2);
    expect(gridArrowNav("left", 3, 6)).toBe(2);
  });

  test("single cell: no movement", () => {
    expect(gridArrowNav("left", 0, 1)).toBe(0);
    expect(gridArrowNav("right", 0, 1)).toBe(0);
  });

  test("3 cells (2+1 layout): nav wraps correctly", () => {
    // Layout: [0][1]
    //         [ 2  ] (spanning)
    // With cols=2: down from 0→2, down from 1→stays (index 3 OOB)
    expect(gridArrowNav("down", 0, 3)).toBe(2);
    expect(gridArrowNav("down", 1, 3)).toBe(1); // 1+2=3, OOB
    expect(gridArrowNav("up", 2, 3)).toBe(0);
  });
});

// ─── Input-Gating Logic ───────────────────────────────────────────

describe("canAcceptInput", () => {
  test("accepts when controller exists, connected, and focused", () => {
    expect(canAcceptInput({ hasController: true, isConnected: true, isFocused: true })).toBe(true);
  });

  test("rejects when no controller", () => {
    expect(canAcceptInput({ hasController: false, isConnected: true, isFocused: true })).toBe(false);
  });

  test("rejects when not connected", () => {
    expect(canAcceptInput({ hasController: true, isConnected: false, isFocused: true })).toBe(false);
  });

  test("rejects when not focused", () => {
    expect(canAcceptInput({ hasController: true, isConnected: true, isFocused: false })).toBe(false);
  });

  test("rejects when all false", () => {
    expect(canAcceptInput({ hasController: false, isConnected: false, isFocused: false })).toBe(false);
  });

  test("rejects when connected but no controller and not focused", () => {
    expect(canAcceptInput({ hasController: false, isConnected: true, isFocused: false })).toBe(false);
  });
});

describe("canSendResize", () => {
  test("allows when connected with controller, regardless of focus", () => {
    expect(canSendResize({ hasController: true, isConnected: true, isFocused: false })).toBe(true);
    expect(canSendResize({ hasController: true, isConnected: true, isFocused: true })).toBe(true);
  });

  test("rejects when not connected", () => {
    expect(canSendResize({ hasController: true, isConnected: false, isFocused: true })).toBe(false);
  });

  test("rejects when no controller", () => {
    expect(canSendResize({ hasController: false, isConnected: true, isFocused: true })).toBe(false);
  });
});

describe("canAcceptInputDefault (non-grid / single terminal)", () => {
  test("accepts when pty client exists and socket is open", () => {
    expect(canAcceptInputDefault(true, true)).toBe(true);
  });

  test("rejects when no pty client", () => {
    expect(canAcceptInputDefault(false, true)).toBe(false);
  });

  test("rejects when socket is closed", () => {
    expect(canAcceptInputDefault(true, false)).toBe(false);
  });

  test("rejects when both missing", () => {
    expect(canAcceptInputDefault(false, false)).toBe(false);
  });
});

describe("computeInputGate", () => {
  const sessions: GridSession[] = [
    { session: "a", machine: "" },
    { session: "b", machine: "" },
    { session: "c", machine: "" },
  ];

  test("focused cell gets isFocused=true", () => {
    const gate = computeInputGate(sessions, 1, 1, true);
    expect(gate).toEqual({ hasController: true, isConnected: true, isFocused: true });
  });

  test("unfocused cell gets isFocused=false", () => {
    const gate = computeInputGate(sessions, 0, 2, true);
    expect(gate).toEqual({ hasController: true, isConnected: true, isFocused: false });
  });

  test("disconnected cell", () => {
    const gate = computeInputGate(sessions, 1, 1, false);
    expect(gate).toEqual({ hasController: true, isConnected: false, isFocused: true });
  });

  test("out-of-bounds cellIndex is never focused", () => {
    const gate = computeInputGate(sessions, 0, 5, true);
    expect(gate.isFocused).toBe(false);
  });

  test("negative cellIndex is never focused", () => {
    const gate = computeInputGate(sessions, 0, -1, true);
    expect(gate.isFocused).toBe(false);
  });

  test("composes with canAcceptInput — focused + connected = accepts", () => {
    const gate = computeInputGate(sessions, 2, 2, true);
    expect(canAcceptInput(gate)).toBe(true);
  });

  test("composes with canAcceptInput — unfocused = rejects", () => {
    const gate = computeInputGate(sessions, 0, 2, true);
    expect(canAcceptInput(gate)).toBe(false);
  });

  test("composes with canSendResize — unfocused but connected = allows resize", () => {
    const gate = computeInputGate(sessions, 0, 2, true);
    expect(canSendResize(gate)).toBe(true);
  });

  test("composes with canSendResize — disconnected = rejects resize", () => {
    const gate = computeInputGate(sessions, 2, 2, false);
    expect(canSendResize(gate)).toBe(false);
  });
});
