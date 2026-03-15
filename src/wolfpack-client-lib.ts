/**
 * Barrel export for all client-side pure logic modules.
 * Bundled into public/wolfpack-lib.js for browser use.
 * Tests import from the individual modules directly.
 */
export {
  captureScrollState,
  scrollTargetAfterResize,
  serializeBufferTail,
} from "./terminal-buffer";

export {
  shouldInterceptCopy,
  encodeTerminalBinary,
} from "./terminal-input";

export {
  shouldRehydrate,
} from "./reconnect-hydration";

export {
  CLOSE_CODE_DISPLACED,
  CLOSE_CODE_SESSION_UNAVAILABLE,
  CLOSE_CODE_NORMAL,
  classifyDisconnect,
  handleViewerConflict,
  handleControlGranted,
  handleDisplaced,
  prepareAutoTakeControl,
  handleTakeControlClick,
} from "./take-control-logic";
