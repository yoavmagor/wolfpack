/**
 * Pure functions for terminal buffer operations.
 * Extracted from public/index.html so the scroll-position and serialization
 * logic can be unit-tested against the buffer.active API contract.
 */

/** The subset of terminal.buffer.active we depend on (ghostty-web compat). */
export interface TerminalBuffer {
  readonly viewportY: number;
  readonly baseY: number;
  readonly length: number;
  getLine(index: number): { translateToString(trimRight: boolean): string } | null;
}

/**
 * Capture scroll state before a resize/fit.
 * Used by fitTerminalPreserveScroll() to decide whether to restore position.
 */
export function captureScrollState(buffer: TerminalBuffer) {
  return {
    wasAtBottom: buffer.viewportY >= buffer.baseY,
    distanceFromBottom: Math.max(0, buffer.baseY - buffer.viewportY),
  };
}

/**
 * Compute the line to scroll to after a resize, preserving the user's
 * relative position from the bottom of the scrollback.
 */
export function scrollTargetAfterResize(nextBaseY: number, distanceFromBottom: number): number {
  return Math.max(0, nextBaseY - distanceFromBottom);
}

/**
 * Serialize the last N lines from a terminal buffer into a string.
 * Used for snapshot persistence.
 */
export function serializeBufferTail(buffer: TerminalBuffer, maxLines: number): string {
  const start = Math.max(0, buffer.length - maxLines);
  const lines: string[] = [];
  for (let i = start; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}
