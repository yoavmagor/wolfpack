# Desktop Terminal: `<pre>` + ansi_up + keyboard capture

## Context
xterm.js approach failed — capture-pane snapshots cause unbearable flickering because xterm.js renders incrementally (no atomic screen swap). Switching to `<pre>` with ANSI-to-HTML conversion + direct keyboard capture. Mobile UI stays unchanged.

## Architecture

### Current (broken) flow
```
WebSocket → capture-pane -e → xterm.js term.write() → flickers
```

### New flow
```
WebSocket → capture-pane -e → ansi_up.ansi_to_html() → pre.innerHTML (atomic) → no flicker
keyboard events → WebSocket → tmux send-keys (instant, no Enter needed)
```

## Phase 1: Replace xterm.js with `<pre>` + ansi_up

### ~~1. Load ansi_up from CDN~~
Replace xterm.js CDN scripts with ansi_up (~5KB):
```html
<script src="https://cdn.jsdelivr.net/npm/ansi_up@6/ansi_up.min.js"></script>
```
Remove xterm.js CSS and all 3 xterm script tags (xterm, addon-fit, addon-search).

### ~~2. Replace `#xterm-container` with styled `<pre>`~~
Replace the `<div id="xterm-container">` with a `<pre id="desktop-terminal">` element. Style it:
- Same dark background (#0a0a0a), monospace font, full height
- `overflow-y: auto` for scrollback
- `white-space: pre` to preserve spacing
- `user-select: text` so users can copy text
- Hide on mobile, show on desktop

### ~~3. Replace `initXterm()` with `initDesktopTerminal()`~~
New function that:
- Shows `#desktop-terminal`, hides mobile elements (action-bar, input-bar, msg-preview, #terminal)
- Creates `AnsiUp` instance with `use_classes: false` (inline styles)
- Opens WebSocket to `/ws/terminal?session=X`
- On open: calculate cols/rows from container size and font metrics (same approach as `resizePane()`), send resize message
- On message: convert ANSI to HTML via `ansi_up.ansi_to_html(msg.data)`, set `pre.innerHTML` (atomic, no flicker)
- On close: show connection status
- Attach keyboard listener (see Phase 2)
- Attach window resize listener: recalculate cols/rows, send resize via WebSocket

### ~~4. Replace `destroyXterm()` with `destroyDesktopTerminal()`~~
- Close WebSocket
- Remove keyboard listener
- Remove resize listener
- Hide `#desktop-terminal`, restore mobile elements
- Clear innerHTML

### ~~5. Update all callsites~~
Replace all references to `initXterm()` → `initDesktopTerminal()`, `destroyXterm()` → `destroyDesktopTerminal()`. Update variable names: remove `xtermInstance`, `xtermFitAddon`, `xtermSearchAddon`, `xtermWs` — replace with `desktopWs`, `desktopAnsi`, etc.

## Phase 2: Keyboard capture

### ~~6. Direct keyboard input handler~~
On desktop terminal init, add a `keydown` event listener to `document`:
- Capture all keystrokes when desktop terminal is active and focused
- Map keypresses to tmux-compatible sequences:
  - Printable chars → send as `{ type: "input", data: char }`
  - Enter → `{ type: "key", key: "Enter" }`
  - Escape → `{ type: "key", key: "Escape" }`
  - Backspace → `{ type: "key", key: "BSpace" }`
  - Tab → `{ type: "key", key: "Tab" }`
  - Arrow keys → `{ type: "key", key: "Up"/"Down"/"Left"/"Right" }`
  - Ctrl+C → `{ type: "key", key: "C-c" }`
  - Ctrl+D → `{ type: "key", key: "C-d" }`
  - Ctrl+Z → `{ type: "key", key: "C-z" }`
  - Ctrl+L → `{ type: "key", key: "C-l" }`
  - Ctrl+A → `{ type: "key", key: "C-a" }`
  - Ctrl+E → `{ type: "key", key: "C-e" }`
- `preventDefault()` on captured keys to stop browser defaults
- Don't capture when search bar or other inputs are focused

## Phase 3: Search on desktop

### ~~7. Desktop search using browser find-in-page~~
Since we're using a `<pre>` with HTML content, the existing search implementation (DOM-based text search with highlights) should work as-is. Verify it works and fix any issues with ANSI HTML spans interfering with search highlighting.

## Phase 4: Cleanup

### 8. Remove xterm.js dead code
- Remove xterm.js CDN script/link tags
- Remove `#xterm-container` div and its CSS
- Remove all xterm-related variables and functions
- Remove `#xterm-container .xterm-cursor-layer` CSS hack
- Remove `FitAddon`, `SearchAddon` references
- Clean up any xterm-specific search code paths

## Server changes

The WebSocket endpoint in serve.ts (`handleTerminalWs`) stays as-is — it already sends JSON `{ type: "output", data: pane }` with ANSI escapes and `\r\n` line endings. The `capturePaneAnsi()` function stays. No server changes needed.

## Files to modify
- `public/index.html` — replace xterm.js with ansi_up + keyboard capture

## Files NOT to modify
- `serve.ts` — WebSocket handler already works correctly
- Mobile UI — zero changes

## Verification
1. Open on desktop browser → `<pre>` terminal renders with colors, NO flickering
2. Type characters → appear instantly in terminal (no Enter needed)
3. `/` key → triggers claude menu immediately
4. Ctrl+C, arrow keys, tab, escape all work
5. Open on phone → current mobile UI shows, unchanged
6. Search works on desktop terminal
7. Window resize adjusts terminal dimensions
8. Session switching works on both desktop and mobile
