# Wolfpack — Audit Context

Generated: 2026-03-10

## Architecture

```
[Browser] --CORS+JWT--> [HTTP Server (127.0.0.1)] --execFile--> [tmux]
                                                   --spawn--> [ralph-macchio] --spawn--> [AI agent]
                                                   --Bun.spawn PTY--> [tmux attach]
[Tailscale Proxy] --HTTPS--> [HTTP Server (127.0.0.1)]
[Peer wolfpack] --HTTPS--> /api/ralph (aggregation)
```

Server binds `127.0.0.1` only. External access via Tailscale HTTPS proxy. Frontend is a single-file vanilla JS PWA (`public/index.html`) with inline scripts.

## Trust Boundaries

1. **Browser → Server**: CORS origin check (primary gate) + optional JWT (HS256). No-origin requests pass (intentional — for curl/API tools). JWT disabled entirely if secret < 32 chars (fail-open).
2. **Server → tmux**: All tmux calls use `execFile` with array args (no shell expansion). Session allowlist filtered by `DEV_DIR` path containment.
3. **Server → ralph-macchio**: Detached subprocess coordinated via `.ralph.lock` (exclusive `wx` create, PID liveness). Worker inherits server's UID.
4. **ralph-macchio → AI agent**: `--dangerously-skip-permissions` / `--yolo` flags. `ALLOWED_TOOLS` whitelist passed as CLI flag but **not enforced at runtime** — scope is prompt-only (#63).
5. **Server → Tailnet peers**: 3s timeout, auth header forwarded. Compromised peer can return arbitrary data in `loops` array — passed directly to frontend.

## Non-Obvious Security Properties

**JWT fail-open**: Secret < 32 chars → warning emitted AND auth fully disabled. A weak secret doesn't partially enable auth. This means misconfigured installs have zero auth.

**CSP weakness**: `script-src 'unsafe-inline'` required because index.html uses inline scripts. Any XSS would execute. `connect-src` allows wss/https to any origin (needed for peer discovery).

**WS token in query param**: Browser WebSocket API can't set custom headers. `/ws/pty` and `/ws/terminal` accept `?token=` query param. HTTP routes do NOT accept query tokens.

**Two different key allowlists**: HTTP `POST /api/key` uses a SMALLER allowlist than the WS terminal handler's `WS_ALLOWED_KEYS`. The WS set adds Home, End, PgUp, PgDn, BSpace, and many ctrl-key combos.

**PTY overlap dedup**: Server sends scrollback prefill via `capture-pane` before attaching PTY. Initial PTY output that overlaps with prefill is stripped (`__stripInitialPtyOverlap`) to prevent double-rendering. Compares last 32KB of prefill against start of attach output.

**Detach safety**: PTY teardown only fires if `entry.viewer === ws && activePtySessions.get(session) === entry`. Take-control nulls `entry.viewer` BEFORE closing old WS — prevents the old close handler from destroying the replacement entry.

**PTY spawn is deferred**: `setupNewPtyEntry()` creates entry with `proc: null`. First resize message triggers actual `spawnPty()`. This ensures PTY dimensions match the real viewport.

**Ralph PID verification on cancel**: `POST /api/ralph/cancel` runs `ps -p PID -o command=` and checks output contains `ralph-macchio` or `worker` before sending SIGTERM. Guards against PID reuse killing innocent processes.

**Ralph lock atomicity**: Lock acquired with `writeFileSync(path, "", { flag: "wx" })` — OS-level exclusive create. Only one process can create it. EEXIST → 409.

**Agent context injection fallback**: `injectAgentContext()` for Claude produces `cmd --append-system-prompt CONTEXT || cmd`. The `||` fallback means if the flag isn't supported, it runs the bare command. This compound shell command could have unexpected behavior if the first command partially succeeds.

## Complexity Clusters

1. **PTY lifecycle** (`websocket.ts`): Most complex single function. Async races guarded by `alive` flag and entry identity checks. Prefill + overlap dedup + viewer conflict + take-control + deferred spawn.

2. **Ralph lock coordination**: Distributed lock across server process and detached worker. PID liveness detection, stale lock healing, signal-based cleanup across process boundaries.

3. **CORS + JWT two-layer auth**: Different token extraction for HTTP vs WS. Test mode bypass (`WOLFPACK_TEST` allows any `127.0.0.1:*` origin). Fail-open when JWT misconfigured.

## State Map

| State | Invariant |
|-------|-----------|
| `activePtySessions` | Max 1 entry per session; `alive` flag guards cleanup |
| `.ralph.lock` | Exclusive create; PID stored; healed when stale; always cleaned on exit |
| `sessionDirMap` | Populated by `tmuxList()` and `tmuxNewSession()`; authoritative session→dir mapping |
| JWT auth config | Immutable after import-time init; restart required for changes |
| `cachedPeers` | Module-level; refreshed on `/api/discover`; no TTL |

## Shell Execution Safety

All user-influenced shell execution uses `execFile`/`spawn` with array args (no shell expansion). The one exception is `tmuxNewSession()` which constructs `$SHELL -lic ${shellEscape(cmd)}` — `shellEscape()` wraps in single quotes with proper escaping. `execSync(string)` is used only in service.ts for `launchctl`/`systemctl` commands with no user input.
