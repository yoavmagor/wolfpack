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
 * - skipInitialPrefill: from opts — grid cells set this to skip prefill on fresh ptyClient
 *
 * Auto-reconnect always rehydrates (wasReconnect=true).
 * Manual retry (new ptyClient, hydrationStarted=true) rehydrates unless
 * prefill is disabled (prefillMode "none" for grid cells, "full" for desktop).
 */
export function shouldRehydrate(
  wasReconnect: boolean,
  hydrationStarted: boolean,
  prefillDisabled: boolean,
): boolean {
  return wasReconnect || (hydrationStarted && !prefillDisabled);
}
