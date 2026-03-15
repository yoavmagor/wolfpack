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
