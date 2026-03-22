/**
 * Pure decision functions for reconnect hydration.
 * Used by both the browser frontend (via wolfpack-lib.js bundle)
 * and unit tests (via direct import).
 */

/**
 * Determine whether to clear the terminal and restart hydration on WS open.
 *
 * - wasReconnect: true when the same ptySocketClient auto-reconnects
 * - hydrationStarted: true after the controller's first connect()
 * - prefillDisabled: true when prefillMode is not "full" (e.g. "viewport" for grid cells, "none")
 *
 * Auto-reconnect always rehydrates (wasReconnect=true).
 * Manual retry (new ptyClient, hydrationStarted=true) rehydrates only when
 * prefill is "full" (desktop). Grid cells use "viewport" so prefillDisabled=true.
 */
export function shouldRehydrate(
  wasReconnect: boolean,
  hydrationStarted: boolean,
  prefillDisabled: boolean,
): boolean {
  return wasReconnect || (hydrationStarted && !prefillDisabled);
}
