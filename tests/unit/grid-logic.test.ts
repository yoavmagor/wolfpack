import { describe, test, expect } from "bun:test";
import {
  MAX_GRID_CELLS,
  gridLayoutClass,
  isGridActive,
  addToGridState,
  removeFromGridState,
  gridTemplate,
  gridArrowNav,
  type GridSession,
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

  test("focus stays if removing before focus", () => {
    const result = removeFromGridState(three, 0, 2);
    // focus was 2, removed index 0, so new focus should be clamped
    expect(result.focusIndex).toBe(1); // was 2, now array is length 2, so 1
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
