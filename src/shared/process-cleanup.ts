/**
 * Process tree cleanup utilities.
 * Sends SIGTERM, polls for exit, escalates to SIGKILL.
 */

const POLL_INTERVAL_MS = 200;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process and its group. SIGTERM first, SIGKILL after timeout.
 * Resolves once the process is confirmed dead (or timeout+SIGKILL).
 */
export async function killProcessTree(
  pid: number,
  timeoutMs = 5000,
): Promise<void> {
  // Send SIGTERM to process group and individual pid
  try { process.kill(-pid, "SIGTERM"); } catch (err: any) { console.warn(`killProcessTree: SIGTERM to group -${pid} failed:`, err?.message); }
  try { process.kill(pid, "SIGTERM"); } catch (err: any) { console.warn(`killProcessTree: SIGTERM to pid ${pid} failed:`, err?.message); }

  // Poll until dead or timeout
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Escalate to SIGKILL
  try { process.kill(-pid, "SIGKILL"); } catch (err: any) { console.warn(`killProcessTree: SIGKILL to group -${pid} failed:`, err?.message); }
  try { process.kill(pid, "SIGKILL"); } catch (err: any) { console.warn(`killProcessTree: SIGKILL to pid ${pid} failed:`, err?.message); }

  // Brief wait for SIGKILL to take effect
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}
