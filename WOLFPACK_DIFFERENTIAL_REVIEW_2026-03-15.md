# Wolfpack Differential Security Review

**Branch:** `libghost` (ghostty-web migration)
**Commit Range:** `main..HEAD` (18 commits) + unstaged working tree changes
**Date:** 2026-03-15
**Reviewer:** Claude (automated differential review)

---

## Executive Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 3 |
| LOW | 5 |
| INFO | 5 |

**Overall Risk:** MEDIUM
**Recommendation:** CONDITIONAL — address HIGH finding before merge, accept MEDIUM/LOW as tracked debt
**Confidence:** HIGH for analyzed scope (all production files read in full)

**Key Metrics:**
- Files analyzed: 34/34 changed (100%)
- Production files with zero test coverage: 6 (index.html internals)
- High blast radius changes: 1 (`isAllowedSession` — 8 callers, unchanged)
- Security regressions detected: 0
- Removed security code: 0

---

## What Changed

**Commit Range:** `main..6de24ed` (18 commits)
**Total:** +3,671 / -537 lines across 34 files

| File | +Lines | -Lines | Risk | Blast Radius |
|------|--------|--------|------|--------------|
| `public/index.html` | ~300 | ~300 | HIGH | LOW (self-contained) |
| `src/server/websocket.ts` | 3 | 3 | LOW (comments only) | MEDIUM (all PTY) |
| `src/server/index.ts`* | 2 | 4 | LOW (cosmetic) | MEDIUM (all WS) |
| `scripts/bundle-ghostty.ts` | 68 | 0 | HIGH (supply chain) | LOW (build-time) |
| `scripts/bundle-client-lib.ts` | 55 | 0 | MEDIUM (build) | LOW (build-time) |
| `scripts/gen-assets.ts` | ~50 | ~50 | MEDIUM (build) | LOW (build-time) |
| `src/take-control-logic.ts` | 91 | 0 | LOW (pure functions) | LOW |
| `src/terminal-buffer.ts` | 46 | 0 | LOW (pure functions) | LOW |
| `src/reconnect-hydration.ts` | 24 | 0 | LOW (pure functions) | LOW |
| `src/terminal-input.ts` | 26 | 0 | LOW (pure functions) | LOW |
| `src/wolfpack-client-lib.ts` | 19 | 0 | LOW (barrel) | LOW |
| `public/ghostty-web.bundle.js` | 36 | 0 | MEDIUM (generated) | LOW |
| `public/wolfpack-lib.js` | 41 | 0 | LOW (generated) | LOW |
| `public/xterm-*.min.js, xterm.css` | 0 | 295 | LOW (removed) | — |
| 8 test files | 2,495 | 0 | LOW | — |

\* Unstaged changes

---

## Findings

### [HIGH] F-01: Supply chain — ghostty-web UMD embedded verbatim without content validation

**File:** `scripts/bundle-ghostty.ts:46`
**Blast Radius:** All browser sessions (every wolfpack terminal)
**Test Coverage:** NONE (build-time script)

**Description:**
`readFileSync(UMD_PATH)` reads the entire ghostty-web UMD file from `node_modules/` and injects it via string interpolation into the bundle served to browsers:

```typescript
const bundle = `...
${umdCode}           // ← entire UMD verbatim, no validation
...`;
```

A compromised `ghostty-web` npm package replaces this with arbitrary JS executing in the terminal's browser context — access to all WebSocket connections, terminal I/O, session data, and `localStorage`.

**Mitigations present:**
- `bun.lock` pins `ghostty-web@0.4.0` with SHA-512 integrity hash
- `package.json` pins exact `"ghostty-web": "0.4.0"` (no caret/tilde)
- Single author dependency (ghostty project)

**Residual risk:**
- No `bun audit` or equivalent in CI — known CVEs in ghostty-web would not be flagged
- Lock deletion + `bun install` re-resolves from registry
- No content hash verification in `bundle-ghostty.ts` itself (defense-in-depth)

**Exploitability:** MEDIUM — requires npm registry compromise or dependency confusion
**Recommendation:**
1. Add `bun audit` (or `npm audit`) step to `.github/workflows/test.yml`
2. Consider pinning a content hash of the UMD file in `bundle-ghostty.ts` as defense-in-depth:
   ```typescript
   const hash = crypto.createHash("sha256").update(umdCode).digest("hex");
   if (hash !== EXPECTED_HASH) throw new Error("ghostty-web UMD hash mismatch");
   ```

---

### [MEDIUM] F-02: Export-stripping regex in bundle-client-lib.ts is fragile

**File:** `scripts/bundle-client-lib.ts:36-40`
**Blast Radius:** LOW (build-time only, affects `window.WP`)
**Test Coverage:** NONE

**Description:**
```typescript
const exportMatch = esmCode.match(/export\s*\{([^}]+)\}/);
const coreCode = esmCode.replace(/export\s*\{[^}]*\};?\s*$/, "").trim();
```

This assumes Bun emits a single `export { ... }` block at EOF. If Bun's output format changes (multiple export blocks, `export const`, re-exports, or renamed bindings), the regex silently produces a broken `window.WP` — empty object or missing functions. Production would load without errors but all `WP.*` calls would throw at runtime.

**Current safety:** `minify: false` (line 25) ensures Bun preserves export format. First-party source modules only.

**Exploitability:** N/A (build correctness, not exploitable)
**Recommendation:** Add a post-bundle assertion:
```typescript
const required = ["captureScrollState", "shouldRehydrate", "encodeTerminalBinary", ...];
for (const name of required) {
  if (!exportedNames.includes(name)) throw new Error(`Missing export: ${name}`);
}
```

---

### [MEDIUM] F-03: take-control-logic.ts extracted but not used by production code

**File:** `src/take-control-logic.ts` (module) vs `public/index.html:3983-4008` (inline logic)
**Blast Radius:** LOW
**Test Coverage:** Module has 27 tests; inline production code has 0 tests

**Description:**
The take-control state machine was extracted into pure functions (`handleViewerConflict`, `handleDisplaced`, `prepareAutoTakeControl`, `classifyDisconnect`), but `index.html` grid conflict handlers still use inline `gs._autoTakeControl` / `gs._displaced` mutations:

```javascript
// index.html:3986-3991 — inline, not using extracted module
if (gs._autoTakeControl) {
  gs._autoTakeControl = false;
  gs.controller.sendTakeControl();
} else {
  showGridCellConflictOverlay(gs);
}
```

Tests verify the module, production runs the copy. This is exactly the "tests mirror production code instead of importing it" anti-pattern. A behavioral drift between the module and inline code would produce passing tests with broken production.

**Exploitability:** N/A (correctness issue, not directly exploitable)
**Recommendation:** Wire `index.html` to call `WP.*` versions of these functions, or delete the module and inline the tests against the production code.

---

### [MEDIUM] F-04: Release binaries are unsigned

**File:** `scripts/build.ts`, `.github/workflows/release.yml`
**Blast Radius:** All users installing from GitHub Releases
**Test Coverage:** N/A

**Description:**
Release workflow generates `checksums-sha256.txt` but performs no code signing. macOS binaries require ad-hoc signing (`codesign -f -s -`) locally. An attacker who compromises the GitHub Release (via token theft or Actions compromise) can replace binaries and regenerate matching checksums.

**Mitigations present:** SHA-256 checksums (integrity, not authenticity)
**Recommendation:** Consider GitHub attestations (`gh attestation`) or macOS Developer ID signing for release builds.

---

### [LOW] F-05: Unhandled promise rejection on WASM init failure in grid

**File:** `public/index.html:4068`
**Blast Radius:** Grid view only
**Test Coverage:** NO

```javascript
Promise.all(mountPromises).then(() => { ... });
// Missing .catch()
```

If `window.ghosttyReady` rejects (WASM init failure), the rejection is unhandled. Grid cells render but never connect. In practice, WASM init failure makes the entire terminal feature unusable regardless.

**Recommendation:** Add `.catch(err => console.error("[grid] mount failed:", err))`.

---

### [LOW] F-06: No dependency vulnerability scanning in CI

**File:** `.github/workflows/test.yml`, `.github/workflows/release.yml`
**Description:** Neither CI workflow runs `bun audit`, `npm audit`, or any SCA tool. A known-vulnerable version of any dependency would not block PRs or releases.
**Recommendation:** Add `npm audit --audit-level=high` or equivalent to test workflow.

---

### [LOW] F-07: gen-assets.ts follows symlinks via readFileSync

**File:** `scripts/gen-assets.ts:59`
**Description:** `readFileSync(filePath)` follows symlinks. A symlink `public/evil.js -> /etc/passwd` would embed that file's contents in the compiled binary. Requires local filesystem write access to `public/`.
**Currently exploitable:** No (0 symlinks in `public/`, developer-controlled directory).

---

### [LOW] F-08: Unstaged poll interval change (50ms → 30ms)

**File:** `src/server/websocket.ts:123,163` (unstaged)
**Description:** `handleTerminalWs` poll timer reduced from 50ms to 30ms. This is the mobile capture-pane polling path. Higher frequency = ~40% more CPU per mobile connection under sustained output. Change is undocumented and unrelated to the ghostty-web migration.
**Recommendation:** If intentional, commit separately with rationale. If accidental, revert.

---

### [LOW] F-09: Unstaged cosmetic changes to src/server/index.ts

**File:** `src/server/index.ts` (unstaged)
**Description:** Blank line addition and `(ws) => { handleTerminalWs(ws, session); }` collapsed to `(ws) => handleTerminalWs(ws, session)`. Functionally identical but scope creep on a migration branch.
**Recommendation:** Commit separately or drop.

---

### [INFO] F-10: Search feature regression — intentional

Desktop Cmd+F search returns "n/a" — ghostty-web has no search API. Mobile capture-pane search is unaffected. Documented in PLAN.md.

### [INFO] F-11: WASM init gate race condition — properly handled

`mount()` awaits `window.ghosttyReady`, then checks `if (_term)` and `if (!state.desktopController)` to handle disposal during the async gap. Correct.

### [INFO] F-12: CSS selector migration — properly scoped

All 7 `.xterm` → `canvas` selector changes are under `#desktop-terminal-container` or `.grid-cell`. No `<canvas>` elements exist outside these containers.

### [INFO] F-13: Reconnect hydration — secure, slightly wider surface

Reconnects now receive fresh server prefill (previously skipped). The trust boundary is unchanged: server sends PTY data via `tmux capture-pane -t [session]`, client writes to terminal. Session isolation maintained at WS upgrade via `isAllowedSession()`. Deferred reset (`_reconnectPendingReset`) avoids blank flash — old content visible until new data arrives.

### [INFO] F-14: Binary vs JSON WebSocket dispatch — sound

`createPtySocketClient` uses `typeof ev.data === "string"` (WebSocket frame type) to distinguish control messages from PTY data. NOT a byte-heuristic. `sock.binaryType = "arraybuffer"` ensures binary frames arrive as `ArrayBuffer`. Correct approach.

---

## Test Coverage Analysis

| Production file | Test coverage | Gap risk |
|----------------|---------------|----------|
| `src/take-control-logic.ts` | 27 tests | LOW — but production doesn't use it (F-03) |
| `src/terminal-buffer.ts` | 19 tests | LOW |
| `src/reconnect-hydration.ts` | 15+ tests | LOW |
| `src/terminal-input.ts` | 6 tests | LOW |
| `public/index.html` (createPtyTerminalController) | 0 tests | HIGH — 230-line orchestrator |
| `public/index.html` (createPtySocketClient) | 0 tests | HIGH — WS lifecycle |
| `public/index.html` (createTerminalInstance) | 0 tests | MEDIUM — terminal construction |
| `public/index.html` (createInitialHydrationController) | 0 tests | MEDIUM — hydration timing |
| `scripts/bundle-ghostty.ts` | 0 tests | MEDIUM — verified by build |
| `scripts/bundle-client-lib.ts` | 0 tests | MEDIUM — verified by build |
| `src/server/websocket.ts` | 0 direct tests | LOW — comments only changed |

**161 new tests** added across 8 test files. All 889 tests pass. The tested modules are well-covered. The gap is the `index.html` monolith functions that orchestrate those modules.

---

## Blast Radius Analysis

| Function | Prod callers | Risk | Priority |
|----------|-------------|------|----------|
| `isAllowedSession` | 8 (HTTP + WS) | HIGH (auth gate) | P0 — **UNCHANGED in this diff** |
| `handlePtyWs` | 1 | MEDIUM (all desktop PTY) | P2 — comments only |
| `handleTerminalWs` | 1 | MEDIUM (all mobile WS) | P2 — comments only |
| `createPtyTerminalController` | 2 | MEDIUM (both terminal views) | P1 — behavioral changes |
| `createPtySocketClient` | 1 | LOW (internal) | P2 |
| Extracted `WP.*` functions | 1 each | LOW | P3 — well-tested |

No HIGH blast radius functions were modified behaviorally. `isAllowedSession` (8 callers, auth-critical) is untouched in this diff.

---

## Historical Context

**Security-related removals:** NONE. `git diff main..HEAD | grep "^-" | grep -iE "require|check|valid|auth|secur|guard|assert"` on `index.html` returned empty. No validation code was removed.

**Regression risks:** NONE detected. The removed xterm.js addons (SearchAddon, WebglAddon, Unicode11Addon) were all rendering/UX features, not security controls. Git history confirms they were added for functionality, not for security fixes.

**`_skipPrefillNextAttach` removal:** Added in `d7c7710` for reconnect optimization. Replaced by explicit `WP.shouldRehydrate()` call — different mechanism, same intent. Not a regression.

**`allowProposedApi` removal:** xterm.js-specific flag for unstable API access. ghostty-web doesn't use it. Removal reduces API surface.

---

## Recommendations

### Immediate (before merge)
- [ ] **F-01:** Add `npm audit --audit-level=high` to CI test workflow (mitigates supply chain blind spot)
- [ ] **F-03:** Either wire `index.html` to use `WP.*` take-control functions OR delete the extracted module. Current state: tests verify dead code.
- [ ] **F-05:** Add `.catch()` to `Promise.all(mountPromises)` in grid render
- [ ] Commit or revert unstaged changes (F-08, F-09) — don't merge unrelated changes on the migration branch

### Before production
- [ ] **F-01:** Consider UMD content hash verification in `bundle-ghostty.ts`
- [ ] **F-02:** Add post-bundle assertion for expected `WP.*` exports
- [ ] **F-04:** Evaluate GitHub attestations for release binaries

### Technical debt
- [ ] Extract `createPtyTerminalController`, `createPtySocketClient`, `createInitialHydrationController` from `index.html` monolith into testable modules (same pattern as the 5 modules already extracted)
- [ ] Add integration tests for `handlePtyWs` and `handleTerminalWs`

---

## Verified Safe

- **websocket.ts committed changes:** Comments only (3 lines). No behavioral delta.
- **take-control-logic.ts:** Pure functions, no I/O, no network, no file access.
- **terminal-buffer.ts:** Pure functions, no I/O, no network, no file access.
- **terminal-input.ts:** Pure functions, no I/O, no network, no file access.
- **reconnect-hydration.ts:** Pure function, no I/O.
- **Session isolation:** Prefill from `tmux capture-pane -t [session]` cannot leak cross-session data. Validated at WS upgrade.
- **`TERM: "xterm-256color"` env var:** Terminfo identifier, not an xterm.js reference. Correct to keep.
- **XSS:** All user-data → DOM paths use `esc()`. No new `innerHTML` with unescaped data. No `eval` or `Function()` added.
- **Binary WS dispatch:** Frame-type based (`typeof ev.data === "string"`), not byte-heuristic. Sound.
- **Copy handler:** Clipboard API usage unchanged. Data from `term.getSelection()` (internal buffer).
- **Wheel handler:** Hardcoded SGR escape sequences with fixed col/row. `Math.min(Math.abs(lines), 5)` caps iterations. Guarded by `canAcceptInput()`.

---

## Analysis Methodology

**Strategy:** FOCUSED (34 changed files, ~3,700 lines)

**Analysis Scope:**
- Production files: 100% read in full
- Test files: sampled (verified test assertions match module contracts)
- Build scripts: 100% read in full
- Generated bundles: structure verified, content spot-checked

**Techniques:**
- Full `git diff main..HEAD` analysis
- Git blame on all removed code patterns
- Git history search (`git log -S`) for security-related patterns
- Blast radius calculation for all modified functions
- 4 parallel deep-dive subagents (git history, index.html security, blast radius, supply chain)
- Adversarial modeling for HIGH risk changes (supply chain, state machine)

**Limitations:**
- Could not execute ghostty-web UMD to verify WASM load-order (fetch fallback vs base64). Analysis based on code reading.
- No runtime testing (browser, mobile) — analysis is static only.
- Did not audit ghostty-web internals (treated as opaque dependency).

**Confidence:** HIGH for the differential (what changed). MEDIUM for pre-existing issues surfaced by context.
