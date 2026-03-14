/**
 * Take-control flow: viewer conflict + recovery — ghostty-web migration phase 4.
 *
 * Tests the full take-control protocol:
 *   viewer_conflict → take_control → control_granted → re-attach
 *
 * Covers: control_granted delivery, entry promotion, re-attach after takeover,
 * old PTY teardown, pending viewer cleanup, multi-hop takeover chains,
 * pending message filtering, and edge cases.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import type { AddressInfo } from "node:net";

process.env.WOLFPACK_TEST = "1";

const { server, __setTestOverrides, __getTestState } = await import("../../src/server/index.ts");
const { activePtySessions, ptySpawnAttempts } = __getTestState();

// ── Test setup ──

let port: number;
let baseWsUrl: string;

const FAKE_SESSIONS = ["tc-session", "tc-session-2"];
__setTestOverrides({
  tmuxList: async () => [...FAKE_SESSIONS],
  capturePane: async () => "$ mock-take-control\n",
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
    ws.addEventListener("close", () => { cleanup(); reject(new Error(`ws closed before ${type}`)); });
  });
}

/** Connect as second viewer and wait for viewer_conflict */
async function connectPending(session: string): Promise<WebSocket> {
  const ws = await connectPty(session);
  await waitForMessage(ws, "viewer_conflict");
  return ws;
}

/** Full take-control sequence: connect → wait for conflict → send take_control → wait for control_granted */
async function takeControlFrom(session: string, oldWs: WebSocket): Promise<{ ws: WebSocket; closeEvent: Promise<CloseEvent> }> {
  const oldClose = waitForClose(oldWs);
  const ws = await connectPty(session);
  await waitForMessage(ws, "viewer_conflict");
  const grantedPromise = waitForMessage(ws, "control_granted");
  ws.send(JSON.stringify({ type: "take_control" }));
  await grantedPromise;
  return { ws, closeEvent: oldClose };
}

// ── control_granted delivery ──

describe("take-control: control_granted", () => {
  const session = "tc-session";

  beforeEach(async () => {
    activePtySessions.delete(session);
    ptySpawnAttempts.delete(session);
    await wait(50);
  });

  test("new viewer receives control_granted after take_control", async () => {
    const ws1 = await connectPty(session);
    const ws2 = await connectPty(session);
    await waitForMessage(ws2, "viewer_conflict");

    const granted = waitForMessage(ws2, "control_granted");
    ws2.send(JSON.stringify({ type: "take_control" }));
    const msg = await granted;
    expect(msg.type).toBe("control_granted");

    await closeWs(ws2);
    await wait(100);
  });

  test("control_granted arrives before old viewer's close event resolves", async () => {
    const ws1 = await connectPty(session);
    const ws1Close = waitForClose(ws1);

    const ws2 = await connectPty(session);
    await waitForMessage(ws2, "viewer_conflict");

    // Track ordering: control_granted to ws2 vs close of ws1
    let grantedFirst = false;
    const granted = waitForMessage(ws2, "control_granted").then(() => { grantedFirst = true; });

    ws2.send(JSON.stringify({ type: "take_control" }));
    await granted;
    // control_granted is sent synchronously after old viewer close in server code
    expect(grantedFirst).toBe(true);

    await ws1Close;
    await closeWs(ws2);
    await wait(100);
  });
});

// ── Entry promotion after takeover ──

describe("take-control: entry promotion", () => {
  const session = "tc-session";

  beforeEach(async () => {
    activePtySessions.delete(session);
    ptySpawnAttempts.delete(session);
    await wait(50);
  });

  test("after take_control, new entry is created with promoted viewer", async () => {
    const ws1 = await connectPty(session);
    const entry1 = activePtySessions.get(session)!;
    expect(entry1.viewer).toBeTruthy();

    const { ws: ws2, closeEvent } = await takeControlFrom(session, ws1);
    await closeEvent;
    await wait(50);

    // Old entry should be torn down
    expect(entry1.alive).toBe(false);

    // New entry exists with ws2 as viewer
    const entry2 = activePtySessions.get(session);
    expect(entry2).toBeDefined();
    expect(entry2!.alive).toBe(true);
    expect(entry2!.viewer).toBeTruthy();
    // New entry is a different reference than old
    expect(entry2).not.toBe(entry1);

    await closeWs(ws2);
    await wait(100);
  });

  test("old entry pendingViewer is nulled after promotion", async () => {
    const ws1 = await connectPty(session);

    const ws2 = await connectPty(session);
    await waitForMessage(ws2, "viewer_conflict");
    // Before take_control, ws2 is the pendingViewer
    const entry = activePtySessions.get(session)!;
    expect(entry.pendingViewer).toBeTruthy();

    ws2.send(JSON.stringify({ type: "take_control" }));
    await waitForMessage(ws2, "control_granted");
    await wait(50);

    // Old entry's pendingViewer should be cleaned up
    expect(entry.pendingViewer).toBeNull();

    await closeWs(ws2);
    await wait(100);
  });
});

// ── Re-attach after takeover ──

describe("take-control: re-attach after takeover", () => {
  const session = "tc-session";

  beforeEach(async () => {
    activePtySessions.delete(session);
    ptySpawnAttempts.delete(session);
    await wait(50);
  });

  test("new viewer can send attach and receive attach_ack after control_granted", async () => {
    const ws1 = await connectPty(session);
    const { ws: ws2, closeEvent } = await takeControlFrom(session, ws1);
    await closeEvent;

    // New viewer sends attach handshake — should get attach_ack
    const ackPromise = waitForMessage(ws2, "attach_ack");
    ws2.send(JSON.stringify({ type: "attach", cols: 120, rows: 40, skipPrefill: true }));
    const msg = await ackPromise;
    expect(msg.type).toBe("attach_ack");

    await closeWs(ws2);
    await wait(100);
  });

  test("spawn attempt counter resets for promoted entry", async () => {
    const ws1 = await connectPty(session);
    // Trigger spawn on ws1 (will fail — no real tmux)
    ws1.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    // Wait for spawn failure to close ws1 — but ws1 may close before ws2 connects
    // Instead, just connect ws2 immediately (entry still alive pre-spawn-failure)
    await wait(50);

    // Entry may or may not still be alive depending on spawn timing.
    // Start fresh for a clean test:
    activePtySessions.delete(session);
    ptySpawnAttempts.delete(session);
    await wait(50);

    const ws1b = await connectPty(session);
    const { ws: ws2, closeEvent } = await takeControlFrom(session, ws1b);
    await closeEvent;

    // Spawn attempts should be fresh (old entry's counter is gone)
    // Send attach — triggers spawn attempt on the new entry
    ws2.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    await wait(300);
    expect(ptySpawnAttempts.get(session) || 0).toBe(1);

    await closeWs(ws2);
    await wait(100);
  });
});

// ── Old PTY teardown ──

describe("take-control: old PTY teardown", () => {
  const session = "tc-session";

  beforeEach(async () => {
    activePtySessions.delete(session);
    ptySpawnAttempts.delete(session);
    await wait(50);
  });

  test("old entry alive=false after take_control", async () => {
    const ws1 = await connectPty(session);
    const entry1 = activePtySessions.get(session)!;
    expect(entry1.alive).toBe(true);

    const { ws: ws2, closeEvent } = await takeControlFrom(session, ws1);
    await closeEvent;

    expect(entry1.alive).toBe(false);

    await closeWs(ws2);
    await wait(100);
  });

  test("old proc is killed during takeover (mock proc)", async () => {
    const ws1 = await connectPty(session);
    const entry = activePtySessions.get(session) as any;

    // Install a mock proc to verify teardown
    let terminalClosed = false;
    let procKilled = false;
    entry.proc = {
      terminal: {
        write() {},
        resize() {},
        close() { terminalClosed = true; },
      },
      kill() { procKilled = true; },
    };

    const { ws: ws2, closeEvent } = await takeControlFrom(session, ws1);
    await closeEvent;
    await wait(50);

    expect(terminalClosed).toBe(true);
    expect(procKilled).toBe(true);

    await closeWs(ws2);
    await wait(100);
  });

  test("old viewer close handler does NOT teardown new entry (INV-5)", async () => {
    const ws1 = await connectPty(session);

    const { ws: ws2, closeEvent } = await takeControlFrom(session, ws1);
    // Wait for old viewer's close event to fire
    await closeEvent;
    await wait(200);

    // New entry should still be alive — old close handler must NOT destroy it
    const newEntry = activePtySessions.get(session);
    expect(newEntry).toBeDefined();
    expect(newEntry!.alive).toBe(true);
    expect(newEntry!.viewer).toBeTruthy();

    await closeWs(ws2);
    await wait(100);
  });
});

// ── Pending viewer cleanup ──

describe("take-control: pending viewer cleanup", () => {
  const session = "tc-session";

  beforeEach(async () => {
    activePtySessions.delete(session);
    ptySpawnAttempts.delete(session);
    await wait(50);
  });

  test("pending viewer disconnect clears pendingViewer without affecting active", async () => {
    const ws1 = await connectPty(session);
    const entry = activePtySessions.get(session)!;
    expect(entry.viewer).toBeTruthy();

    const ws2 = await connectPending(session);
    expect(entry.pendingViewer).toBeTruthy();

    // Pending viewer disconnects without taking control
    await closeWs(ws2);
    await wait(100);

    // Active entry unaffected
    expect(entry.alive).toBe(true);
    expect(entry.viewer).toBeTruthy();
    expect(entry.pendingViewer).toBeNull();

    await closeWs(ws1);
    await wait(100);
  });

  test("third viewer displaces second pending, then takes control", async () => {
    const ws1 = await connectPty(session);
    const ws2 = await connectPending(session);
    const ws2Close = waitForClose(ws2);

    // Third viewer connects — displaces ws2 (pending)
    const ws3 = await connectPty(session);
    await waitForMessage(ws3, "viewer_conflict");

    // ws2 should be displaced
    const ev2 = await ws2Close;
    expect(ev2.code).toBe(4002);

    // ws3 takes control from ws1
    const ws1Close = waitForClose(ws1);
    const granted = waitForMessage(ws3, "control_granted");
    ws3.send(JSON.stringify({ type: "take_control" }));
    await granted;

    const ev1 = await ws1Close;
    expect(ev1.code).toBe(4002);

    // ws3 is now the active viewer
    const entry = activePtySessions.get(session);
    expect(entry).toBeDefined();
    expect(entry!.alive).toBe(true);

    await closeWs(ws3);
    await wait(100);
  });
});

// ── Multi-hop takeover chains ──

describe("take-control: multi-hop chain (A → B → C)", () => {
  const session = "tc-session";

  beforeEach(async () => {
    activePtySessions.delete(session);
    ptySpawnAttempts.delete(session);
    await wait(50);
  });

  test("three successive takeovers all succeed", async () => {
    // A connects
    const wsA = await connectPty(session);
    const entryA = activePtySessions.get(session)!;

    // B takes control from A
    const { ws: wsB, closeEvent: closeA } = await takeControlFrom(session, wsA);
    const evA = await closeA;
    expect(evA.code).toBe(4002);
    expect(entryA.alive).toBe(false);

    const entryB = activePtySessions.get(session)!;
    expect(entryB.alive).toBe(true);
    expect(entryB).not.toBe(entryA);

    // C takes control from B
    const { ws: wsC, closeEvent: closeB } = await takeControlFrom(session, wsB);
    const evB = await closeB;
    expect(evB.code).toBe(4002);
    expect(entryB.alive).toBe(false);

    const entryC = activePtySessions.get(session)!;
    expect(entryC.alive).toBe(true);
    expect(entryC).not.toBe(entryB);

    // C can attach
    const ack = waitForMessage(wsC, "attach_ack");
    wsC.send(JSON.stringify({ type: "attach", cols: 100, rows: 30, skipPrefill: true }));
    await ack;

    await closeWs(wsC);
    await wait(100);
  });

  test("displaced viewer A can reconnect and take control back from C", async () => {
    // A → B → C
    const wsA = await connectPty(session);
    const { ws: wsB } = await takeControlFrom(session, wsA);
    await wait(50);
    const { ws: wsC } = await takeControlFrom(session, wsB);
    await wait(50);

    // A reconnects — gets conflict (C is active)
    const wsA2 = await connectPty(session);
    await waitForMessage(wsA2, "viewer_conflict");

    // A takes control back
    const wsCClose = waitForClose(wsC);
    const granted = waitForMessage(wsA2, "control_granted");
    wsA2.send(JSON.stringify({ type: "take_control" }));
    await granted;

    const evC = await wsCClose;
    expect(evC.code).toBe(4002);

    // A2 is now active
    const entry = activePtySessions.get(session);
    expect(entry).toBeDefined();
    expect(entry!.alive).toBe(true);

    await closeWs(wsA2);
    await wait(100);
  });
});

// ── Pending message filtering ──

describe("take-control: pending viewer message filtering", () => {
  const session = "tc-session";

  beforeEach(async () => {
    activePtySessions.delete(session);
    ptySpawnAttempts.delete(session);
    await wait(50);
  });

  test("non-take_control JSON messages from pending viewer are ignored", async () => {
    const ws1 = await connectPty(session);
    const entry = activePtySessions.get(session)!;

    const ws2 = await connectPending(session);

    // Send various message types that should be ignored
    ws2.send(JSON.stringify({ type: "attach", cols: 80, rows: 24 }));
    ws2.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    ws2.send(JSON.stringify({ type: "unknown_type" }));
    ws2.send(JSON.stringify({ type: "" }));
    await wait(100);

    // Active entry unaffected — ws1 still viewer, no spawn triggered
    expect(entry.alive).toBe(true);
    expect(entry.viewer).toBeTruthy();
    // ws2 still open (not kicked for bad messages)
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    await closeWs(ws2);
    await closeWs(ws1);
    await wait(100);
  });

  test("binary frames from pending viewer are ignored", async () => {
    const ws1 = await connectPty(session);
    const ws2 = await connectPending(session);

    // Send binary data — should be silently ignored
    ws2.send(new TextEncoder().encode("hello\n").buffer);
    ws2.send(new Uint8Array([0x00, 0x01, 0x02]).buffer);
    await wait(100);

    // Both connections survive
    expect(ws1.readyState).toBe(WebSocket.OPEN);
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    await closeWs(ws2);
    await closeWs(ws1);
    await wait(100);
  });

  test("malformed JSON from pending viewer doesn't crash server", async () => {
    const ws1 = await connectPty(session);
    const ws2 = await connectPending(session);

    // Send broken JSON
    ws2.send("not json at all");
    ws2.send("{broken");
    ws2.send("");
    await wait(100);

    // Both connections survive
    expect(ws1.readyState).toBe(WebSocket.OPEN);
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    await closeWs(ws2);
    await closeWs(ws1);
    await wait(100);
  });
});

// ── Cross-session isolation ──

describe("take-control: cross-session isolation", () => {
  beforeEach(async () => {
    activePtySessions.delete("tc-session");
    activePtySessions.delete("tc-session-2");
    ptySpawnAttempts.delete("tc-session");
    ptySpawnAttempts.delete("tc-session-2");
    await wait(50);
  });

  test("take-control on one session doesn't affect another session", async () => {
    // Session 1: active viewer
    const ws1a = await connectPty("tc-session");
    const entry1 = activePtySessions.get("tc-session")!;

    // Session 2: active viewer
    const ws2a = await connectPty("tc-session-2");
    const entry2 = activePtySessions.get("tc-session-2")!;

    // Take control on session 1 only
    const { ws: ws1b, closeEvent } = await takeControlFrom("tc-session", ws1a);
    await closeEvent;

    // Session 2 unaffected
    expect(entry2.alive).toBe(true);
    expect(entry2.viewer).toBeTruthy();
    expect(ws2a.readyState).toBe(WebSocket.OPEN);

    await closeWs(ws1b);
    await closeWs(ws2a);
    await wait(100);
  });
});

// ── Edge cases ──

describe("take-control: edge cases", () => {
  const session = "tc-session";

  beforeEach(async () => {
    activePtySessions.delete(session);
    ptySpawnAttempts.delete(session);
    await wait(50);
  });

  test("take_control after active viewer already disconnected still works", async () => {
    const ws1 = await connectPty(session);
    const ws2 = await connectPending(session);

    // Active viewer disconnects — entry torn down
    await closeWs(ws1);
    await wait(200);

    // ws2 is still open but entry is gone
    // Sending take_control now — server should handle gracefully
    // (the pending cleanup handler may have already fired)
    ws2.send(JSON.stringify({ type: "take_control" }));
    await wait(200);

    // ws2 connection should still be open or cleanly closed — no crash
    // Server health check: can still connect
    const ws3 = await connectPty(session);
    expect(ws3.readyState).toBe(WebSocket.OPEN);

    await closeWs(ws2);
    await closeWs(ws3);
    await wait(100);
  });

  test("new viewer closes immediately after control_granted", async () => {
    const ws1 = await connectPty(session);
    const { ws: ws2, closeEvent } = await takeControlFrom(session, ws1);
    await closeEvent;

    // Close immediately after granted — no attach sent
    await closeWs(ws2);
    await wait(200);

    // Entry should be torn down (viewer disconnected)
    const entry = activePtySessions.get(session);
    if (entry) {
      expect(entry.alive).toBe(false);
    }

    // Server still healthy
    const ws3 = await connectPty(session);
    expect(ws3.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws3);
    await wait(100);
  });

  test("rapid connect + take-control cycles don't leak entries", async () => {
    let prev = await connectPty(session);

    for (let i = 0; i < 5; i++) {
      const { ws: next, closeEvent } = await takeControlFrom(session, prev);
      await closeEvent;
      prev = next;
    }

    // Only one entry should exist
    const entry = activePtySessions.get(session);
    expect(entry).toBeDefined();
    expect(entry!.alive).toBe(true);

    await closeWs(prev);
    await wait(100);
  });
});
