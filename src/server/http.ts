/**
 * HTTP utilities — session helpers, JSON response, body parsing, file serving, peer discovery.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { assets } from "../public-assets.js";
import { tmuxList } from "./tmux.js";
import { exec } from "./tmux.js";

// ── Session helpers ──

export async function uniqueSessionName(base: string): Promise<string> {
  const sessions = await tmuxList();
  if (!sessions.includes(base)) return base;
  let i = 2;
  while (sessions.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export async function isAllowedSession(session: string): Promise<boolean> {
  const allowed = await tmuxList();
  return allowed.includes(session);
}

// ── HTTP helpers ──

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const PUBLIC_API_PATHS = new Set(["/api/info"]);

export function shouldAuthenticateApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/") && !PUBLIC_API_PATHS.has(pathname);
}

export function writeUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Bearer realm="wolfpack"',
  });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

const MAX_BODY = 64 * 1024; // 64KB

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export async function parseBody<T = any>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  try {
    return JSON.parse(await readBody(req)) as T;
  } catch {
    json(res, { error: "invalid JSON body" }, 400);
    return null;
  }
}

const CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' wss: https:; img-src 'self' data:";

export function serveFile(res: ServerResponse, filename: string): void {
  const asset = assets.get(filename);
  if (!asset) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }
  const headers: Record<string, string> = {
    "Content-Type": asset.mime,
    "Cache-Control": "no-cache",
  };
  if (asset.mime === "text/html") {
    headers["Content-Security-Policy"] = CSP;
  }
  res.writeHead(200, headers);
  res.end(asset.content);
}

// ── Peer discovery ──

// Cached peer list for server-side aggregation (populated by /api/discover)
export let cachedPeers: { url: string; name: string }[] = [];

export async function discoverPeers(): Promise<{ peers: any[]; error?: string }> {
  const tsBin = [
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ].find((p) => { try { execFileSync("test", ["-x", p]); return true; } catch { return false; } });
  if (!tsBin) return { peers: [], error: "tailscale not found" };

  try {
    const { stdout } = await exec(
      "/bin/sh", ["-l", "-c", `"${tsBin}" status --json`],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const status = JSON.parse(stdout);
    const self = status.Self?.DNSName?.replace(/\.$/, "");
    const peers: { hostname: string; url: string }[] = [];
    for (const [, peer] of Object.entries(status.Peer || {}) as [string, any][]) {
      if (!peer.Online) continue;
      const dns = peer.DNSName?.replace(/\.$/, "");
      if (!dns || dns === self) continue;
      peers.push({ hostname: dns, url: `https://${dns}` });
    }

    const results = await Promise.all(
      peers.map(async (p) => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 3000);
          const r = await fetch(p.url + "/api/info", { signal: ctrl.signal });
          clearTimeout(timer);
          const info = await r.json();
          return { ...p, name: info.name || p.hostname, version: info.version, wolfpack: true };
        } catch {
          return { ...p, wolfpack: false };
        }
      }),
    );
    const wolfpackPeers = results.filter((r) => r.wolfpack);
    cachedPeers = wolfpackPeers.map(p => ({ url: p.url, name: p.name }));
    return { peers: wolfpackPeers };
  } catch (e: any) {
    console.error("discover error:", e?.message || e);
    return { peers: [], error: "failed to query tailscale" };
  }
}
