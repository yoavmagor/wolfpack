/**
 * Wolfpack server — HTTP + WebSocket server creation, CORS, startup.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { WebSocketServer } from "ws";

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import pkg from "../../package.json";
import { validateRequestJwt } from "../auth.js";
import { cleanupOrphanPtySessions, SHELL } from "./tmux.js";
import { routes } from "./routes.js";
import {
  json,
  serveFile,
  shouldAuthenticateApiPath,
  writeUnauthorized,
  isAllowedSession,
  discoverPeers,
  cachedPeers,
  createPerIpRateLimiter,
} from "./http.js";
import { handleTerminalWs, handlePtyWs } from "./websocket.js";
import { createLogger } from "../log.js";

const log = createLogger("server");

const PORT =
  Number(process.env.WOLFPACK_PORT) || Number(process.argv[2]) || 18790;
const VERSION: string = pkg.version;

// inherit user's full PATH from login shell — launchd PATH is minimal
try {
  const shellPath = execFileSync(SHELL, ["-lic", "echo $PATH"]).toString().trim();
  if (shellPath) process.env.PATH = shellPath;
} catch { /* shell PATH extraction failed — apply common fallback paths */
  const extra = [
    `${process.env.HOME}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const cur = process.env.PATH || "";
  const have = new Set(cur.split(":"));
  const add = extra.filter(p => !have.has(p) && existsSync(p));
  if (add.length) process.env.PATH = [...add, cur].join(":");
}

// CORS origin allowlist
const ALLOWED_ORIGINS = new Set<string>([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);

// Extract tailnet suffix from config
const TAILNET_SUFFIX = (() => {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".wolfpack", "config.json"), "utf-8"));
    const h = cfg.tailscaleHostname as string;
    const dot = h.indexOf(".");
    if (dot !== -1) return h.substring(dot + 1);
  } catch { /* config not yet written — handled by warning below */ }
  return "";
})();

if (!TAILNET_SUFFIX) {
  log.warn("no tailscaleHostname in config — remote browser access will be blocked by CORS", { hint: "run 'wolfpack setup' to fix" });
}

function isAllowedOrigin(origin: string): boolean {
  if (process.env.WOLFPACK_TEST && origin.startsWith("http://127.0.0.1:")) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (TAILNET_SUFFIX) {
    try {
      const url = new URL(origin);
      if (url.protocol === "https:" && url.hostname.endsWith("." + TAILNET_SUFFIX)) return true;
    } catch { /* expected: malformed origin URL */ }
  }
  return false;
}

// ── Rate limiting ──

/** Poll-heavy endpoints get a tighter limit (10 req/s per IP). */
const POLL_HEAVY_PATHS = new Set(["/api/sessions", "/api/ralph/log", "/api/ralph"]);
const pollRateLimiter = createPerIpRateLimiter(10);

/** Global limit for all routes (120 req/s per IP). */
const globalRateLimiter = createPerIpRateLimiter(120);

export { pollRateLimiter as __pollRateLimiter, globalRateLimiter as __globalRateLimiter };

// ── Server ──

const wss = new WebSocketServer({ noServer: true });

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    if (isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Vary", "Origin");
    } else {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "origin not allowed" }));
      return;
    }
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  if (shouldAuthenticateApiPath(url.pathname)) {
    const auth = validateRequestJwt(req.headers, url, false);
    if (!auth.ok) {
      writeUnauthorized(res);
      return;
    }
  }

  // Rate limiting — per-IP, checked before route dispatch
  const clientIp = req.socket.remoteAddress ?? "unknown";
  if (!globalRateLimiter.allow(clientIp)) {
    json(res, { error: "rate limit exceeded" }, 429);
    return;
  }
  if (POLL_HEAVY_PATHS.has(url.pathname) && !pollRateLimiter.allow(clientIp)) {
    json(res, { error: "rate limit exceeded" }, 429);
    return;
  }

  const key = `${req.method ?? "GET"} ${url.pathname}`;
  const handler = routes[key];
  if (handler) {
    try {
      await handler(req, res);
    } catch (err) {
      log.error("route error", { error: String(err) });
      if (!res.headersSent) json(res, { error: "internal error" }, 500);
    }
  } else {
    const safePath = url.pathname.replace(/^\/+/, "");
    if (safePath && !safePath.includes("\0") && !safePath.includes("/")) {
      serveFile(res, safePath);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  }
});

server.on("upgrade", async (req, socket, head) => {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const isWsRoute =
    url.pathname === "/ws/terminal" ||
    url.pathname === "/ws/mobile" ||
    url.pathname === "/ws/pty";
  if (isWsRoute) {
    const auth = validateRequestJwt(req.headers, url, true);
    if (!auth.ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  if (url.pathname === "/ws/terminal" || url.pathname === "/ws/mobile") {
    const session = url.searchParams.get("session");
    if (!session || !(await isAllowedSession(session))) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleTerminalWs(ws, session));
  } else if (url.pathname === "/ws/pty") {
    const session = url.searchParams.get("session");
    if (!session || !(await isAllowedSession(session))) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const reset = url.searchParams.get("reset") === "1";
    wss.handleUpgrade(req, socket, head, (ws) => handlePtyWs(ws, session, reset));
  } else {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  }
});

export function startServer(port = PORT, host = "127.0.0.1"): void {
  cleanupOrphanPtySessions();

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error("port already in use", { port, hint: "run 'wolfpack service stop' first" });
      process.exit(1);
    }
    log.error("server error", { error: err.message });
    process.exit(1);
  });

  server.listen(port, host, () => {
    log.info("server started", { url: `http://localhost:${port}/` });
    discoverPeers().then(() => {
      if (cachedPeers.length) log.info("discovered peers", { count: cachedPeers.length, peers: cachedPeers.map(p => p.name) });
    }).catch((e: unknown) => { log.warn("peer discovery failed at startup", { error: e instanceof Error ? e.message : String(e) }); });
  });
}

export { server, wss };

// Auto-start unless in test mode
if (!process.env.WOLFPACK_TEST) {
  startServer();
}
