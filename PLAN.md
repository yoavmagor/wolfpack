# Inline Ralph Cards in Session List

## Context
The dedicated Ralph page (`#ralph-view`) is unnecessary navigation overhead. Ralph loops belong with their machine's sessions — they're per-project background workers, not a separate concept. Moving ralph cards inline under each machine group eliminates a full view transition and makes the session list a true command center. Each machine gets a 🥋 button to launch ralph loops, scoped to that machine (no machine picker needed).

## Files to modify
- `public/index.html` — all changes (single-file PWA)

---

## 1. Extend `fetchMachine()` to include ralph loops

Add `/api/ralph` as a third parallel fetch in the `Promise.all`. Group object gains a `loops` property. Ralph fetch has its own `.catch` so session loading degrades gracefully.

## 2. Extract `renderRalphCardHtml(loop, machineUrl)` helper

Move the card-rendering logic out of `loadRalphLoops()` into a pure function. Same card markup, minus the machineLabel div (card is already under its machine header). Delete `loadRalphLoops()` entirely.

## 3. Add `.machine-ralph-btn` CSS

Purple-tinted border matching existing `.ralph-nav-btn` aesthetic, same dimensions as `.machine-add-btn`. Add hover states and mobile touch-target overrides.

## 4. Modify `renderGroupHtml()` — ralph button + inline cards

**Machine header**: Wrap `+` and new `🥋` buttons in a flex container with `margin-left:auto`. Move `margin-left:auto` from `.machine-add-btn` to the wrapper.

```
machine-header: [dot] machineName [version?] [🥋][+]
```

**After session cards**: Append ralph cards from `g.loops`.

## 5. Modify `renderSingleMachineHtml()` — ralph button + inline cards

Wrap `+ New Session` and 🥋 button in a flex row. Append ralph cards after sessions.

## 6. Modify `renderSidebar()` — ralph button + inline cards

Same pattern as steps 4-5 for both multi-machine and single-machine modes. New `sidebarRalphCardHtml()` — compact version (no progress bar, no lastOutput, just name + status badge).

## 7. Add `showRalphStart(machineUrl)` + simplify `loadRalphStartForm()`

New global `ralphStartMachine` (mirrors existing `projectMachine`/`viewBeforePicker` pattern). `showRalphStart(url)` sets it → `showView("ralph-start")`. Remove machine picker logic from `loadRalphStartForm()`. Update `getStartMachine()` to return `ralphStartMachine`.

## 8. Fix `restartRalph()` machine context

Set `ralphStartMachine = currentRalphMachine` before navigating to ralph-start.

## 9. Fix post-action navigation

- `startRalph()` success: `showView("sessions")` instead of `showView("ralph")`
- `dismissRalph()` success: `loadSessions()` instead of `loadRalphLoops()`

## 10. Update `showView()` navigation

- `VIEW_DEPTH`: remove `ralph`, change `ralph-detail` and `ralph-start` to depth 1
- Desktop branch: remove `effectiveName === "ralph"` case
- Mobile `applyHeader`: remove `ralph` case entirely; change `ralph-detail` and `ralph-start` back buttons → `sessions`
- Remove `ralphBtn` references throughout
- Add Escape key support for `ralph-start` view (back to sessions, same pattern as picker nav)

## 11. Update swipe engine

- `BACK_TARGET`: remove `ralph`, change `ralph-detail` → `sessions`, `ralph-start` → `sessions`
- Forward swipe: detect `.ralph-card` in sessions view → navigate to `ralph-detail`

## 12. Remove dead HTML/JS/CSS

- Delete `#ralph-view` HTML block
- Delete `<button id="ralph-btn">` from header
- Delete `<button id="sidebar-ralph-btn">` from sidebar footer
- Delete `loadRalphLoops()` function
- Delete `ralphRefreshTimer` variable + all refs
- Delete sidebar-ralph-btn onclick wiring
- Clean up `.ralph-nav-btn` CSS, `.ralph-empty` CSS

---

## Verification

1. Desktop (>768px):
   - Sidebar shows ralph cards under each machine group, visually distinct
   - 🥋 button in each machine header opens ralph-start scoped to that machine
   - Clicking ralph card → ralph-detail in main area
   - Ralph card dismiss (X) refreshes session list
   - 5s session refresh updates ralph cards too
   - Escape from ralph-start returns to sessions
   - Picker cancel buttons work (desktop-only inline `.picker-cancel-btn`)
2. Mobile (≤768px):
   - Session list shows ralph cards inline under each machine
   - 🥋 button next to each machine's + button
   - Tap ralph card → ralph-detail view
   - Back from ralph-detail → sessions
   - Swipe forward on ralph card → ralph-detail
   - Swipe back from ralph-detail → sessions
   - Picker back buttons use `viewBeforePicker` to return correctly
3. `bun test` passes
4. Build + deploy + verify live
