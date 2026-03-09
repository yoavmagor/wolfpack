/**
 * Two-pass grid relayout transition runner.
 * Pure control-flow helper: caller injects frame scheduling and side effects.
 */

export interface GridRelayoutTransitionCallbacks {
  setLoading: (loading: boolean) => void;
  scheduleFrame: (cb: () => void) => unknown;
  cancelFrame: (handle: unknown) => void;
}

export interface GridRelayoutTransitionRunner {
  readonly transitionId: number;
  readonly loading: boolean;
  run: (primaryPass: () => void, secondaryPass?: () => void) => number;
  cancel: () => void;
}

export function createGridRelayoutTransitionRunner(
  callbacks: GridRelayoutTransitionCallbacks
): GridRelayoutTransitionRunner {
  let _transitionId = 0;
  let _loading = false;
  let _firstFrameHandle: unknown = null;
  let _secondFrameHandle: unknown = null;

  function clearPendingFrames() {
    if (_firstFrameHandle != null) {
      callbacks.cancelFrame(_firstFrameHandle);
      _firstFrameHandle = null;
    }
    if (_secondFrameHandle != null) {
      callbacks.cancelFrame(_secondFrameHandle);
      _secondFrameHandle = null;
    }
  }

  function setLoading(loading: boolean) {
    if (_loading === loading) return;
    _loading = loading;
    callbacks.setLoading(loading);
  }

  function run(primaryPass: () => void, secondaryPass: () => void = () => {}) {
    _transitionId += 1;
    const runId = _transitionId;
    clearPendingFrames();
    setLoading(true);

    _firstFrameHandle = callbacks.scheduleFrame(() => {
      _firstFrameHandle = null;
      if (runId !== _transitionId) return;

      try {
        primaryPass();
      } catch {}

      _secondFrameHandle = callbacks.scheduleFrame(() => {
        _secondFrameHandle = null;
        if (runId !== _transitionId) return;
        try {
          secondaryPass();
        } catch {}
        setLoading(false);
      });
    });

    return runId;
  }

  function cancel() {
    _transitionId += 1;
    clearPendingFrames();
    setLoading(false);
  }

  return {
    get transitionId() { return _transitionId; },
    get loading() { return _loading; },
    run,
    cancel,
  };
}

