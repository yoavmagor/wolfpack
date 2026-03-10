# Terminal Lifecycle Inventory (Phase 1)

Captures current behavior of the two desktop PTY terminal stacks before refactoring.

## Architecture Overview

```
                         ┌─────────────────────┐
                         │  Server: websocket.ts│
                         │  handlePtyWs()       │
                         │  setupNewPtyEntry()  │
                         │  activePtySessions   │
                         └────────┬────────────┘
                                  │ /ws/pty
                    ┌─────────────┴──────────────┐
                    │                            │
         ┌──────────▼──────────┐     ┌───────────▼──────────┐
         │ Single Desktop View │     │ Grid Cell View        │
         │ initDesktopTerminal │     │ renderGridCells       │
         │ connectDesktopWs    │     │ connectGridCellWs     │
         │ destroyDesktopTerm  │     │ removeFromGrid        │
         └─────────────────────┘     └───────────────────────┘
```

## Server-Side (websocket.ts) — Single Shared Implementation

Already unified. No duplication here.

| Responsibility | Implementation |
|---|---|
| PTY spawn | `setupNewPtyEntry()` → `spawnPty()` — spawns `tmux attach-session` with Bun.spawn terminal mode |
| Viewer tracking | `activePtySessions` Map — one viewer + one pendingViewer per session |
| Conflict detection | `handlePtyWs()` sends `viewer_conflict` if session already occupied |
| Take-control | `pendingMessage()` handles `take_control` — nulls old viewer, tears down old proc, promotes pending |
| Resize | First resize triggers `spawnPty()`; subsequent resizes call `proc.terminal.resize()` + `tmux resize-window` |
| Scrollback prefill | `capture-pane -e -S -${DESKTOP_PREFILL_HISTORY_LINES}` sent as raw binary before PTY stream |
| Window-size policy | Forces `window-size latest` on session so resize-window works |
| Cleanup | `teardownPty()` — marks dead, deletes from map, closes viewer/pendingViewer, kills proc |
| Detach guard | Only tears down if `entry.viewer === ws && activePtySessions.get(session) === entry` |
| Rate limiting | 60 msg/s token bucket (same as mobile terminal WS) |

## Client-Side: Single Desktop Terminal

**State variables:**
- `desktopTerm` — xterm.js Terminal instance
- `desktopFitAddon` — FitAddon instance
- `desktopSearchAddon` — SearchAddon instance
- `desktopWs` — WebSocket connection
- `desktopResizeHandler` — window resize listener ref
- `desktopInitialPrefillPending` — bool, true until first data arrives
- `desktopInitialPrefillTimer` — timeout fallback for reveal
- `desktopReconnectTimer`, `desktopReconnectDelay`, `desktopReconnectStartedAt`, `desktopRetryBlocked` — reconnect state

**Functions:**
| Function | Role |
|---|---|
| `initDesktopTerminal(cached?)` | Creates Terminal, loads addons, opens in container, connects WS |
| `connectDesktopWs()` | Opens `/ws/pty` WS, wires onopen/onmessage/onclose |
| `destroyDesktopTerminal()` | Full cleanup: timers, WS, resize handler, search addon, term dispose |
| `finishDesktopInitialPrefill()` | Clears pending flag, reveals container, scrollToBottom, focus |
| `scheduleDesktopReconnect()` | Exponential backoff (1.8x), budget-capped (RECONNECT_BUDGET_MS) |
| `showDesktopConflictOverlay(ws)` | Renders "Take Control" button overlay |
| `removeDesktopConflictOverlay()` | Removes overlay by ID |

## Client-Side: Grid Cell Terminal

**State variables:**
- `gridSessions[]` — array of `{session, machine, term, ws, fitAddon, searchAddon, reconnectTimer, reconnectDelay, reconnectStartedAt, retryBlocked, initialPrefillPending, initialPrefillTimer}`
- `gridFocusIndex` — which cell accepts stdin
- `gridResizeHandler` — window resize listener ref

**Functions:**
| Function | Role |
|---|---|
| `renderGridCells()` | Creates DOM cells, mounts xterm per cell, deferred fit+connect |
| `connectGridCellWs(gs)` | Opens `/ws/pty` WS for one grid cell |
| `finishGridCellInitialPrefill(gs)` | Reveals cell, scrollToBottom, focus if focused |
| `scheduleGridCellReconnect(gs)` | Exponential backoff, same policy as single |
| `showGridCellConflictOverlay(gs, ws)` | Per-cell "Take Control" overlay |
| `removeGridCellConflictOverlay(gs)` | Removes overlay from cell |
| `setGridFocus(idx)` | Updates disableStdin/cursorBlink, cell highlights, syncs sidebar |
| `addToGrid(session, machine)` | Adds session, handles single→grid transition |
| `removeFromGrid(idx)` | Cleanup + splice, handles grid→single transition |
| `exitGridMode()` | Destroys all grid, restores single terminal |
| `fitAllGridCells()` | Calls fitAddon.fit() on all cells |

## Shared Behavior (duplicated between both stacks)

### 1. xterm.js Construction
| Aspect | Single | Grid |
|---|---|---|
| Terminal options | cursorBlink, fontSize, lineHeight, fontFamily, theme, scrollback, allowProposedApi | Same but fontSize-2, lower scrollback (GRID_TERMINAL_SCROLLBACK) |
| Addons | FitAddon, SearchAddon, Unicode11Addon, CanvasAddon | Same set |
| Copy handler | Cmd/Ctrl+C with selection → clipboard | Identical logic |
| Paste handler | Cmd/Ctrl+V → clipboard read → ws.send | Identical but checks `gridSessions[gridFocusIndex] === gs` |
| stdin (onData) | `desktopWs.send(new TextEncoder().encode(data))` | Same but guarded by focus index |
| stdin (onBinary) | Same pattern | Same pattern with focus guard |
| onResize | Sends `{type:"resize", cols, rows}` to WS | Identical |

### 2. WebSocket Connection
| Aspect | Single | Grid |
|---|---|---|
| URL construction | `ws(s)://host/ws/pty?session=X` | Identical |
| Reset suffix | Not used (no `&reset=1`) | `gs._resetPty ? "&reset=1" : ""` |
| Binary type | `arraybuffer` | `arraybuffer` |
| onopen | fit → send resize JSON | Identical |
| Binary data handling | `desktopTerm.write(data)` | `gs.term.write(data)` |
| Initial prefill write | write + callback → scrollToBottom → finishPrefill | write + callback → finishPrefill (which scrolls) |
| viewer_conflict | `showDesktopConflictOverlay(ws)` | `showGridCellConflictOverlay(gs, ws)` |
| control_granted | Remove overlay, fit, resize, focus | Same, different overlay target |
| onclose (4002) | `setConnState("displaced")`, no reconnect | Immediate reconnect (silent re-conflict) |
| onclose (4001) | `setConnState("session-ended")` | Falls through to reconnect |
| onclose (normal) | `scheduleDesktopReconnect()` | `scheduleGridCellReconnect(gs)` |

### 3. Reconnect Policy
| Aspect | Single | Grid |
|---|---|---|
| Base delay | `RECONNECT_BASE_DELAY_MS` | Same constant |
| Growth factor | 1.8x | 1.8x |
| Max delay | `RECONNECT_MAX_DELAY_MS` | Same |
| Budget | `RECONNECT_BUDGET_MS` | Same |
| Jitter | 0-200ms random | Same |
| Blocked state | `desktopRetryBlocked = true` → `setConnState("offline")` | `gs.retryBlocked = true` → stops silently |

### 4. Initial Hydration (Prefill)
| Aspect | Single | Grid |
|---|---|---|
| Pending flag | `desktopInitialPrefillPending` | `gs.initialPrefillPending` |
| Timeout | `DESKTOP_INITIAL_PREFILL_TIMEOUT_MS` | Same constant |
| On data arrive | write with callback → scrollToBottom → finish | write with callback → finish (which scrolls) |
| Reveal | Container `visibility: visible` | Cell element `visibility: visible` |
| Focus | Always focuses term | Only focuses if `gridFocusIndex === gs` |

### 5. Cleanup
| Aspect | Single | Grid |
|---|---|---|
| Timer cleanup | reconnect, prefill, snapshot timers | reconnect, prefill timers |
| WS close | `desktopWs.close()` | `gs.ws.close()` |
| Term dispose | `desktopTerm.dispose()` | `gs.term.dispose()` |
| Resize handler | Remove window listener | Remove shared window listener |
| DOM cleanup | Container innerHTML = "", display=none | Container innerHTML = "" |
| Search addon | Explicit dispose | Implicit via term.dispose |

## View-Specific Behavior (NOT shared)

### Single Desktop View Only
- Connection status bar (`setConnState()`) — shows reconnecting/displaced/offline/session-ended
- Displaced state UI with "Reconnect" button
- Session-ended state with "use ← to go back" message
- Snapshot save on data write (`scheduleSnapshotSave`)
- Latency metrics recording (`wpMetrics.recordLatency`)
- Keyboard shortcut handler for Cmd+F search
- Search bar integration (open/close/navigate)
- Sidebar refit after transition (`sidebar transition complete → refit xterm`)
- Cached terminal data restore on init

### Grid View Only
- Multi-cell DOM layout (`grid-2` through `grid-6` CSS classes)
- Focus management — `disableStdin`, `cursorBlink` toggling per cell
- Focus-guarded stdin — only `gridSessions[gridFocusIndex] === gs` can send
- Per-cell header labels with session name
- Per-cell close button
- Single→grid transition (adds current session as first cell)
- Grid→single transition (exitGridMode restores remaining session)
- `_resetPty` flag for sessions that had full-width PTY
- Silent auto-reconnect on 4002 (displaced) — immediately reconnects, gets conflict overlay
- Per-cell conflict/displaced overlays (DOM scoped to cell)

## Invariants (Must Hold After Refactoring)

### INV-1: Terminal opens at latest output after initial hydrate
- Server sends scrollback history via `capture-pane -e -S -N` before PTY stream
- Client writes prefill data with callback → `scrollToBottom()` → reveal
- Timeout fallback (`DESKTOP_INITIAL_PREFILL_TIMEOUT_MS`) reveals even if no data arrives
- Container starts hidden (`visibility: hidden`) to prevent flash of empty terminal

### INV-2: Focused grid cell alone accepts stdin
- `term.options.disableStdin` set per cell based on focus index
- `onData`/`onBinary` handlers guard with `gridSessions[gridFocusIndex] === gs`
- `cursorBlink` only enabled on focused cell
- Changing focus updates all cells' stdin/cursor state

### INV-3: Take-control/viewer-conflict works
- Server sends `viewer_conflict` JSON when session already has an active viewer
- Client shows overlay with "Take Control" button
- Client sends `{type: "take_control"}` on click
- Server nulls old viewer, tears down old PTY proc, promotes pending viewer
- Server sends `control_granted` JSON
- Client removes overlay, re-fits, re-sends resize, focuses

### INV-4: Reconnect behavior remains intact
- Exponential backoff: base × 1.8^n, capped at max, with 0-200ms jitter
- Total budget cap — after budget exhausted, stops trying
- Single view: shows connection status bar during reconnect
- Grid view: silent reconnect (no per-cell status bar)
- 4002 (displaced): single view shows "displaced" status; grid immediately reconnects
- 4001 (session unavailable): single view shows "session ended"; grid falls through to reconnect
- Clean close (1000 "pty exited"): single view shows "session ended"

### INV-5: PTY spawn deferred until first resize
- Server's `setupNewPtyEntry()` creates entry with `proc: null`
- First resize message triggers `spawnPty(cols, rows)`
- Client sends resize immediately after WS open (via fit → onResize)
- This ensures PTY dimensions match the actual terminal viewport

### INV-6: Detach safety
- Server only tears down PTY if `entry.viewer === ws && activePtySessions.get(session) === entry`
- Prevents stale close handlers from destroying a replacement PTY entry
- Take-control nulls `entry.viewer` BEFORE closing old WS to prevent detach handler teardown

### INV-7: Rate limiting
- Both server handlers enforce 60 msg/s token bucket
- Client stdin goes through xterm.js which naturally batches
