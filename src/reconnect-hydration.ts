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
 * skipInitialPrefill is set (grid cells skip, desktop doesn't).
 */
export function shouldRehydrate(
  wasReconnect: boolean,
  hydrationStarted: boolean,
  skipInitialPrefill: boolean,
): boolean {
  return wasReconnect || (hydrationStarted && !skipInitialPrefill);
}
