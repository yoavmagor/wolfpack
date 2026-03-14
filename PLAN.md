# ghostty-web migration plan

**goal**: replace xterm.js with ghostty-web for better terminal emulation (same ghostty parser as native app, compiled to WASM)

## status key
- [x] not started
- [x] done
- [~] in progress

## phase 1: package setup
- [x] add `ghostty-web` to package.json
- [x] remove `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-search`, `@xterm/addon-unicode11`, `@xterm/addon-webgl`, `@xterm/addon-web-links`
- [x] `bun install`

## phase 2: asset pipeline (gen-assets.ts)
- [x] create bundler script that bundles ghostty-web into a single global-exposing JS file
  - ghostty-web is ES module + needs `await init()` for WASM
  - current code uses `<script>` tags with global `Terminal`, `FitAddon` etc.
  - approach: build a `ghostty-web.bundle.js` that:
    1. imports ghostty-web
    2. calls init()
    3. exposes `window.GhosttyTerminal`, `window.GhosttyFitAddon`
    4. OR: simpler — expose same globals as xterm (`Terminal`, `FitAddon.FitAddon`)
  - also need to serve the WASM file as a static asset
- [x] update gen-assets.ts to copy/bundle ghostty-web assets instead of xterm
- [x] remove old xterm static files from public/

## phase 3: frontend migration (index.html)
- [x] replace xterm script/css tags with ghostty-web bundle
- [x] add WASM init gate — terminal creation must wait for `await init()`
  - wrap `createXtermInstance()` or gate it behind init completion flag
- [x] remove unicode11 addon loading (ghostty does unicode 15.1 natively)
- [x] remove webgl addon loading (ghostty handles its own rendering)
- [x] remove web-links addon reference (wasn't loaded anyway)
- [x] update FitAddon usage: `new FitAddon()` from ghostty-web
  - ghostty-web FitAddon has `observeResize()` — could replace manual resize listeners
- [x] handle search addon gap:
  - option A: disable search UI temporarily (Cmd+F search bar)
  - option B: implement basic search using buffer API
  - option C: write a thin search addon using ghostty-web buffer access
  - **decision**: start with option A, revisit after testing
- [x] update xterm CSS references (ghostty-web may not need xterm.css)
- [x] update custom CSS selectors (`.xterm-find-result-decoration` etc.)
- [x] test `term.buffer.active` access (used for scroll position tracking)

## phase 4: verify
- [x] desktop single terminal: open, type, scroll, copy/paste
- [x] desktop grid: 2-6 cells, focus switching, stdin guard
- [x] reconnect: close/reopen websocket, hydration prefill
- [x] take-control flow: viewer conflict + recovery
- [x] mobile: unaffected (uses capture-pane, no xterm)
- [ ] build: `bun run scripts/build.ts` succeeds
- [ ] tests: `bun test` passes

## api compatibility notes

| xterm.js | ghostty-web | status |
|---|---|---|
| `new Terminal(opts)` | `new Terminal(opts)` | same |
| `term.open(el)` | `term.open(el)` | same |
| `term.write(data, cb)` | `term.write(data, cb)` | same |
| `term.onData(cb)` | `term.onData(cb)` | same |
| `term.onBinary(cb)` | `term.onBinary(cb)` | same |
| `term.onResize(cb)` | `term.onResize(cb)` | same |
| `term.cols/rows` | `term.cols/rows` | same |
| `term.buffer.active` | `term.buffer` | check API |
| `term.getSelection()` | `term.getSelection()` | same |
| `term.scrollToBottom()` | `term.scrollToBottom()` | same |
| `term.scrollToLine(n)` | `term.scrollToLine(n)` | same |
| `term.attachCustomKeyEventHandler` | `term.attachCustomKeyEventHandler` | same |
| `term.dispose()` | `term.dispose()` | same |
| `term.focus()` | `term.focus()` | same |
| `term.clear()` | `term.clear()` | same |
| `FitAddon.fit()` | `FitAddon.fit()` | same |
| `SearchAddon.findNext()` | — | NO EQUIVALENT |
| `Unicode11Addon` | built-in (15.1) | not needed |
| `WebglAddon` | built-in renderer | not needed |
| `allowProposedApi` | — | remove |
| — | `await init()` | NEW requirement |

## risks
- ghostty-web perf is "not optimized yet" per devs — could be worse than xterm.js initially
- search feature temporarily lost
- WASM loading adds startup latency (cold load of ~400KB)
- ghostty-web is pre-1.0, API could break
