import { describe, expect, test } from "bun:test";
import { createGridRelayoutTransitionRunner } from "../../src/grid-relayout-logic";

function makeHarness() {
  const calls: string[] = [];
  let nextFrameId = 1;
  const frames = new Map<number, () => void>();

  const runner = createGridRelayoutTransitionRunner({
    setLoading: (loading) => {
      calls.push(loading ? "loading:on" : "loading:off");
    },
    scheduleFrame: (cb) => {
      const id = nextFrameId++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (handle) => {
      frames.delete(handle as number);
    },
  });

  function fireNextFrame() {
    const nextId = frames.keys().next().value;
    if (nextId == null) return false;
    const cb = frames.get(nextId);
    if (!cb) return false;
    frames.delete(nextId);
    cb();
    return true;
  }

  return {
    calls,
    frames,
    runner,
    fireNextFrame,
  };
}

describe("createGridRelayoutTransitionRunner", () => {
  test("run() enables loading and schedules first frame", () => {
    const h = makeHarness();

    h.runner.run(() => h.calls.push("primary"));

    expect(h.runner.loading).toBe(true);
    expect(h.calls).toEqual(["loading:on"]);
    expect(h.frames.size).toBe(1);
  });

  test("primary pass runs on first frame, secondary on second, then loading turns off", () => {
    const h = makeHarness();

    h.runner.run(
      () => h.calls.push("primary"),
      () => h.calls.push("secondary")
    );

    expect(h.fireNextFrame()).toBe(true);
    expect(h.calls).toEqual(["loading:on", "primary"]);
    expect(h.frames.size).toBe(1);

    expect(h.fireNextFrame()).toBe(true);
    expect(h.calls).toEqual(["loading:on", "primary", "secondary", "loading:off"]);
    expect(h.runner.loading).toBe(false);
    expect(h.frames.size).toBe(0);
  });

  test("new run invalidates pending older run", () => {
    const h = makeHarness();

    h.runner.run(() => h.calls.push("primary:old"));
    h.runner.run(() => h.calls.push("primary:new"));

    expect(h.frames.size).toBe(1);
    expect(h.calls).toEqual(["loading:on"]);

    expect(h.fireNextFrame()).toBe(true);
    expect(h.calls).toEqual(["loading:on", "primary:new"]);

    expect(h.fireNextFrame()).toBe(true);
    expect(h.calls).toEqual(["loading:on", "primary:new", "loading:off"]);
    expect(h.calls.includes("primary:old")).toBe(false);
  });

  test("cancel() clears pending frames and loading state", () => {
    const h = makeHarness();

    h.runner.run(() => h.calls.push("primary"));
    h.runner.cancel();

    expect(h.runner.loading).toBe(false);
    expect(h.calls).toEqual(["loading:on", "loading:off"]);
    expect(h.frames.size).toBe(0);
    expect(h.fireNextFrame()).toBe(false);
  });

  test("run() tolerates errors in primary/secondary passes", () => {
    const h = makeHarness();

    h.runner.run(
      () => {
        throw new Error("primary fail");
      },
      () => {
        h.calls.push("secondary");
        throw new Error("secondary fail");
      }
    );

    expect(h.fireNextFrame()).toBe(true);
    expect(h.fireNextFrame()).toBe(true);
    expect(h.runner.loading).toBe(false);
    expect(h.calls).toEqual(["loading:on", "secondary", "loading:off"]);
  });

  test("transitionId increments across runs and cancel", () => {
    const h = makeHarness();

    expect(h.runner.transitionId).toBe(0);
    h.runner.run(() => {});
    expect(h.runner.transitionId).toBe(1);
    h.runner.run(() => {});
    expect(h.runner.transitionId).toBe(2);
    h.runner.cancel();
    expect(h.runner.transitionId).toBe(3);
  });
});

