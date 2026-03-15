# Differential Security Review: `libghost` branch

**Date:** 2026-03-15
**Branch:** `libghost` (16 commits ahead of `main`)
**Scope:** xterm.js → ghostty-web terminal migration
**Strategy:** FOCUSED (27 files, ~3.3k additions / ~465 deletions)
**Reviewer confidence:** HIGH for server-side, MEDIUM for frontend (inline HTML JS, no type checking)

---

## Executive Summary

This branch replaces xterm.js (6 packages) with ghostty-web (1 package + WASM) as the terminal renderer. The migration is clean — server-side changes are comment-only, the attack surface didn't expand, and new logic is well-tested. Two medium findings and several low observations below.

---

## Risk Classification

| File | Risk | Rationale |
|------|------|-----------|
| `src/server/websocket.ts` | LOW | Comment-only changes (s/xterm/ghostty/) |
| `src/server/index.ts` | LOW | Not changed in meaningful diff |
| `scripts/bundle-ghostty.ts` | MEDIUM | New build script, reads node_modules, writes to public/ |
| `scripts/gen-assets.ts` | MEDIUM | Calls `execSync` for sub-script |
| `public/index.html` | HIGH | Core frontend — terminal lifecycle, WebSocket, reconnect logic |
| `public/ghostty-web.bundle.js` | MEDIUM | Generated artifact, 624KB WASM-embedding bundle |
| `src/take-control-logic.ts` | LOW | New pure functions, well-tested |
| `src/terminal-buffer.ts` | LOW | New pure functions, well-tested |
| `src/public-assets.ts` | LOW | Generated, embeds public/ files |
| `package.json` | LOW | Dependency swap |

---

## Phase 1: Code Analysis

### HIGH RISK: `public/index.html` — Reconnect Hydration Change

**What changed:** The old `_skipPrefillNextAttach` mechanism (which auto-skipped prefill on reconnect) was removed. New logic in `onOpen` callback explicitly clears the terminal (`_term.reset()`) and restarts hydration on reconnect.

**Old behavior:** Reconnect → skip prefill → stale content persists
**New behavior:** Reconnect → `term.reset()` → restart hydration → server sends fresh prefill

This is a **behavioral improvement** — the old approach left stale content visible. The new approach properly rehydrates.

**Concern: Race condition in `mount()` (line ~3588)**
```js
async function mount(container, mountOpts) {
  if (_term) return; // already mounted
  await window.ghosttyReady;
  // ...
```
The `await ghosttyReady` introduces an async gap between the `_term` guard and actual terminal creation. If `mount()` is called twice before WASM init resolves, both calls pass the `if (_term) return` guard. The second call would overwrite the first terminal.

**Mitigated by:** `initDesktopTerminal` has `if (state.desktopController) return;` guard, and grid cells have `if (gs.controller) return;`. So callers prevent double-mount at a higher level. But the function itself is not reentrant-safe.

**Severity:** LOW (caller guards sufficient, but worth noting)

### HIGH RISK: `public/index.html` — Grid Mount Now Async

**What changed:** `mountGridController` became `async`, and `renderGrid` now uses `Promise.all(mountPromises).then(...)` to await WASM init before connecting.

```js
Promise.all(mountPromises).then(() => {
  runGridRelayoutTransition(() => {
    fitAllGridCells();
    newCellSessions.forEach(gs => { ... });
  });
});
```

**Concern:** If `renderGrid` is called again before the previous `Promise.all` resolves (rapid session list updates), multiple transition callbacks could interleave. The existing `gs.controller` guard prevents double-mount, but the layout transition could fire multiple times.

**Severity:** LOW (visual glitch at worst, no security impact)

### MEDIUM: `initDesktopTerminal` — Disposed-During-Await Guard

Good defensive coding at line ~5532:
```js
await state.desktopController.mount(container, { cached });
if (!state.desktopController) return; // disposed while awaiting WASM init
```
This correctly handles the case where the user navigates away during WASM initialization.

---

## Phase 2: Removed Functionality

### Search Disabled for Desktop Terminal

The SearchAddon, Unicode11Addon, WebglAddon, and WebLinksAddon are all removed. Search now shows "n/a" for desktop mode. This is a **feature regression**, not a security issue — correctly documented in the code:

```js
// ghostty-web doesn't have a search API yet — search is disabled for desktop terminal
document.getElementById("search-count").textContent = "n/a";
```

The mobile terminal (capture-pane) search still works via DOM text search.

### `allowProposedApi: true` Removed

Previously passed to xterm.js. Ghostty-web doesn't use this flag. **Good — reduces API surface.**

---

## Phase 3: Build Pipeline

### `scripts/bundle-ghostty.ts`

Reads `node_modules/ghostty-web/dist/ghostty-web.umd.cjs` → wraps in IIFE → writes to `public/ghostty-web.bundle.js`. Clean approach:

- No `eval()` or dynamic code injection
- UMD code is string-concatenated into an IIFE, not evaluated at build time
- Output is a static file embedded into the binary at compile time

**Note:** The generated bundle (`public/ghostty-web.bundle.js`) is 624KB and checked into git. This is a committed artifact from `node_modules`. If the ghostty-web dependency is compromised, the bundle would carry the payload into the binary. This is the same risk model as the old xterm .min.js files that were also committed.

### `scripts/gen-assets.ts` — `execSync` Usage

```ts
execSync("bun run scripts/bundle-ghostty.ts", { cwd: ..., stdio: "inherit" });
```

The command is a hardcoded string literal — no user input flows into it. **No injection risk.** This is a build-time script, not server-side.

---

## Phase 4: Test Coverage

| Area | Tests | Coverage Assessment |
|------|-------|-------------------|
| Terminal buffer ops | `terminal-buffer.test.ts` (185 lines) | Thorough — scroll capture, resize target, serialize |
| Take-control state machine | `take-control-logic.test.ts` (254 lines) | Complete — all state transitions |
| Reconnect hydration | `reconnect-hydration.test.ts` (310 lines) | Excellent — full lifecycle simulation |
| Desktop terminal | `desktop-terminal.test.ts` (399 lines) | Integration coverage |
| Desktop grid | `desktop-grid.test.ts` (654 lines) | Thorough — 2-6 cells, focus, stdin guard |
| Take-control integration | `take-control.test.ts` (675 lines) | Thorough — conflict, recovery, viewer displacement |
| Desktop terminal logic | `desktop-terminal-logic.test.ts` (182 lines) | Unit coverage |
| Grid logic | `grid-logic.test.ts` (534 lines) | Unit coverage |

**Total new test code: 3,193 lines across 8 files.**

The reconnect hydration tests are particularly well-structured — they extract the exact decision functions from `index.html` and test all state combinations including edge cases (disposed-during-await, missing hydration controller, etc.).

**Gap:** No tests for the WASM init gate (`await ghosttyReady`) failure path. If WASM init fails, `ghosttyReady` rejects, and `mount()` would throw an unhandled rejection. The catch in `bundle-ghostty.ts` logs and re-throws, but no consumer catches it.

---

## Phase 5: Adversarial Analysis

### Attack Surface Changes

| Vector | Before | After | Delta |
|--------|--------|-------|-------|
| Dependencies | 7 npm packages (xterm + 5 addons) | 1 npm package (ghostty-web) | **Reduced** |
| Served JS files | 7 (xterm + addons) | 1 (bundle) | **Reduced** |
| CSS files | 1 (xterm.css) | 0 | **Reduced** |
| WASM | None | Inlined base64 in bundle | **New vector** |
| Server-side changes | N/A | Comment-only | **Neutral** |

The WASM introduction is the only new attack surface, and it's a rendering engine (not network-facing). The dependency count reduction is a meaningful security improvement.

### WebSocket Protocol

**No protocol changes.** The attach/detach, viewer_conflict, control_granted, and binary frame handling are identical. The only WS change is removing `_skipPrefillNextAttach` (which simplified the protocol state machine).

### CSS Selector Changes

`.xterm` → `canvas` for styling. The `canvas` selector is broader — it would match any canvas element in the page, not just terminal containers. Currently this is fine because the terminal containers only have ghostty-web's canvas, but if other canvas elements were added later, they'd inherit terminal styling (opacity, visibility transitions).

**Severity:** LOW (cosmetic, no security impact)

---

## Findings Summary

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | MEDIUM | `mount()` not reentrant-safe during async WASM init | **FIXED** — `_mounting` flag + double-check after await |
| 2 | MEDIUM | Unhandled WASM init rejection | **FIXED** — try/catch around `await ghosttyReady` with console.error + early return |
| 3 | LOW | `canvas` CSS selectors | **NO FIX NEEDED** — already scoped to `#desktop-terminal-container canvas` / `.grid-cell canvas` |
| 4 | LOW | Grid `Promise.all` transition interleaving on rapid re-renders | **FIXED** — `_gridRenderGeneration` counter, stale callbacks bail out |
| 5 | INFO | Desktop search disabled (feature regression, not security) | N/A |
| 6 | INFO | Generated 624KB bundle committed to git (standard for this project) | N/A |

---

## Blast Radius

The changes are contained to the **client-side terminal rendering layer**. Server-side is comment-only. The WebSocket protocol is unchanged. Mobile terminal (capture-pane) is explicitly verified unaffected (commit `723da45`).

**Callers of changed functions:**
- `createTerminalInstance` (renamed from `createXtermInstance`): called by `createPtyTerminalController.mount()` only
- `mount()` (now async): called by `initDesktopTerminal` and `mountGridController`
- `renderGrid` (now uses Promise.all): called from session list updates

All callers have been updated for the async change. No orphaned sync callers remain.

---

## Verdict

**APPROVE with notes.** The migration is well-executed:
- Attack surface reduced (7 deps → 1)
- Server unchanged (comment-only)
- WebSocket protocol unchanged
- Extensive test coverage (3.2k lines, all new)
- Reconnect hydration is actually improved (old behavior left stale content)

The two MEDIUM findings (#1 mount reentrancy, #2 WASM rejection) are real but low-exploitability — both would require specific timing conditions and produce terminal rendering failures, not security breaches.

---

## Coverage Limitations

- Frontend JS is inline in `index.html` (~4k lines) — no static type checking on the changed code
- Integration tests mock the terminal API surface, not actual ghostty-web WASM rendering
- Did not audit `ghostty-web` package internals (third-party dependency)
