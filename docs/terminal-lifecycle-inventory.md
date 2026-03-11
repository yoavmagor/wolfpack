# Terminal Lifecycle Inventory

Two desktop PTY terminal stacks (single + grid) share the same server but have divergent client behavior.

## Architecture

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
         │ state.desktopController   │ state.gridSessions[]  │
         └─────────────────────┘     └───────────────────────┘
```

Server is unified — no duplication. Both views share xterm construction, addons, copy/paste, reconnect policy, and prefill logic. Grid uses fontSize-2 and lower scrollback.

## Key Divergences (Single vs Grid)

These are the places where behavior intentionally differs:

| Aspect | Single | Grid |
|---|---|---|
| **WS close 4002 (displaced)** | Shows "displaced" status, no auto-reconnect, user clicks "Reconnect" | Immediately reconnects silently (gets conflict overlay) |
| **WS close 4001 (session ended)** | Shows "session ended" message | Falls through to reconnect timer |
| **Connection status** | Full status bar (reconnecting/displaced/offline/session-ended) | No per-cell status bar, silent reconnect |
| **Stdin guard** | Always active | Only `gridSessions[gridFocusIndex] === gs` can send |
| **Snapshot save** | Writes terminal data to localStorage on data write | Not saved |
| **Search bar** | Cmd+F search integration | Not available per-cell |
| **Sidebar refit** | Refits xterm after sidebar transition | N/A |
| **PTY reset** | Not used | `_resetPty` flag for sessions that had full-width PTY |

## Invariants

### INV-1: Terminal opens at latest output after hydrate
Server sends scrollback via `capture-pane -e -S -N` before PTY stream. Client writes prefill with callback → `scrollToBottom()` → reveal. Container starts `visibility: hidden` to prevent flash. Timeout fallback reveals even if no data arrives.

### INV-2: Focused grid cell alone accepts stdin
`disableStdin` and `cursorBlink` set per cell based on focus index. `onData`/`onBinary` handlers guard with focus check. Changing focus updates all cells.

### INV-3: Take-control/viewer-conflict
Server sends `viewer_conflict` → client shows overlay → user clicks "Take Control" → client sends `{type: "take_control"}` → server nulls old viewer, tears down old PTY proc, promotes pending → sends `control_granted` → client removes overlay, re-fits, focuses.

### INV-4: PTY spawn deferred until first resize
`setupNewPtyEntry()` creates entry with `proc: null`. First resize message triggers `spawnPty(cols, rows)`. Client sends resize immediately after WS open. This ensures PTY dimensions match actual viewport.

### INV-5: Detach safety
Server only tears down PTY if `entry.viewer === ws && activePtySessions.get(session) === entry`. Take-control nulls `entry.viewer` BEFORE closing old WS to prevent detach handler from tearing down the replacement entry.
