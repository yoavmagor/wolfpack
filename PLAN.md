# Single PTY Viewer — Fix Desktop Terminal Sizing

## Problem
Multiple PTY viewers per session cause resize conflicts, stale state, and the `cols-1`/`cols` hack. The FitAddon timing races with CSS layout transitions compound the issue.

## Design
- One active PTY viewer per session (like `tmux attach -d`)
- New PTY connection to an already-viewed session gets `viewer_conflict` message
- Client shows "Take Control" button to displace the current viewer
- Mobile (`/ws/terminal` capture-pane) is unaffected — coexists freely with PTY viewer
- Fresh PTY spawned on every takeover — no shared state, no resize conflicts

---

## ~~1. Simplify server PTY model to single viewer~~

**File:** `src/server/websocket.ts`

- Replace `viewers: Set<WebSocket>` with `viewer: WebSocket | null`
- Remove teardown grace timer (15s) — kill PTY immediately when viewer disconnects
- Remove the `cols-1`/`cols` resize hack
- On new WS to occupied session: send `{type: "viewer_conflict"}`, hold connection open
- On `{type: "take_control"}` from pending viewer: close old viewer with code `4002` ("displaced"), tear down old PTY, promote new viewer, spawn fresh PTY on first resize msg
- Keep rate limiting, ping keepalive unchanged

## ~~2. Client handling for viewer conflict + takeover~~

**File:** `public/index.html`

- On receiving `viewer_conflict` message: show overlay on terminal container ("Session active on another device" + "Take Control" button)
- On clicking "Take Control": send `{type: "take_control"}` over same WS
- On receiving close code `4002`: show "Taken over by another viewer" message, do NOT auto-reconnect (show manual reconnect button instead)
- Grid view: same logic per cell — conflict overlay per grid cell

## ~~3. Remove dead multi-viewer code~~

**Files:** `src/server/websocket.ts`, `public/index.html`

- Remove viewer join path for existing PTY (the "second viewer attaches to existing proc" branch)
- Remove `schedulePtyTeardown` / grace timer logic
- Remove multi-viewer broadcast loop (data callback iterates `entry.viewers`) — just send to single viewer
- Update `activePtySessions` type to reflect single viewer
- Clean up `__getActivePtySessions` test hook signature

## ~~4. Update tests~~

**File:** `tests/integration/api.test.ts` (or new test file)

- Test: second PTY connection receives `viewer_conflict`
- Test: `take_control` displaces first viewer (close code 4002)
- Test: displaced viewer does not auto-reconnect
- Test: mobile `/ws/terminal` still works concurrently with PTY viewer
- Test: PTY tears down immediately on viewer disconnect (no grace period)

## ~~5. Deploy + verify~~

- Build binary, deploy, restart service
- Verify single terminal view works (no sizing regressions)
- Verify grid view works (each cell independent)
- Verify takeover flow between two browser tabs
- Verify mobile + desktop concurrent access
