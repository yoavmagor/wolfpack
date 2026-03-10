# Wolfpack — Deep Audit Context Report

Generated: 2026-03-10
Codebase: ~11.8K lines server/CLI TypeScript + 7.4K line single-file frontend SPA
Scope: Full server-side + CLI + ralph worker + frontend surface

---

## Phase 1 — Initial Orientation

### 1.1 Module Map

| Module | Lines | Role |
|--------|-------|------|
| `src/server/routes.ts` | 706 | All HTTP route handlers — the primary API surface |
| `src/ralph-macchio.ts` | 635 | Detached agent loop worker subprocess |
| `src/server/websocket.ts` | 507 | WS terminal (capture-pane) + PTY (xterm.js direct) handlers |
| `src/cli/service.ts` | 336 | launchd/systemd service lifecycle management |
| `src/cli/setup.ts` | 315 | Interactive setup wizard |
| `src/server/tmux.ts` | 226 | tmux exec wrappers, test hooks, capture-pane |
| `src/server/index.ts` | 220 | HTTP + WS server creation, CORS origin checks, JWT gate |
| `src/auth.ts` | 212 | JWT HS256 validation, bearer extraction, config |
| `src/grid-logic.ts` | 199 | Pure grid layout state machine (extracted for testing) |
| `src/server/ralph.ts` | 171 | Ralph log parsing, project scanning, task counting |
| `src/server/http.ts` | 145 | HTTP utils, file serving, peer discovery |
| `src/cli/config.ts` | 144 | Config type, load/save, port mgmt, ask() TTY helper |
| `src/reconnect-logic.ts` | 97 | Reconnect backoff state machine (pure) |
| `src/wolfpack-context.ts` | 89 | Shared context/prompt templates, task header regex, plan validation |
| `src/hydration-logic.ts` | 85 | Hydration state machine for xterm.js initial-load reveal |
| `src/grid-relayout-logic.ts` | 84 | Two-pass grid relayout transition runner |
| `src/validation.ts` | 69 | Regex constants, shell escape, XML/systemd escape, port validation |
| `src/triage.ts` | 38 | Session triage classification (running/needs-input/idle) |
| `src/qr.ts` | 9 | Terminal QR code renderer |
| `src/public-assets.ts` | 19 | Auto-generated embedded assets map |
| `public/index.html` | 7358 | Single-file vanilla JS PWA (all views, WS clients, xterm.js) |

### 1.2 Public Entrypoints

**HTTP API** (all gated by CORS + optional JWT):
- `GET /api/info` — only PUBLIC (unauthenticated) API path
- `GET /api/sessions`, `GET /api/poll`, `GET /api/projects`, `GET /api/settings`
- `POST /api/send`, `POST /api/key`, `POST /api/create`, `POST /api/kill`, `POST /api/resize`, `POST /api/settings`
- `GET /api/discover`, `GET /api/git-status`, `GET /api/next-session-name`
- Ralph: `GET /api/ralph`, `GET /api/ralph/branches`, `GET /api/ralph/plans`, `GET /api/ralph/log`, `GET /api/ralph/task-count`
- Ralph: `POST /api/ralph/start`, `POST /api/ralph/cancel`, `POST /api/ralph/dismiss`

**WebSocket** (all gated by CORS + JWT via query param):
- `/ws/terminal` — capture-pane polling for mobile clients
- `/ws/mobile` — alias for `/ws/terminal`
- `/ws/pty` — direct PTY attach for desktop xterm.js

**Static**:
- `GET /` → `index.html` (with CSP header)
- `GET /manifest.json` → dynamic PWA manifest
- `GET /sw.js` → always 404 (prevents Brave auto-install)
- Unknown single-path-segment → attempts file serve from embedded assets

### 1.3 Actors

| Actor | Trust Level | Entrypoints |
|-------|-------------|-------------|
| Local browser user (localhost) | High — CORS-allowed origin | All HTTP + WS |
| Remote browser user (tailnet) | High — CORS-allowed via `*.TAILNET_SUFFIX` | All HTTP + WS |
| Tailscale HTTPS proxy | Trusted — terminates TLS, forwards to 127.0.0.1 | N/A (transparent) |
| tmux | Trusted — local process, execFile() array args | Invoked by server |
| AI agent (claude/codex/gemini/cursor) | Semi-trusted — spawned by ralph-macchio | Has file system access within PROJECT_DIR |
| launchd / systemd | Trusted — OS service manager | Manages wolfpack daemon |
| Tailnet peers | Semi-trusted — other wolfpack instances on tailnet | `/api/ralph` aggregation with forwarded auth |

### 1.4 Critical State

**Server-side state (in-memory):**
- `activePtySessions: Map<session, {viewer, pendingViewer, proc, alive}>` — tracks active PTY connections
- `prevPaneContent: Map<session, string>` — content-diff triage cache
- `cachedPeers: {url, name}[]` — discovered tailnet wolfpack peers
- `_cachedConfig: JwtAuthConfig` — JWT config cached at import time
- `_triageCacheMap: Map<session, {content, ts}>` — 500ms TTL capture-pane cache

**Filesystem state:**
- `~/.wolfpack/config.json` — `{devDir, port, tailscaleHostname}`
- `~/.wolfpack/bridge-settings.json` — `{agentCmd, customCmds[]}`
- `~/.wolfpack/wolfpack.log` — service stdout/stderr
- `~/.wolfpack/bin/wolfpack` — deployed binary
- Per-project: `.ralph.log`, `.ralph.lock`, `progress.txt`, plan `.md` files

---

## Phase 2 — Ultra-Granular Function Analysis

### 2.1 `src/server/index.ts` — Server Bootstrap & Request Dispatch

#### Purpose
Creates the HTTP server, WebSocket server, CORS enforcement, JWT authentication gate, and route dispatch. This is the outermost security boundary for all inbound traffic.

#### Inputs & Assumptions
- **PORT**: from env `WOLFPACK_PORT`, argv[2], or default 18790
- **TAILNET_SUFFIX**: extracted from `~/.wolfpack/config.json` `tailscaleHostname` field
- **Assumption**: server binds `127.0.0.1` only — external access via Tailscale proxy
- **Assumption**: CORS origin check is the primary access control layer (JWT is optional)

#### Block-by-Block Analysis

**Lines 44-57: PATH inheritance from login shell**
- Runs `$SHELL -lic "echo $PATH"` to inherit full user PATH
- **Why here**: launchd/systemd PATH is minimal; tmux, claude, git need full PATH
- **Risk**: If `$SHELL` is compromised, PATH injection is possible. Low risk — requires local root.
- Fallback adds hardcoded paths (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) if shell exec fails
- **Invariant**: After this block, `process.env.PATH` contains sufficient paths for tmux and agent binaries

**Lines 60-63: CORS allowlist construction**
- Static set: `http://localhost:PORT`, `http://127.0.0.1:PORT`
- **Invariant**: Only local origins are statically trusted

**Lines 66-74: Tailnet suffix extraction**
- Reads config, extracts domain suffix from tailscaleHostname (everything after first dot)
- **Invariant**: If tailscaleHostname is `foo.bar.ts.net`, suffix = `bar.ts.net`
- Empty catch — config read failure is non-fatal (remote access just blocked)

**Lines 80-90: `isAllowedOrigin()`**
- Test mode bypass: any `http://127.0.0.1:*` allowed when `WOLFPACK_TEST` env set
- Static check against `ALLOWED_ORIGINS` set
- Dynamic check: origin URL protocol must be `https:` AND hostname must end with `.{TAILNET_SUFFIX}`
- **First Principles**: Origin validation is the trust boundary. Any bypass = full API access.
- **5 Whys — Why not just check hostname?**: Because HTTP origins could be spoofed on hostile networks; HTTPS + tailnet suffix ensures Tailscale-issued cert validation happened.
- **Invariant**: Only localhost HTTP or tailnet HTTPS origins pass

**Lines 96-144: HTTP request handler**
- CORS check runs first — 403 if origin header present but not allowed
- No-origin requests pass (curl, server-to-server) — **this is intentional for API tools**
- OPTIONS → 204 (preflight)
- JWT check: `shouldAuthenticateApiPath()` → only `/api/info` is exempt
- Route dispatch by exact `"METHOD /path"` string match
- Fallback: single-path-segment files served from embedded assets (no directory traversal — `safePath` strips leading slashes and rejects `\0` and `/`)
- **Invariant**: No request reaches a route handler without passing CORS + JWT gates
- **Assumption**: `safePath` stripping is sufficient — `..` within a single segment is not a path traversal risk because there's no filesystem lookup (only `assets.get()` against an in-memory map)

**Lines 146-192: WebSocket upgrade handler**
- CORS origin check on upgrade (same as HTTP)
- JWT validated on WS routes with `allowQueryToken: true` — allows `?token=` for WS (browsers can't set Authorization on WS)
- Session validation: `isAllowedSession()` checks session exists in tmux list under DEV_DIR
- `/ws/pty` supports `?reset=1` query param — forces PTY teardown before new spawn
- Unknown WS paths → 404
- **5 Hows — How does a WS connection get established?**: Browser sends upgrade → origin checked → JWT validated → session validated → `wss.handleUpgrade()` → handler called
- **Invariant**: No WS connection is established without origin + JWT + session validation

**Lines 194-220: `startServer()`**
- Cleans up orphan `wp_*` tmux sessions on startup
- EADDRINUSE → helpful error message
- Triggers peer discovery after listen
- Auto-starts unless `WOLFPACK_TEST` env set

---

### 2.2 `src/auth.ts` — JWT Authentication

#### Purpose
HS256 JWT validation layer. Optional (disabled when `WOLFPACK_JWT_SECRET` not set). When enabled, gates all `/api/*` paths except `/api/info`.

#### Inputs & Assumptions
- **Secret**: `WOLFPACK_JWT_SECRET` env var, minimum 32 chars
- **Assumption**: Secret is shared between token issuer and wolfpack server
- **Assumption**: HS256 is sufficient (symmetric — both sides are the same operator)

#### Block-by-Block Analysis

**Lines 31-39: `decodeBase64Url()`**
- Validates segment against `BASE64URL_SEGMENT` regex before decoding
- Replaces URL-safe chars, adds padding, decodes
- **Invariant**: Returns Buffer or throws — never returns partial/invalid decode

**Lines 42-48: `parseSegmentJson()`**
- Decodes base64url → parses JSON → validates is plain object (not array)
- **Why validate not-array?**: JWT spec requires header and payload to be objects

**Lines 116-176: `validateJwtHs256()`**
- Splits on `.`, validates exactly 3 parts
- Parses header, validates `alg === "HS256"` — **no algorithm confusion possible**
- Computes HMAC-SHA256, uses `timingSafeEqual` — **timing-safe comparison**
- Length check before `timingSafeEqual` (Node.js requires equal-length buffers)
- Validates `exp`, `nbf`, `iat` claims with configurable clock tolerance (default 30s)
- Optional `iss` and `aud` checks
- **First Principles**: JWT validation must be: correct algorithm → valid signature → not expired → correct claims. All are covered.
- **5 Whys — Why check `iat` for future?**: Prevents tokens that claim to be issued in the future, which could indicate clock manipulation or replay from a compromised system.
- **Invariant**: Returns `{ok: true, payload}` only if ALL checks pass

**Lines 78-101: `getJwtAuthConfig()`**
- Secret < 32 chars → warning emitted AND auth disabled (not just warned)
- **This is important**: A weak secret doesn't partially enable auth, it fully disables it. This is a fail-open behavior — but the alternative (fail-closed with weak secret) would lock out the user.
- **Invariant**: `enabled` is true ONLY when secret is ≥ 32 chars

**Lines 104-114: `getRequestToken()`**
- Checks `Authorization: Bearer <token>` header first
- Falls back to `?token=` query param ONLY when `allowQueryToken` is true
- HTTP routes use `allowQueryToken: false`, WS uses `true`
- **5 Whys — Why allow query token for WS?**: Browser WebSocket API can't set custom headers. The `token` query param is the standard workaround.

**Lines 196-212: `validateRequestJwt()`**
- If auth disabled → returns `{ok: true}` (bypass)
- If auth enabled but no token → `{ok: false, error: "missing bearer token"}`
- **Invariant**: Auth is all-or-nothing. No partial validation states.

---

### 2.3 `src/validation.ts` — Input Validation & Shell Escaping

#### Purpose
Pure validation functions. Zero side effects. Used across server, CLI, and tests.

#### Block-by-Block Analysis

**Lines 8-14: `WS_ALLOWED_KEYS`**
- 24-member Set of allowed tmux key names
- Includes navigation (arrows, Home, End, PgUp, PgDn), control chars (C-a through C-z subset), y/n for confirmations
- **Invariant**: Only these keys can be sent via WS `key` messages
- **5 Whys — Why `y` and `n`?**: For answering confirmation prompts in agent sessions (e.g., "Proceed? y/n")

**Lines 18-20: Regex patterns**
- `CMD_REGEX`: `/^[a-zA-Z0-9 \-._/=]+$/` — alphanumeric + space, dash, dot, underscore, slash, equals
- `BRANCH_REGEX`: `/^[a-zA-Z0-9._\-/]+$/` — same without space and equals
- `PLAN_FILE_REGEX`: `/^[a-zA-Z0-9._\- ]+\.md$/` — must end in `.md`, allows spaces
- **Invariant**: No shell metacharacters (`;`, `|`, `&`, `$`, backtick, etc.) pass these regexes

**Lines 24-29: Name validators**
- `isValidProjectName`: alphanum + `._-`, explicitly rejects `.` and `..`
- `isValidSessionName`: alphanum + `_-`, length 1-100
- **5 Whys — Why reject `.` and `..`?**: Prevents path traversal when project name is joined with `DEV_DIR`

**Lines 54-55: `shellEscape()`**
- Single-quote wrapping with `'` → `'\''` replacement
- **First Principles**: Single-quote context in shell allows no interpretation except the end-quote. The `'\''` pattern: end quote, escaped literal quote, restart quote.
- **Invariant**: Output is always a single-quoted string that shell will interpret literally

**Lines 60-63: `xmlEsc()`**
- Escapes `&`, `<`, `>`, `"`, `'` — the XML5 entities
- **Invariant**: Output is safe for XML attribute and text content contexts
- **Assumption**: Only used for plist generation, not for HTML (which would need additional contexts)

**Lines 67-69: `systemdEsc()`**
- Escapes `\`, `"`, strips newlines
- Used for systemd unit `Environment=` directives
- **Invariant**: Output is safe inside double-quoted systemd environment values

---

### 2.4 `src/server/routes.ts` — HTTP Route Handlers

#### Purpose
All HTTP API route handlers. This is the largest file and the primary attack surface for authenticated API access.

#### Inputs & Assumptions
- All routes are behind CORS + JWT gates (enforced in `index.ts`)
- `DEV_DIR` is the trusted root for project directories
- `TMUX` is the tmux binary name (not path — relies on PATH)
- **Assumption**: `isAllowedSession()` is the canonical check for session existence

#### Critical Function Analysis

##### `validateProject()` (lines 53-59)
- Calls `isValidProjectName()` — rejects shell metacharacters, `.`, `..`
- Returns typed predicate for TypeScript narrowing
- Used by ALL project-accepting endpoints
- **Invariant**: After this check, project name is safe to join with `DEV_DIR`

##### `validateProjectDir()` (lines 62-73)
- `lstatSync` → rejects symlinks
- `statSync` → confirms is directory
- **5 Whys — Why reject symlinks?**: Prevents symlink-following attacks where an attacker creates `~/Dev/evil -> /etc` and then uses the API to read/write arbitrary files
- **Invariant**: After this check, `join(DEV_DIR, project)` is a real directory (not symlink)

##### `POST /api/send` (lines 212-222)
- Validates session exists via `isAllowedSession()`
- Passes text through `tmuxSend()` which uses `execFile` with array args (no shell expansion)
- `send-keys -l` sends text literally (no tmux key bindings interpreted)
- `noEnter` flag controls whether Enter is sent after text
- **Invariant**: Text is sent literally to tmux pane — no command injection possible via this route

##### `POST /api/key` (lines 224-239)
- Validates session, then checks key against inline allowlist (subset of `WS_ALLOWED_KEYS`)
- **Note**: The HTTP route uses a DIFFERENT, smaller allowlist than the WS handler
- HTTP allows: Enter, Tab, Escape, arrows, BTab, y, n, C-c, C-d, C-z
- WS allows: all of above PLUS BSpace, DC, Home, End, PPage, NPage, C-a, C-b, C-e, C-f, C-g, C-h, C-k, C-l, C-n, C-p, C-r, C-u, C-w
- **Invariant**: Only safe tmux key names reach `tmuxSendKey()`

##### `POST /api/create` (lines 255-287)
- Validates project name, validates cmd against `CMD_REGEX` (or `"shell"`)
- Optional `sessionName` validated with `isValidSessionName()` + uniqueness check
- For `newProject`: creates directory with `mkdirSync(recursive: true)` — **but only after validating project name** (no traversal)
- Validates project dir exists and is not symlink
- Creates tmux session via `tmuxNewSession()`
- **5 Hows — How does a session get created?**: Validate project → validate cmd → validate sessionName → create dir if new → validate dir → generate unique name → spawn tmux session with agent context injection

##### `POST /api/kill` (lines 330-342)
- Validates session exists
- Tears down associated PTY
- Clears triage cache
- Kills tmux session via `kill-session -t`
- **Invariant**: Only sessions under DEV_DIR can be killed (enforced by `isAllowedSession`)

##### `POST /api/ralph/start` (lines 517-621)
- **This is the most complex endpoint.** Analysis:
  1. Validates project name and directory (including symlink check)
  2. Checks for existing active ralph loop (log parse + PID check)
  3. Lock file handling: checks existing lock, validates PID, heals stale locks
  4. Creates lock with `wx` flag (exclusive create — atomic)
  5. Optional branch creation: validates branch names, fetches source, creates new branch
  6. Validates plan file name and existence
  7. Spawns detached worker process
  8. Writes PID to lock file
- **Lock contention handling**: `wx` flag means only ONE process can create the lock. EEXIST → 409.
- **Stale lock detection**: Reads PID from lock, `kill(pid, 0)` to check if alive, removes if dead.
- **Branch creation**: `git fetch origin source:source` → `git checkout -b newBranch source`. Both branch names validated against `BRANCH_REGEX`.
- **5 Whys — Why re-declare BRANCH_REGEX locally?**: This is a local re-declaration of the same regex from validation.ts. Likely a copy-paste artifact — the import exists at top but is shadowed.
- **Worker spawn**: Uses `RALPH_BIN_ARGS` to resolve between bun runtime and compiled binary. Detached + unref'd so it survives server restart.
- **Invariants**:
  - Only one ralph loop per project (lock file)
  - All branch/plan names validated against safe regexes
  - Worker PID tracked in lock file
  - Worker spawned as current user (inherits server's UID)

##### `POST /api/ralph/cancel` (lines 638-663)
- Validates project, parses log, checks PID > 1
- **PID ownership verification**: Runs `ps -p PID -o command=` and checks output contains `ralph-macchio` or `worker`
- Sends SIGTERM to PID and process group (-PID)
- **5 Whys — Why check ps output?**: PID reuse — if the ralph process died and another process got the same PID, we'd kill an innocent process. The ps check is a safety guard.
- **Invariant**: Only ralph-macchio/worker processes can be killed via this endpoint

##### `POST /api/ralph/dismiss` (lines 665-706)
- Cannot dismiss active loops (409)
- Deletes `.ralph.log`, `.ralph.lock`, and optionally progress file and plan file
- All filenames validated against `SAFE_FILENAME` regex AND no `..`
- **Invariant**: Only safe filenames within project dir are deleted

##### `GET /api/ralph/log` (lines 487-515)
- Reads last 128KB of `.ralph.log` via fd + positional read
- Returns last 500 lines
- **Invariant**: Maximum response size is bounded

##### `GET /api/ralph` (lines 404-438) — Aggregation endpoint
- Optionally aggregates ralph loops from tailnet peers
- Forwards auth header to remote peers
- 3-second timeout per peer
- **Assumption**: Tailnet peers are trusted wolfpack instances
- **Risk**: If a peer is compromised, it could return arbitrary data in the `loops` array. This data is passed directly to the frontend.

##### `GET /api/git-status` (lines 378-400)
- Strips dedup suffix (`-2`, `-3`) from session name to get project name
- Validates as project name, checks session exists
- Runs `git status --short --branch` in project dir
- **Note**: Uses session name as project name lookup — assumes session names start with project names

##### `GET /api/discover` (lines 362-366)
- Triggers peer discovery and returns results
- No project/session validation needed

---

### 2.5 `src/server/websocket.ts` — WebSocket Handlers

#### Purpose
Two WebSocket protocols: terminal (mobile, capture-pane polling) and PTY (desktop, direct xterm.js). The PTY handler is the most complex single function in the codebase.

#### Critical State

**`activePtySessions: Map<string, Entry>`**
- Key: tmux session name
- Value: `{viewer: WebSocket|null, pendingViewer: WebSocket|null, proc: BunSpawnResult, alive: boolean}`
- **Invariant**: At most one active PTY entry per session at any time
- **Invariant**: `alive === false` means the entry is dead and should be cleaned up

#### Terminal WS Handler (`handleTerminalWs`, lines 98-193)

- Polls tmux `capture-pane` every 50ms
- Sends full pane content only when changed (diff-only)
- Session existence re-checked every 1 second (not every poll — performance)
- Rate limiting: 60 msg/s token bucket
- Ping keepalive: 25s interval
- Input types: `input` (literal text), `key` (allowlisted), `resize` (clamped)
- **Invariant**: Key messages validated against `WS_ALLOWED_KEYS` Set
- **Invariant**: Resize values clamped (20-300 cols, 5-100 rows)
- Message size guard: rejects messages > 65536 bytes
- **5 Whys — Why check session periodically vs. every poll?**: Performance. `isAllowedSession()` calls `tmuxList()` which execs `tmux list-sessions`. At 50ms polling, that's 20 tmux execs/sec/client. The 1-second cache reduces to 1/sec.

#### PTY WS Handler (`handlePtyWs`, lines 216-507)

**This is the most complex handler. Full analysis:**

**Lifecycle: Connection → Entry lookup → Spawn or conflict → Data relay → Cleanup**

**Connection handling (lines 216-295):**
1. If `reset=1`: tear down existing PTY and create fresh
2. If existing alive entry: send `viewer_conflict`, hold new WS as `pendingViewer`
3. Pending viewer can send `take_control` message to displace current viewer
4. If no existing entry: create new via `setupNewPtyEntry()`

**Viewer conflict protocol:**
- Current viewer gets `4002 displaced` close
- Pending viewer's handlers are removed before promotion (prevents duplicate handlers)
- Old PTY proc killed before spawning new one
- **5 Hows — How does take_control work?**: pendingViewer sends `{type:"take_control"}` → old viewer nulled → old viewer closed → old proc killed → entry deleted → `setupNewPtyEntry()` called for new viewer → `control_granted` sent

**PTY spawn (`spawnPty`, lines 309-434):**
1. Guards: returns if proc already exists or currently spawning
2. Verifies tmux session exists (`has-session`)
3. Sets tmux `window-size latest` option (allows resize-window to work)
4. **Prefill**: captures scrollback via `capture-pane -S -5000` and sends to viewer
5. Spawns `tmux attach-session -t session` via `Bun.spawn` with `terminal` option (PTY)
6. **Overlap dedup**: strips initial PTY output that overlaps with prefill to prevent duplicate content
7. Post-spawn resize: after 100ms, re-applies latest requested size to both terminal and tmux window

**Overlap dedup logic (`__stripInitialPtyOverlap`, lines 71-94):**
- Compares tail of prefill buffer with start of attach output
- Finds longest overlap and strips it from attach output
- If entire attach buffer is overlap → returns `awaitingMore: true` (waits for more data)
- Limit: only checks last 32KB of prefill for overlap
- **Invariant**: Client never sees the same content twice (once from prefill, once from attach)

**Data relay (lines 439-488):**
- JSON messages: `attach` (bootstrap handshake), `resize` (debounced 80ms)
- Binary messages: stdin → PTY (size guard: 16KB max)
- **Resize debouncing**: prevents storms of resize events from crashing TUI apps
- Rate limiting: 60 msg/s token bucket (same as terminal handler)
- **Invariant**: Binary input > 16KB silently dropped

**Cleanup (`detach`, lines 496-506):**
- Only tears down if the detaching WS is still the current viewer for this entry
- Prevents race: if a new entry replaced the old one (e.g., reset=1), old viewer's detach doesn't destroy new entry
- **Invariant**: `teardownPty()` only called if `entry.viewer === ws && activePtySessions.get(session) === entry`

---

### 2.6 `src/server/tmux.ts` — tmux Wrappers

#### Purpose
All tmux interactions go through these wrappers. Test hooks allow mocking in tests.

#### Critical Functions

**`tmuxList()` (lines 40-73):**
- Lists sessions with pane current path
- Filters to sessions whose pane path starts with `DEV_DIR`
- Filters out `wp_*` sessions (desktop PTY helper sessions)
- **Invariant**: Only sessions under DEV_DIR are visible to the API
- **This is the security boundary**: sessions outside DEV_DIR are invisible

**`tmuxSend()` (lines 79-85):**
- Uses `send-keys -l` for literal text (no key bindings)
- Sends Enter separately after 50ms delay
- **5 Whys — Why the 50ms delay?**: tmux sometimes drops the Enter if sent immediately after text. The delay ensures the text is processed first.

**`tmuxNewSession()` (lines 197-211):**
- `agentCmd === "shell"` → plain shell session
- Otherwise → injects agent context via `injectAgentContext()`
- Unsets `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` env vars to prevent nested Claude Code conflicts
- Command wrapped in `$SHELL -lic 'cmd; exec $SHELL'` — interactive login shell that falls back to shell on agent exit
- **Invariant**: Agent command is always validated against `CMD_REGEX` before reaching this function

**`injectAgentContext()` (lines 182-195):**
- Claude: appends `--append-system-prompt` with INTERACTIVE_CONTEXT, with `|| agentCmd` fallback (if flag not supported)
- Gemini: uses `-i` flag
- Other agents: no context injection
- **Assumption**: `shellEscape()` on the context string prevents injection

**`cleanupOrphanPtySessions()` (lines 215-224):**
- Kills all `wp_*` tmux sessions on server startup
- **Why**: wp_ sessions are ephemeral PTY helpers that should not survive server restarts

---

### 2.7 `src/server/http.ts` — HTTP Utilities

#### Purpose
Session helpers, JSON response, body parsing, file serving, peer discovery.

#### Critical Functions

**`isAllowedSession()` (lines 20-23):**
- Calls `tmuxList()` and checks if session name is in the list
- **Invariant**: This function is called before ANY session-specific operation
- **Note**: `tmuxList()` already filters to DEV_DIR sessions and excludes `wp_*`

**`parseBody()` (lines 66-73):**
- 64KB max body size (enforced in `readBody`)
- Request destroyed if body exceeds limit
- **Invariant**: No route handler ever receives > 64KB of POST data

**`serveFile()` (lines 77-93):**
- Looks up filename in embedded `assets` map
- CSP header applied to HTML files: `default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' wss: https:; img-src 'self' data:`
- **Note**: `script-src 'unsafe-inline'` is required because index.html uses inline scripts. This weakens CSP significantly — any XSS would execute.
- **Invariant**: Only files in the embedded assets map are served. No filesystem access.

**`discoverPeers()` (lines 100-145):**
- Finds tailscale binary, runs `tailscale status --json`
- For each online peer: probes `https://peer.dns/api/info` with 3s timeout
- Only peers that respond with wolfpack info are returned
- Cached in module-level `cachedPeers`
- **Note**: Uses `/bin/sh -l -c` to run tailscale — different from other exec calls. The quoting is `"${tsBin}" status --json` which should be safe since `tsBin` comes from hardcoded paths.

---

### 2.8 `src/server/ralph.ts` — Ralph Log Parsing

#### Purpose
Parses `.ralph.log` files, scans for active/completed loops, counts plan tasks.

#### Critical Functions

**`parseRalphLog()` (lines 60-158):**
- Reads header fields (agent, plan, progress, started, pid)
- Parses iteration markers (both old "Iteration" and new "Wax On" format)
- **Active detection**: `process.kill(pid, 0)` — checks if PID is alive without sending signal
- Stale lock cleanup: if PID dead, removes `.ralph.lock`
- Completion detection: all tasks done AND process not active
- Cleanup detection: "Wax Off" started but not completed
- **Invariant**: `active === true` only when PID is alive (verified via kill(0))

**`scanRalphLoops()` (lines 160-171):**
- Iterates all DEV_DIR projects, parses each `.ralph.log`
- Filters out loops where plan file no longer exists
- **Used by**: `GET /api/ralph` endpoint

---

### 2.9 `src/ralph-macchio.ts` — Agent Worker Process

#### Purpose
Detached subprocess that iteratively runs AI agents on plan file tasks. Spawned by `POST /api/ralph/start`.

#### Inputs & Assumptions
- Receives args via CLI: `--iterations`, `--plan`, `--agent`, `--progress`, `--format`
- Runs in project directory (CWD)
- **Assumption**: Has full filesystem access within PROJECT_DIR (no sandbox)
- **Assumption**: AI agents (claude, codex, gemini, cursor) are trusted to run with `--dangerously-skip-permissions` or `--yolo`

#### Critical Flow

1. **Initialization**: Parse args, resolve agent binary, augment PATH, create log/progress files
2. **Optional format pass**: Runs agent to renumber plan headers
3. **Validation**: `validatePlanFormat()` — exits if plan has no parseable tasks
4. **Iteration loop**:
   a. Extract first unchecked task from plan
   b. Snapshot plan state (for corruption detection)
   c. Run agent with task prompt
   d. Check for plan corruption (task count shrinkage)
   e. Handle subtask breakdown (capped at 5 expansions)
   f. Mark task done (strikethrough or checkbox)
5. **Cleanup pass** ("Wax Off"): If all tasks complete, runs dead code cleanup agent
6. **Summary**: Logs duration, tasks completed, files changed

#### Security-Relevant Details

**Agent spawning (lines 331-368):**
- Claude: `--print --dangerously-skip-permissions --allowedTools ALLOWED_TOOLS -p prompt`
- Codex: `exec prompt --yolo`
- Gemini: `-p prompt --yolo`
- **ALLOWED_TOOLS whitelist**: Edit, Write, Read, Glob, Grep, and specific Bash patterns (git, npm, bun, cargo, etc.)
- **Note**: `Bash(rm *)` is in the allowed tools — agents can delete files
- Agent output piped to `.ralph.log`

**Plan corruption detection (lines 510-528):**
- Compares task counts before and after agent run
- If counts shrink: runs recovery agent to restore plan from snapshot
- If recovery fails: restores plan from pre-iteration snapshot
- **Invariant**: Plan file task count never decreases (self-healing)

**Signal handling (lines 370-383):**
- SIGTERM → kills active child, writes log footer, removes lock, exits
- Process.on("exit") → removes lock (last-resort cleanup)
- **Invariant**: Lock file is always cleaned up on exit (normal, signal, or crash)

**Subtask expansion (lines 537-556):**
- Capped at `MAX_SUBTASK_EXPANSIONS = 5`
- Each expansion adds 1 extra iteration (up to `MAX_CEILING = max(ITERATIONS*2, 100)`)
- Parent task marked done after subtask emission
- Same-task-twice guard: if same task picked after subtask emission, force-marks parent done

---

### 2.10 `src/cli/service.ts` — Service Management

#### Purpose
Manages launchd (macOS) and systemd (Linux) service lifecycle.

#### Security-Relevant Details

**Plist generation (lines 67-105):**
- Uses `xmlEsc()` for all dynamic values
- Static PATH in plist: `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`
- Environment variables set: `WOLFPACK_SERVICE=1`, `WOLFPACK_DEV_DIR`, `WOLFPACK_PORT`
- **Invariant**: Plist is valid XML with escaped values

**systemd unit generation (lines 115-138):**
- Uses `systemdEsc()` for environment values
- `Restart=always`, `RestartSec=5`
- **Note**: `loginctl enable-linger` called with `sudo` — validates username against `^[a-z_][a-z0-9_-]*$` before passing to sudo

**Port management:**
- `killPortHolder()`: finds PID on port via `lsof -i :PORT -t` (macOS) or `ss` (Linux), sends SIGTERM
- Called during service install/start to clear stale processes
- **Invariant**: Only PID > 1 is killed (prevents killing init)

**`uninstall()` (lines 326-336):**
- Calls `serviceUninstall()` then `rmSync(WOLFPACK_DIR, {recursive: true, force: true})`
- Does NOT remove the binary itself (just the config/state directory)

---

### 2.11 Frontend (`public/index.html`) — Surface Analysis

#### Purpose
Single-file vanilla JS PWA. All views, WebSocket clients, xterm.js integration.

#### XSS Protection

**`esc()` function** (identified via grep):
- HTML entity encoding for `&`, `<`, `>`, `"`, `'`
- Used on all `innerHTML` assignments
- **`escAttr()`**: JS string context escaping (for use inside JS string literals in attributes)

#### WebSocket Client Behavior

- **Terminal WS**: Sends `input`, `key`, `resize` messages
- **PTY WS**: Binary stdin passthrough, JSON `resize`/`attach` messages
- Reconnect logic with exponential backoff (extracted to `reconnect-logic.ts`)

#### CSP Analysis
- `script-src 'unsafe-inline'` — weakens XSS protection significantly
- `connect-src 'self' wss: https:` — allows WS and HTTPS connections to any origin (needed for peer discovery)
- `img-src 'self' data:` — only self and data URIs

---

## Phase 3 — Global System Understanding

### 3.1 State & Invariant Map

| State | Reads | Writes | Invariants |
|-------|-------|--------|------------|
| tmux sessions | `tmuxList()` | `tmuxNewSession()`, `kill-session` | Only DEV_DIR sessions visible; wp_ filtered |
| `activePtySessions` | WS handlers, resize route | `handlePtyWs`, `teardownPty` | Max 1 entry per session; alive flag guards cleanup |
| `.ralph.lock` | ralph/start, parseRalphLog | ralph/start, ralph-macchio exit | Exclusive create (wx); PID stored; healed on stale |
| `.ralph.log` | ralph/log, parseRalphLog | ralph-macchio | Append-only during iteration; header written at start |
| `~/.wolfpack/config.json` | loadConfig, server startup | saveConfig (setup only) | Validated on load; port + devDir required |
| `bridge-settings.json` | loadSettings | saveSettings | agentCmd validated against CMD_REGEX |
| JWT auth cache | validateRequestJwt | import-time init | Immutable after init; restart required for changes |

### 3.2 Trust Boundaries

```
[Browser] --CORS+JWT--> [HTTP Server (127.0.0.1)] --execFile--> [tmux]
                                                   --spawn--> [ralph-macchio] --spawn--> [AI agent]
                                                   --Bun.spawn PTY--> [tmux attach]
[Tailscale Proxy] --HTTPS--> [HTTP Server (127.0.0.1)]
[Peer wolfpack] --HTTPS--> /api/ralph (aggregation)
```

**Trust boundary 1**: Browser → Server (CORS + JWT)
**Trust boundary 2**: Server → tmux (execFile array args, validated inputs)
**Trust boundary 3**: Server → ralph-macchio (detached subprocess, lock file coordination)
**Trust boundary 4**: ralph-macchio → AI agent (--dangerously-skip-permissions, ALLOWED_TOOLS whitelist)
**Trust boundary 5**: Server → Tailnet peers (3s timeout, auth forwarding)

### 3.3 Workflow Reconstruction

**Session lifecycle:**
`POST /api/create` → `tmuxNewSession()` → tmux session exists → `GET /api/sessions` returns it → WS connect → interact → `POST /api/kill` → `teardownPty()` + `kill-session`

**Ralph loop lifecycle:**
`POST /api/ralph/start` → lock acquired → worker spawned → iterations → tasks marked done → cleanup pass → lock removed → `GET /api/ralph` shows completed

**PTY connection lifecycle:**
`/ws/pty?session=X` → `setupNewPtyEntry()` → client sends `attach` → `spawnPty()` → prefill sent → PTY data relayed → client disconnects → `detach()` → `teardownPty()`

**Viewer conflict lifecycle:**
Second viewer connects → `viewer_conflict` sent → second viewer sends `take_control` → old viewer closed → old PTY killed → new PTY spawned → `control_granted` sent

### 3.4 Complexity & Fragility Clusters

1. **PTY lifecycle management** (`websocket.ts:setupNewPtyEntry/spawnPty`): Most complex single function. Multiple async operations, race conditions guarded by `alive` flag and entry identity checks. Prefill + overlap dedup adds significant complexity.

2. **Ralph lock coordination** (`routes.ts:POST /api/ralph/start` + `ralph-macchio.ts`): Distributed lock with PID-based liveness detection. Stale lock healing, exclusive create, and signal-based cleanup across process boundaries.

3. **CORS + JWT auth flow** (`index.ts` + `auth.ts`): Two-layer auth (CORS origin + optional JWT). Different token extraction for HTTP vs WS. Test mode bypass. Fail-open when JWT secret too short.

4. **Session identity resolution**: Session names serve as both tmux session identifiers and project name proxies (e.g., `git-status` strips `-2` suffix). This coupling could break if naming conventions change.

5. **Agent context injection** (`tmux.ts:injectAgentContext`): Shell command construction with `shellEscape()`. The `|| agentCmd` fallback creates a compound shell command that could have unexpected behavior if the first command partially succeeds.

---

## Cross-Cutting Observations

### Input Validation Coverage

| Input | Validated By | Where Checked |
|-------|-------------|---------------|
| Project name | `isValidProjectName()` + `validateProjectDir()` | routes.ts |
| Session name | `isAllowedSession()` (existence check) | routes.ts, index.ts (WS) |
| Agent command | `CMD_REGEX` | routes.ts (settings, create) |
| Key presses | `WS_ALLOWED_KEYS` Set or inline allowlist | websocket.ts, routes.ts |
| Cols/rows | `clampCols()`/`clampRows()` | validation.ts |
| Plan filename | `PLAN_FILE_REGEX` + no `..` | routes.ts |
| Branch name | `BRANCH_REGEX` | routes.ts |
| HTTP body size | 64KB max | http.ts |
| WS message size | 65536 bytes (terminal), 16384 bytes (PTY binary) | websocket.ts |
| JWT token | Full HS256 validation chain | auth.ts |
| Origin header | `isAllowedOrigin()` | index.ts |

### Shell Command Execution Patterns

| Pattern | Used In | Safety |
|---------|---------|--------|
| `execFile(cmd, [...args])` | tmux.ts, routes.ts | Safe — array args, no shell |
| `execFileSync(cmd, [...args])` | tmux.ts, config.ts, service.ts, routes.ts, ralph.ts | Safe — array args |
| `execSync(string)` | service.ts (launchctl, systemctl) | Less safe — single string, but no user input |
| `spawn(cmd, [...args])` | ralph-macchio.ts, routes.ts | Safe — array args |
| `Bun.spawn([cmd, ...args])` | websocket.ts | Safe — array args |
| `$SHELL -lic ${shellEscape(cmd)}` | tmux.ts (new session) | Safe — shellEscape wraps in single quotes |

### File System Access Patterns

| Operation | Scoped To | Guard |
|-----------|-----------|-------|
| Read plan/log files | `DEV_DIR/project/` | `validateProject()` + `validateProjectDir()` |
| Write settings | `~/.wolfpack/` | Hardcoded path |
| Delete files (dismiss) | `DEV_DIR/project/` | SAFE_FILENAME regex + no `..` |
| Create directories (new project) | `DEV_DIR/` | `validateProject()` |
| Serve static files | Embedded assets map | No filesystem access |

---

*This report covers Phase 1 (orientation), Phase 2 (function-level analysis), and Phase 3 (system understanding). It is a context-building document — no vulnerabilities are identified, no fixes proposed, no severity ratings assigned.*
