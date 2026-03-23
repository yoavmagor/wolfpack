#!/usr/bin/env bun
/**
 * Test server harness — run with `bun tests/e2e/test-server.ts`.
 *
 * Starts the real wolfpack server with mock tmux stubs on a random port.
 * Prints `READY:<port>` to stdout when listening.
 * Exits on SIGTERM or when stdin closes (parent process dies).
 */
import type { AddressInfo } from "node:net";

process.env.WOLFPACK_TEST = "1";

const { server } = await import("../../src/server/index.ts");
const { __setTestOverrides } = await import("../../src/test-hooks.ts");

// ── Mock tmux ──

const fakeSessions = [
  "test-project",
  "another-project",
  "prompt-project",
  "error-project",
];

const paneContent: Record<string, string> = {
  "test-project": "$ mock-terminal-ready\n",
  "another-project": "$ idle\n",
  "prompt-project": "Building project...\nDo you want to continue? (y/n)\n",
  "error-project": "$ bun test\nError: 3 tests failed\n",
};

__setTestOverrides({
  tmuxList: async () => [...fakeSessions],
  tmuxResize: async () => {},
  capturePane: async (session) => paneContent[session] || "",
  // Stub exec so handlePtyWs doesn't call real tmux
  exec: (async (cmd: string, args?: readonly string[]) => {
    const a = args || [];
    if (a[0] === "has-session") {
      const session = String(a[2] || "");
      if (!fakeSessions.includes(session)) throw new Error("session not found");
      return { stdout: "", stderr: "" };
    }
    if (a[0] === "set-option" || a[0] === "resize-window") {
      return { stdout: "", stderr: "" };
    }
    if (a[0] === "capture-pane") {
      const session = String(a[2] || "");
      return { stdout: paneContent[session] || "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }) as any,
});

// Suppress expected tmux noise
const origError = console.error;
console.error = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (msg.includes("tmux") || msg.includes("WS error") || msg.includes("spawn")) return;
  origError(...args);
};

// ── Listen ──

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  // Signal to parent that we're ready
  console.log(`READY:${port}`);
});

// Exit when parent disconnects
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
