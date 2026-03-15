/**
 * Pure functions for terminal input handling.
 * Used by both the browser frontend (via wolfpack-lib.js bundle)
 * and unit tests (via direct import).
 */

/**
 * Decide whether a key event should be intercepted for clipboard copy.
 * Returns true when Cmd/Ctrl+C is pressed on keydown with an active selection.
 */
export function shouldInterceptCopy(
  event: { metaKey: boolean; ctrlKey: boolean; key: string; type: string },
  hasSelection: boolean,
): boolean {
  return (event.metaKey || event.ctrlKey) && event.key === "c" && event.type === "keydown" && hasSelection;
}

/**
 * Encode a binary string (from terminal onBinary callback) to a Uint8Array.
 * Each character's code point is masked to the low byte via & 0xff.
 */
export function encodeTerminalBinary(data: string): Uint8Array {
  const buf = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i) & 0xff;
  return buf;
}
