import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { AddressInfo } from "node:net";

// Use dynamic import so WOLFPACK_TEST is set before server module evaluation.
process.env.WOLFPACK_TEST = "1";

const { server, wss, __setTmuxList, __getActivePtySessions } = await import("../../src/server/index.ts");

// ── Test setup ──

let port: number;
let baseWsUrl: string;

// Fake tmuxList returns a known session list (mutated in-place by tests)
const FAKE_SESSIONS = ["test-session", "another-session"];
__setTmuxList(async () => [...FAKE_SESSIONS]);

// Suppress expected tmux errors (no real tmux session in CI/test)
const _realConsoleError = console.error;

beforeAll((done) => {
  console.error = (...args: any[]) => {
    const msg = String(args[0] ?? "");
    if (msg.startsWith("WS error")) return; // expected — no real tmux
    _realConsoleError(...args);
  };
  // Listen on random port for test isolation
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

/** Connect using raw HTTP upgrade to detect rejection vs acceptance */
async function rawUpgrade(path: string): Promise<{ status: number; ws?: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${baseWsUrl}${path}`);
    ws.addEventListener("open", () => resolve({ status: 101, ws }));
    ws.addEventListener("error", () => resolve({ status: 0 }));
    ws.addEventListener("close", (ev) => {
      // Bun fires close with code 1006 on rejection (server destroyed socket)
      resolve({ status: ev.code === 1006 ? 403 : ev.code });
    });
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.addEventListener("close", () => resolve());
    ws.close();
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Tests ──

describe("WS /ws/terminal connection", () => {
  test("connects for valid session", async () => {
    const { status, ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(status).toBe(101);
    expect(ws).toBeDefined();
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("rejects unknown session (connection fails)", async () => {
    const { status, ws } = await rawUpgrade("/ws/terminal?session=nonexistent");
    // Server writes "403 Forbidden" and destroys socket — client sees error/close
    expect(status).not.toBe(101);
    if (ws) await closeWs(ws);
  });

  test("connects via /ws/mobile alias for valid session", async () => {
    const { status, ws } = await rawUpgrade("/ws/mobile?session=test-session");
    expect(status).toBe(101);
    expect(ws).toBeDefined();
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("rejects missing session param (connection fails)", async () => {
    const { status, ws } = await rawUpgrade("/ws/terminal");
    expect(status).not.toBe(101);
    if (ws) await closeWs(ws);
  });

  test("rejects unknown WS path (connection fails)", async () => {
    const { status, ws } = await rawUpgrade("/ws/unknown?session=test-session");
    expect(status).not.toBe(101);
    if (ws) await closeWs(ws);
  });
});

describe("WS /ws/terminal session lifecycle", () => {
  test("closes with 4001 when session disappears after connect", async () => {
    const ws = new WebSocket(`${baseWsUrl}/ws/terminal?session=test-session`);
    const closePromise = new Promise<CloseEvent>((resolve) => {
      ws.addEventListener("close", (ev) => resolve(ev));
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws/terminal connect failed")));
    });

    const idx = FAKE_SESSIONS.indexOf("test-session");
    expect(idx).toBeGreaterThan(-1);
    if (idx !== -1) FAKE_SESSIONS.splice(idx, 1);

    try {
      const closeEvent = await Promise.race([
        closePromise,
        wait(6000).then(() => { throw new Error("timed out waiting for session-ended close"); }),
      ]) as CloseEvent;
      expect(closeEvent.code).toBe(4001);
    } finally {
      if (!FAKE_SESSIONS.includes("test-session")) FAKE_SESSIONS.push("test-session");
      await wait(50);
    }
  });
});

describe("WS /ws/terminal message handling", () => {
  test("survives invalid JSON message", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    ws!.send("this is not json{{{");
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("survives message with missing fields", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    // input without data field
    ws!.send(JSON.stringify({ type: "input" }));
    // key without key field
    ws!.send(JSON.stringify({ type: "key" }));
    // resize without cols/rows
    ws!.send(JSON.stringify({ type: "resize" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("drops disallowed key silently (connection stays open)", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "key", key: "F13-evil" }));
    ws!.send(JSON.stringify({ type: "key", key: "; rm -rf /" }));
    ws!.send(JSON.stringify({ type: "key", key: "" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("accepts allowed key without crash", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    // tmuxSendKey will fail (no real tmux session) but handler catches errors
    ws!.send(JSON.stringify({ type: "key", key: "Enter" }));
    ws!.send(JSON.stringify({ type: "key", key: "C-c" }));
    ws!.send(JSON.stringify({ type: "key", key: "Tab" }));
    await wait(300);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("survives resize with extreme values", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    // Extreme values — will be clamped by clampCols/clampRows, tmuxResize will fail (no tmux)
    ws!.send(JSON.stringify({ type: "resize", cols: 9999, rows: 0 }));
    ws!.send(JSON.stringify({ type: "resize", cols: -1, rows: -1 }));
    ws!.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    await wait(300);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("drops oversized message (>64KB)", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    // 70KB message — exceeds 65536 byte cap, should be silently dropped
    const huge = JSON.stringify({ type: "input", data: "x".repeat(70 * 1024) });
    ws!.send(huge);
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("rate limiting: rapid messages don't crash", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    // Send 65 messages rapidly — first 60 processed, rest dropped
    for (let i = 0; i < 65; i++) {
      ws!.send(JSON.stringify({ type: "key", key: "Enter" }));
    }
    await wait(500);
    // Connection should survive
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("input message with string data doesn't crash", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "input", data: "hello world" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("unknown message type is silently ignored", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "foobar", data: "whatever" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });
});

// ── /ws/pty spawn failure + reconnect loop prevention ──

describe("WS /ws/pty spawn failure handling", () => {
  test("attach handshake triggers PTY spawn and closes 4001 on failure", async () => {
    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
    ws.binaryType = "arraybuffer";

    const closePromise = new Promise<CloseEvent>((resolve) => {
      ws.addEventListener("close", (ev) => resolve(ev));
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws/pty connect failed")));
    });

    // Trigger attach bootstrap — will fail because "test-session" has no real tmux session
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24 }));

    const closeEvent = await Promise.race([
      closePromise,
      wait(5000).then(() => { throw new Error("timed out waiting for WS close"); }),
    ]) as CloseEvent;

    expect(closeEvent.code).toBe(4001);
  });

  test("closes with 4001 when pty spawn fails (no real tmux session)", async () => {
    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
    ws.binaryType = "arraybuffer";

    // Set up close listener before anything else to avoid race
    const closePromise = new Promise<CloseEvent>((resolve) => {
      ws.addEventListener("close", (ev) => resolve(ev));
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws/pty connect failed")));
    });

    // Trigger spawnPty — will fail because "test-session" has no real tmux session
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

    const closeEvent = await Promise.race([
      closePromise,
      wait(5000).then(() => { throw new Error("timed out waiting for WS close"); }),
    ]) as CloseEvent;

    // Must close with 4001 (session unavailable), NOT 1000 (normal close).
    // Code 1000 tells the client "safe to reconnect" → infinite reconnect loop.
    expect(closeEvent.code).toBe(4001);
  });

  test("rapid reconnects after spawn failure all get 4001", async () => {
    const closeCodes: number[] = [];

    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
      ws.binaryType = "arraybuffer";

      const closePromise = new Promise<CloseEvent>((resolve) => {
        ws.addEventListener("close", (ev) => resolve(ev));
      });

      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("ws/pty connect failed")));
      });

      ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

      const ev = await Promise.race([
        closePromise,
        wait(5000).then(() => { throw new Error("timed out waiting for WS close"); }),
      ]) as CloseEvent;
      closeCodes.push(ev.code);
    }

    // Every reconnect should get 4001, not 1000
    expect(closeCodes).toEqual([4001, 4001, 4001]);
  });
});

// ── Mobile terminal: session disappear + reconnect ──

describe("WS /ws/terminal session disappear & reconnect", () => {
  test("client can reconnect after session reappears", async () => {
    // 1. Connect
    const ws1 = new WebSocket(`${baseWsUrl}/ws/terminal?session=test-session`);
    const close1 = new Promise<CloseEvent>((r) => ws1.addEventListener("close", r));
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // 2. Remove session → should get 4001
    const idx = FAKE_SESSIONS.indexOf("test-session");
    FAKE_SESSIONS.splice(idx, 1);

    const ev1 = await Promise.race([
      close1,
      wait(6000).then(() => { throw new Error("timeout waiting for 4001"); }),
    ]) as CloseEvent;
    expect(ev1.code).toBe(4001);

    // 3. Restore session
    FAKE_SESSIONS.push("test-session");
    await wait(50);

    // 4. Reconnect — should succeed
    const { status, ws: ws2 } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(status).toBe(101);
    expect(ws2!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws2!);
  });

  test("multiple terminals get 4001 when session disappears", async () => {
    const conns: WebSocket[] = [];
    const closePromises: Promise<CloseEvent>[] = [];

    // Open 3 concurrent mobile terminal connections
    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`${baseWsUrl}/ws/terminal?session=another-session`);
      const cp = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error(`connect ${i} failed`)));
      });
      conns.push(ws);
      closePromises.push(cp);
    }

    // Remove session
    const idx = FAKE_SESSIONS.indexOf("another-session");
    FAKE_SESSIONS.splice(idx, 1);

    try {
      const events = await Promise.race([
        Promise.all(closePromises),
        wait(8000).then(() => { throw new Error("timeout"); }),
      ]) as CloseEvent[];
      // All three should get 4001
      for (const ev of events) {
        expect(ev.code).toBe(4001);
      }
    } finally {
      FAKE_SESSIONS.push("another-session");
      await wait(50);
    }
  });
});

// ── PTY: single-viewer teardown ──

describe("WS /ws/pty single-viewer teardown", () => {
  test("PTY entry torn down immediately on viewer disconnect", async () => {
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
    ws1.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("ws/pty connect failed")));
    });

    const ptySessions = __getActivePtySessions();
    expect(ptySessions.has("test-session")).toBe(true);
    const entry = ptySessions.get("test-session")!;
    expect(entry.alive).toBe(true);
    expect(entry.viewer).toBeTruthy();

    // Disconnect — immediate teardown (no grace period)
    ws1.close();
    await wait(200);

    expect(entry.alive).toBe(false);
  });

  test("reconnect after teardown creates fresh entry", async () => {
    const session = "another-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("connect failed")));
    });

    const entry1 = ptySessions.get(session)!;

    // Disconnect — immediate teardown
    ws1.close();
    await wait(200);
    expect(entry1.alive).toBe(false);

    // Reconnect — creates fresh entry (not reused)
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("reconnect failed")));
    });

    const entry2 = ptySessions.get(session);
    expect(entry2).toBeDefined();
    expect(entry2!.alive).toBe(true);
    // Fresh entry — not the same reference as torn-down entry
    expect(entry2).not.toBe(entry1);

    ws2.close();
    await wait(200);
  });
});

describe("WS /ws/pty input routing", () => {
  test("binary stdin beginning with '{' is forwarded to the PTY", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws/pty connect failed")));
    });

    const entry = ptySessions.get(session) as any;
    expect(entry).toBeDefined();

    const writes: Buffer[] = [];
    entry.proc = {
      terminal: {
        write(data: Buffer) {
          writes.push(Buffer.from(data));
        },
        resize() {},
        close() {},
      },
      kill() {},
    };

    ws.send(Uint8Array.from([0x7b, 0x66, 0x6f, 0x6f, 0x7d]));
    await wait(100);

    expect(writes).toHaveLength(1);
    expect(writes[0].toString("utf-8")).toBe("{foo}");

    await closeWs(ws);
    await wait(100);
  });
});

// ── PTY: viewer conflict protocol ──

describe("WS /ws/pty viewer conflict", () => {
  test("second viewer gets viewer_conflict message", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("v1 connect failed")));
    });

    const entry = ptySessions.get(session);
    expect(entry).toBeDefined();
    expect(entry!.viewer).toBeTruthy();
    const originalViewer = entry!.viewer;

    // Second viewer connects — should get conflict
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    const conflictPromise = new Promise<boolean>((resolve) => {
      ws2.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "viewer_conflict") resolve(true);
        } catch {}
      });
      setTimeout(() => resolve(false), 2000);
    });

    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("v2 connect failed")));
    });

    expect(await conflictPromise).toBe(true);
    // Original viewer remains
    expect(ptySessions.get(session)!.viewer).toBe(originalViewer);

    await closeWs(ws2);
    await closeWs(ws1);
    await wait(200);
  });

  test("take_control displaces original viewer", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    const ws1ClosePromise = new Promise<CloseEvent>((r) => ws1.addEventListener("close", r));
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("v1 failed")));
    });

    // Second viewer connects, waits for conflict, then takes control
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("v2 failed")));
    });

    // Wait for conflict message
    await new Promise<void>((resolve) => {
      ws2.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "viewer_conflict") resolve();
        } catch {}
      });
    });

    // Take control
    ws2.send(JSON.stringify({ type: "take_control" }));

    // Original viewer should be displaced (close code 4002)
    const ev = await Promise.race([
      ws1ClosePromise,
      wait(3000).then(() => { throw new Error("timeout waiting for ws1 close"); }),
    ]) as CloseEvent;
    expect(ev.code).toBe(4002);

    await closeWs(ws2);
    await wait(200);
  });
});

// ── PTY: rapid spawn failure edge cases ──

describe("WS /ws/pty rapid spawn failure edge cases", () => {
  test("first viewer to dead session gets 4001, second gets conflict", async () => {
    const ptySessions = __getActivePtySessions();
    ptySessions.delete("test-session");
    await wait(50);

    // First viewer connects and triggers spawn
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
    ws1.binaryType = "arraybuffer";
    const close1 = new Promise<CloseEvent>((r) => ws1.addEventListener("close", r));
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // Trigger spawn — will fail (no real tmux)
    ws1.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

    const ev = await Promise.race([
      close1,
      wait(5000).then(() => { throw new Error("timeout waiting for close"); }),
    ]) as CloseEvent;
    expect(ev.code).toBe(4001);
  });

  test("spawn failure cleans up PTY entry", async () => {
    const ptySessions = __getActivePtySessions();
    ptySessions.delete("test-session");
    await wait(50);

    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
    ws.binaryType = "arraybuffer";

    const closePromise = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // Entry exists before spawn attempt
    expect(ptySessions.has("test-session")).toBe(true);

    // Trigger spawn — will fail (no real tmux)
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

    await Promise.race([
      closePromise,
      wait(5000).then(() => { throw new Error("timeout"); }),
    ]);

    // After spawn failure, entry should be cleaned up
    await wait(100);
    const entry = ptySessions.get("test-session");
    if (entry) {
      expect(entry.alive).toBe(false);
    }
  });

  test("viewer that disconnects before spawn completes is handled gracefully", async () => {
    const ptySessions = __getActivePtySessions();
    ptySessions.delete("test-session");
    await wait(50);

    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
    ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // Immediately close WITHOUT triggering spawn (no resize sent)
    ws.close();
    await wait(300);

    // Single-viewer: immediate teardown on disconnect
    const entry = ptySessions.get("test-session");
    if (entry) {
      expect(entry.alive).toBe(false);
    }
  });
});

// ── PTY: displaced viewer should NOT reconnect ──

describe("WS /ws/pty displaced viewer reconnect prevention", () => {
  test("displaced viewer receives close code 4002 (not 1000 or 4001)", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // First viewer connects
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    const ws1ClosePromise = new Promise<CloseEvent>((r) => ws1.addEventListener("close", r));
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("v1 failed")));
    });

    // Second viewer connects, gets conflict, takes control
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("v2 failed")));
    });

    await new Promise<void>((resolve) => {
      ws2.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "viewer_conflict") resolve();
        } catch {}
      });
    });

    ws2.send(JSON.stringify({ type: "take_control" }));

    const ev = await Promise.race([
      ws1ClosePromise,
      wait(3000).then(() => { throw new Error("timeout"); }),
    ]) as CloseEvent;

    // 4002 = displaced — client must NOT auto-reconnect
    // (1000 = normal, 4001 = session gone — both have different reconnect semantics)
    expect(ev.code).toBe(4002);
    expect(ev.reason).toBe("displaced");

    await closeWs(ws2);
    await wait(200);
  });

  test("third pending viewer displaces second pending viewer with 4002", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // First viewer (active)
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("v1 failed")));
    });

    // Second viewer (pending) — gets conflict
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    const ws2ClosePromise = new Promise<CloseEvent>((r) => ws2.addEventListener("close", r));
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("v2 failed")));
    });
    await new Promise<void>((resolve) => {
      ws2.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "viewer_conflict") resolve();
        } catch {}
      });
    });

    // Third viewer connects — should displace second pending viewer
    const ws3 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws3.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws3.addEventListener("open", () => resolve());
      ws3.addEventListener("error", () => reject(new Error("v3 failed")));
    });

    // Second viewer should be closed with 4002 (displaced by third)
    const ev = await Promise.race([
      ws2ClosePromise,
      wait(3000).then(() => { throw new Error("timeout waiting for ws2 close"); }),
    ]) as CloseEvent;
    expect(ev.code).toBe(4002);

    await closeWs(ws3);
    await closeWs(ws1);
    await wait(200);
  });
});

// ── Mobile terminal concurrent with PTY viewer ──

describe("WS /ws/terminal concurrent with /ws/pty", () => {
  test("mobile terminal works while PTY viewer is active", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // PTY viewer connects (desktop)
    const wsPty = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    wsPty.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      wsPty.addEventListener("open", () => resolve());
      wsPty.addEventListener("error", () => reject(new Error("pty connect failed")));
    });

    expect(ptySessions.has(session)).toBe(true);

    // Mobile terminal connects concurrently — should succeed
    const { status, ws: wsMobile } = await rawUpgrade(`/ws/terminal?session=${session}`);
    expect(status).toBe(101);
    expect(wsMobile).toBeDefined();
    expect(wsMobile!.readyState).toBe(WebSocket.OPEN);

    // Mobile can send messages without affecting PTY viewer
    wsMobile!.send(JSON.stringify({ type: "key", key: "Enter" }));
    wsMobile!.send(JSON.stringify({ type: "input", data: "hello" }));
    await wait(200);

    // Both connections still alive
    expect(wsMobile!.readyState).toBe(WebSocket.OPEN);
    expect(wsPty.readyState).toBe(WebSocket.OPEN);

    // PTY entry still has its viewer
    const entry = ptySessions.get(session);
    expect(entry).toBeDefined();
    expect(entry!.alive).toBe(true);
    expect(entry!.viewer).toBeTruthy();

    await closeWs(wsMobile!);
    await closeWs(wsPty);
    await wait(200);
  });

  test("mobile terminal resize does NOT resize PTY-owned session", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // PTY viewer active
    const wsPty = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    wsPty.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      wsPty.addEventListener("open", () => resolve());
      wsPty.addEventListener("error", () => reject(new Error("pty connect failed")));
    });

    expect(ptySessions.has(session)).toBe(true);

    // Mobile connects
    const { ws: wsMobile } = await rawUpgrade(`/ws/terminal?session=${session}`);
    expect(wsMobile).toBeDefined();

    // Mobile sends resize — should be skipped because activePtySessions has this session
    // (the terminal handler checks activePtySessions.has(session) before calling tmuxResize)
    wsMobile!.send(JSON.stringify({ type: "resize", cols: 40, rows: 10 }));
    await wait(200);

    // Both connections survive — no crash from the guarded resize
    expect(wsMobile!.readyState).toBe(WebSocket.OPEN);
    expect(wsPty.readyState).toBe(WebSocket.OPEN);

    await closeWs(wsMobile!);
    await closeWs(wsPty);
    await wait(200);
  });

  test("closing mobile terminal does NOT tear down PTY", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // PTY viewer active
    const wsPty = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    wsPty.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      wsPty.addEventListener("open", () => resolve());
      wsPty.addEventListener("error", () => reject(new Error("pty connect failed")));
    });

    // Mobile connects
    const { ws: wsMobile } = await rawUpgrade(`/ws/terminal?session=${session}`);
    expect(wsMobile).toBeDefined();

    // Close mobile — PTY should survive
    await closeWs(wsMobile!);
    await wait(200);

    const entry = ptySessions.get(session);
    expect(entry).toBeDefined();
    expect(entry!.alive).toBe(true);
    expect(entry!.viewer).toBeTruthy();
    expect(wsPty.readyState).toBe(WebSocket.OPEN);

    await closeWs(wsPty);
    await wait(200);
  });
});

// ── PTY: reset=1 reconnect path (grid cells reconnect with fresh PTY) ──

describe("WS /ws/pty reset=1 reconnect", () => {
  test("reset=1 tears down existing entry and creates a fresh one", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // First viewer connects normally
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    const ws1Close = new Promise<CloseEvent>((r) => ws1.addEventListener("close", r));
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("v1 failed")));
    });

    const entry1 = ptySessions.get(session)!;
    expect(entry1).toBeDefined();
    expect(entry1.alive).toBe(true);

    // Second viewer connects with reset=1
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}&reset=1`);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("v2 failed")));
    });

    // Old viewer should have been closed during teardown
    const ev = await Promise.race([
      ws1Close,
      wait(3000).then(() => { throw new Error("timeout waiting for ws1 close"); }),
    ]) as CloseEvent;
    expect(ev.code).toBe(1000); // teardownPty uses 1000

    // New entry replaces old one
    const entry2 = ptySessions.get(session)!;
    expect(entry2).toBeDefined();
    expect(entry2.alive).toBe(true);
    expect(entry2).not.toBe(entry1);

    // Old entry is dead
    expect(entry1.alive).toBe(false);

    await closeWs(ws2);
    await wait(200);
  });

  test("reset=1 with no existing entry creates normally", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // Connect with reset=1 on clean session — should work like normal connect
    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}&reset=1`);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    const entry = ptySessions.get(session);
    expect(entry).toBeDefined();
    expect(entry!.alive).toBe(true);
    expect(entry!.viewer).toBeTruthy();

    await closeWs(ws);
    await wait(200);
  });

  test("old detach handler does NOT tear down new entry after reset=1", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // First viewer connects
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("v1 failed")));
    });

    // Second viewer connects with reset=1 — tears down old entry
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}&reset=1`);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("v2 failed")));
    });

    // Wait for ws1 to fully close (its detach handler fires)
    await wait(300);

    // The new entry must still be alive — old detach handler must not nuke it
    const entry = ptySessions.get(session);
    expect(entry).toBeDefined();
    expect(entry!.alive).toBe(true);
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    await closeWs(ws2);
    await wait(200);
  });

  test("multiple sequential reset=1 reconnects work correctly", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // Connect → reset → reset → each should create a fresh entry
    let prevEntry: any = null;
    for (let i = 0; i < 3; i++) {
      const url = i === 0
        ? `${baseWsUrl}/ws/pty?session=${session}`
        : `${baseWsUrl}/ws/pty?session=${session}&reset=1`;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error(`connect ${i} failed`)));
      });

      const entry = ptySessions.get(session);
      expect(entry).toBeDefined();
      expect(entry!.alive).toBe(true);

      if (prevEntry) {
        expect(entry).not.toBe(prevEntry);
        expect(prevEntry.alive).toBe(false);
      }
      prevEntry = entry;

      // Don't close — next iteration's reset=1 will tear it down
      if (i === 2) {
        await closeWs(ws);
        await wait(200);
      }
    }
  });

  test("reset=1 also cleans up pending viewer on old entry", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // First viewer (active)
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("v1 failed")));
    });

    // Second viewer (pending) — gets conflict
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    const ws2Close = new Promise<CloseEvent>((r) => ws2.addEventListener("close", r));
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("v2 failed")));
    });
    await new Promise<void>((resolve) => {
      ws2.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "viewer_conflict") resolve();
        } catch {}
      });
    });

    // Third viewer connects with reset=1 — should nuke both old viewer and pending
    const ws3 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}&reset=1`);
    ws3.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws3.addEventListener("open", () => resolve());
      ws3.addEventListener("error", () => reject(new Error("v3 failed")));
    });

    // Pending viewer (ws2) should have been closed by teardown
    const ev = await Promise.race([
      ws2Close,
      wait(3000).then(() => { throw new Error("timeout waiting for ws2 close"); }),
    ]) as CloseEvent;
    expect(ev.code).toBe(1000); // teardownPty uses 1000

    // New entry exists and is fresh
    const entry = ptySessions.get(session);
    expect(entry).toBeDefined();
    expect(entry!.alive).toBe(true);
    expect(entry!.pendingViewer).toBeNull();

    await closeWs(ws3);
    await closeWs(ws1);
    await wait(200);
  });
});

// ── PTY: take-control protocol completeness ──

describe("WS /ws/pty take-control protocol completeness", () => {
  test("control_granted message is sent after take_control", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // Active viewer
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("v1 failed")));
    });

    // Pending viewer
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    const messages: any[] = [];
    ws2.addEventListener("message", (ev) => {
      try { messages.push(JSON.parse(String(ev.data))); } catch {}
    });
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("v2 failed")));
    });

    // Wait for conflict
    await new Promise<void>((resolve) => {
      const check = () => {
        if (messages.some((m) => m.type === "viewer_conflict")) resolve();
        else setTimeout(check, 50);
      };
      check();
    });

    // Take control
    ws2.send(JSON.stringify({ type: "take_control" }));
    await wait(300);

    // Should have received viewer_conflict then control_granted
    expect(messages.some((m) => m.type === "viewer_conflict")).toBe(true);
    expect(messages.some((m) => m.type === "control_granted")).toBe(true);

    // ws2 is now the active viewer with a fresh entry
    const entry = ptySessions.get(session);
    expect(entry).toBeDefined();
    expect(entry!.alive).toBe(true);
    expect(entry!.viewer).toBeTruthy();
    expect(entry!.pendingViewer).toBeNull();

    await closeWs(ws2);
    await closeWs(ws1);
    await wait(200);
  });

  test("pending viewer disconnect without take_control does not affect active viewer", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // Active viewer
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("v1 failed")));
    });

    const entry1 = ptySessions.get(session)!;

    // Pending viewer
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("v2 failed")));
    });
    await new Promise<void>((resolve) => {
      ws2.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "viewer_conflict") resolve();
        } catch {}
      });
    });

    expect(entry1.pendingViewer).toBeTruthy();

    // Pending viewer disconnects without taking control
    await closeWs(ws2);
    await wait(200);

    // Active viewer unaffected
    expect(ws1.readyState).toBe(WebSocket.OPEN);
    expect(entry1.alive).toBe(true);
    expect(entry1.viewer).toBeTruthy();
    expect(entry1.pendingViewer).toBeNull(); // cleaned up

    await closeWs(ws1);
    await wait(200);
  });

  test("take_control creates fresh PTY entry (old entry replaced)", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // Active viewer
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("v1 failed")));
    });

    const oldEntry = ptySessions.get(session)!;

    // Pending viewer
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("v2 failed")));
    });
    await new Promise<void>((resolve) => {
      ws2.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "viewer_conflict") resolve();
        } catch {}
      });
    });

    // Take control
    ws2.send(JSON.stringify({ type: "take_control" }));
    await wait(300);

    // Old entry should be dead and replaced
    expect(oldEntry.alive).toBe(false);
    const newEntry = ptySessions.get(session)!;
    expect(newEntry).toBeDefined();
    expect(newEntry).not.toBe(oldEntry);
    expect(newEntry.alive).toBe(true);

    await closeWs(ws2);
    await closeWs(ws1);
    await wait(200);
  });
});
