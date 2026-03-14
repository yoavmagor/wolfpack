/**
 * Desktop single terminal verification — ghostty-web migration phase 4.
 *
 * Tests the PTY WebSocket protocol for the desktop terminal path (/ws/pty):
 * open (attach handshake), type (binary stdin), scroll (resize), copy (client-only).
 *
 * Note: In test mode, PTY spawn fails because there's no real tmux session.
 * Tests verify the protocol behavior up to and including the spawn failure.
 * The attach_ack is sent synchronously (before async spawn), so it always arrives.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import type { AddressInfo } from "node:net";

process.env.WOLFPACK_TEST = "1";

const { server, __setTestOverrides, __getTestState } = await import("../../src/server/index.ts");
const { activePtySessions, ptySpawnAttempts } = __getTestState();

// ── Test setup ──

let port: number;
let baseWsUrl: string;

const FAKE_SESSIONS = ["desktop-test"];
__setTestOverrides({
  tmuxList: async () => [...FAKE_SESSIONS],
  capturePane: async () => "$ mock-desktop-output\n",
});

const _realConsoleError = console.error;

beforeAll((done) => {
  console.error = (...args: any[]) => {
    const msg = String(args[0] ?? "");
    if (msg.startsWith("WS error") || msg.startsWith("PTY WS error") || msg.startsWith("Route error")) return;
    _realConsoleError(...args);
  };
  server.listen(0, "127.0.0.1", () => {
    port = (server.address() as AddressInfo).port;
    baseWsUrl = `ws://127.0.0.1:${port}`;
    done();
  });
});

afterAll(() => {
  console.error = _realConsoleError;
  server.close();
});

// ── Helpers ──

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState >= WebSocket.CLOSING) return resolve();
    ws.addEventListener("close", () => resolve());
    ws.close();
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return reject(new Error("already closed"));
    const timer = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    ws.addEventListener("close", (ev) => { clearTimeout(timer); resolve(ev); });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connectPty(session: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("connect failed")));
  });
}

function collectJsonMessages(ws: WebSocket): { type: string; [k: string]: any }[] {
  const msgs: { type: string; [k: string]: any }[] = [];
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      try { msgs.push(JSON.parse(ev.data)); } catch {}
    }
  });
  return msgs;
}

function waitForMessage(ws: WebSocket, type: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const cleanup = () => { clearTimeout(timer); ws.removeEventListener("message", handler); };
    function handler(ev: MessageEvent) {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === type) { cleanup(); resolve(msg); }
        } catch {}
      }
    }
    ws.addEventListener("message", handler);
    // Also reject on close (spawn failure closes the WS)
    ws.addEventListener("close", () => { cleanup(); reject(new Error(`ws closed before ${type}`)); });
  });
}

// ── Open: attach handshake ──

describe("desktop terminal: open (attach handshake)", () => {
  beforeEach(async () => {
    activePtySessions.delete("desktop-test");
    ptySpawnAttempts.delete("desktop-test");
    await wait(50);
  });

  test("connect creates PTY entry immediately (before any messages)", async () => {
    const ws = await connectPty("desktop-test");
    // Entry is created synchronously in setupNewPtyEntry on WS open
    await wait(10);
    const entry = activePtySessions.get("desktop-test");
    expect(entry).toBeTruthy();
    expect(entry!.alive).toBe(true);
    expect(entry!.viewer).toBeTruthy();
    await closeWs(ws);
    await wait(100);
  });

  test("attach message triggers attach_ack response", async () => {
    const ws = await connectPty("desktop-test");
    const ackPromise = waitForMessage(ws, "attach_ack");
    ws.send(JSON.stringify({ type: "attach", cols: 120, rows: 40, skipPrefill: true }));
    const msg = await ackPromise;
    expect(msg.type).toBe("attach_ack");
    await closeWs(ws);
    await wait(100);
  });

  test("attach with skipPrefill=false still sends attach_ack", async () => {
    const ws = await connectPty("desktop-test");
    const ackPromise = waitForMessage(ws, "attach_ack");
    ws.send(JSON.stringify({ type: "attach", cols: 100, rows: 30, skipPrefill: false }));
    const msg = await ackPromise;
    expect(msg.type).toBe("attach_ack");
    await closeWs(ws);
    await wait(100);
  });

  test("attach_ack is the first message received", async () => {
    const ws = await connectPty("desktop-test");
    const received: Array<{ frame: "text" | "binary"; type?: string }> = [];

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          received.push({ frame: "text", type: msg.type });
        } catch {}
      } else {
        received.push({ frame: "binary" });
      }
    });

    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    // Wait for attach_ack + potential close from spawn failure
    await wait(500);

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].frame).toBe("text");
    expect(received[0].type).toBe("attach_ack");

    await closeWs(ws);
    await wait(100);
  });

  test("duplicate attach messages don't spawn multiple PTYs", async () => {
    const ws = await connectPty("desktop-test");
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    ws.send(JSON.stringify({ type: "attach", cols: 100, rows: 30, skipPrefill: true }));
    ws.send(JSON.stringify({ type: "attach", cols: 120, rows: 40, skipPrefill: true }));
    await wait(300);
    expect(ptySpawnAttempts.get("desktop-test") || 0).toBe(1);
    await closeWs(ws);
    await wait(100);
  });

  test("spawn failure closes WS with 4001 (session unavailable)", async () => {
    const ws = await connectPty("desktop-test");
    const closePromise = waitForClose(ws);
    // Trigger spawn — will fail (no real tmux session)
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    const ev = await closePromise;
    expect(ev.code).toBe(4001);
    await wait(50);
  });
});

// ── Type: binary stdin forwarding ──

describe("desktop terminal: type (binary stdin)", () => {
  beforeEach(async () => {
    activePtySessions.delete("desktop-test");
    ptySpawnAttempts.delete("desktop-test");
    await wait(50);
  });

  test("binary frame before attach is silently dropped (no proc)", async () => {
    const ws = await connectPty("desktop-test");
    // Send binary before attach — should be silently dropped (no proc to write to)
    const stdin = new TextEncoder().encode("premature\n");
    ws.send(stdin.buffer);
    await wait(50);
    // Connection survives (no spawn triggered, no crash)
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws);
    await wait(50);
  });

  test("binary frames sent during spawn don't crash server", async () => {
    const ws = await connectPty("desktop-test");
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    // Send binary immediately (before spawn resolves) — proc is null, frame dropped
    ws.send(new TextEncoder().encode("hello\n").buffer);
    ws.send(new TextEncoder().encode("world\n").buffer);
    // Wait for spawn failure + close
    await wait(3000);
    // Server should not have crashed — verify by connecting again
    const ws2 = await connectPty("desktop-test");
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws2);
    await wait(50);
  });

  test("oversized binary frame (>16KB) is silently dropped", async () => {
    const ws = await connectPty("desktop-test");
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    // Send oversized binary — server checks `raw.length > 16384` and drops
    const big = new Uint8Array(20000).fill(65);
    ws.send(big.buffer);
    // Wait for close (spawn failure, not oversized binary)
    await wait(3000);
    // Server still healthy
    const ws2 = await connectPty("desktop-test");
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws2);
    await wait(50);
  });

  test("interleaved binary and JSON messages don't crash server", async () => {
    const ws = await connectPty("desktop-test");
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    // Simulate: user types, then resizes, then types more — all before spawn completes
    ws.send(new TextEncoder().encode("ls").buffer);
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    ws.send(new TextEncoder().encode("\n").buffer);
    await wait(3000);
    // Server still healthy
    const ws2 = await connectPty("desktop-test");
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws2);
    await wait(50);
  });
});

// ── Scroll: resize handling ──

describe("desktop terminal: scroll (resize)", () => {
  beforeEach(async () => {
    activePtySessions.delete("desktop-test");
    ptySpawnAttempts.delete("desktop-test");
    await wait(50);
  });

  test("resize triggers spawn attempt (backward compat for older clients)", async () => {
    const ws = await connectPty("desktop-test");
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    await wait(300);
    expect(ptySpawnAttempts.get("desktop-test") || 0).toBe(1);
    await closeWs(ws);
    await wait(100);
  });

  test("resize updates latestRequestedSize (attach uses latest dims)", async () => {
    const ws = await connectPty("desktop-test");
    const msgs = collectJsonMessages(ws);
    // Send attach at 80x24, then immediately resize to 120x40
    // The PTY should spawn with the latest requested size (120x40)
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await wait(200);
    // attach_ack should arrive regardless of spawn outcome
    expect(msgs.some(m => m.type === "attach_ack")).toBe(true);
    // Only one spawn attempt (resize while spawning doesn't re-spawn)
    expect(ptySpawnAttempts.get("desktop-test") || 0).toBe(1);
    await closeWs(ws);
    await wait(100);
  });

  test("rapid resize sequence only triggers one spawn", async () => {
    const ws = await connectPty("desktop-test");
    const sizes = [
      { cols: 90, rows: 25 },
      { cols: 100, rows: 28 },
      { cols: 110, rows: 32 },
      { cols: 120, rows: 36 },
      { cols: 130, rows: 40 },
    ];
    for (const { cols, rows } of sizes) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
    await wait(300);
    // First resize triggers spawn, rest are queued as latestRequestedSize
    expect(ptySpawnAttempts.get("desktop-test") || 0).toBe(1);
    await closeWs(ws);
    await wait(100);
  });

  test("resize with extreme values doesn't crash server", async () => {
    const ws = await connectPty("desktop-test");
    // Very small
    ws.send(JSON.stringify({ type: "resize", cols: 1, rows: 1 }));
    // Very large
    ws.send(JSON.stringify({ type: "resize", cols: 500, rows: 200 }));
    // Negative (should be clamped)
    ws.send(JSON.stringify({ type: "resize", cols: -1, rows: -1 }));
    await wait(3000);
    // Server still healthy
    const ws2 = await connectPty("desktop-test");
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws2);
    await wait(50);
  });
});

// ── Session lifecycle ──

describe("desktop terminal: session lifecycle", () => {
  beforeEach(async () => {
    activePtySessions.delete("desktop-test");
    ptySpawnAttempts.delete("desktop-test");
    await wait(50);
  });

  test("client close before spawn tears down entry", async () => {
    const ws = await connectPty("desktop-test");
    await wait(10);
    const entry = activePtySessions.get("desktop-test");
    expect(entry).toBeTruthy();
    expect(entry!.alive).toBe(true);
    // Close immediately (before sending any messages)
    await closeWs(ws);
    await wait(100);
    expect(entry!.alive).toBe(false);
  });

  test("reconnect after spawn failure gets fresh entry + attach_ack", async () => {
    // First connection — triggers spawn failure
    const ws1 = await connectPty("desktop-test");
    ws1.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    await waitForClose(ws1);
    await wait(100);

    // Second connection — should get fresh entry
    const ws2 = await connectPty("desktop-test");
    const ackPromise = waitForMessage(ws2, "attach_ack");
    ws2.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    const msg = await ackPromise;
    expect(msg.type).toBe("attach_ack");
    await closeWs(ws2);
    await wait(100);
  });

  test("full lifecycle: connect → attach_ack → spawn fail → 4001 close", async () => {
    const ws = await connectPty("desktop-test");
    const msgs = collectJsonMessages(ws);
    const closePromise = waitForClose(ws);

    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));

    const ev = await closePromise;
    // attach_ack received before close
    expect(msgs.some(m => m.type === "attach_ack")).toBe(true);
    // Closed with 4001 (session unavailable — no real tmux)
    expect(ev.code).toBe(4001);
  });

  test("rapid connect/disconnect cycles don't leak entries or crash", async () => {
    for (let i = 0; i < 5; i++) {
      const ws = await connectPty("desktop-test");
      ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
      await closeWs(ws);
      await wait(200);
    }
    // Server still healthy
    const ws = await connectPty("desktop-test");
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws);
    await wait(50);
  });
});
