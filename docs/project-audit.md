# Project Audit

Date: 2026-03-07

Scope: static audit of the current repository state, organized by module. This review focused on correctness risks, security boundaries, reliability, missing tests, and simplification opportunities. I did not run the full test suite for this audit.

## Module Map

- `src/server/` plus `src/auth.ts`, `src/validation.ts`, `src/triage.ts`: HTTP, WebSocket, auth, session access, peer discovery, tmux integration.
- `public/index.html` plus `src/grid-logic.ts`: frontend/PWA, session UI, terminal UX, grid mode, reconnect behavior, settings, discovery.
- `src/server/ralph.ts`, `src/ralph-macchio.ts`, `src/wolfpack-context.ts`: Ralph loop orchestration, worker execution, plan parsing, cleanup pass.
- `src/cli/`: config, setup, service lifecycle, entrypoint.
- `tests/`: unit, integration, snapshot, and e2e coverage.

## Severity Summary

- High: session authorization boundary bugs, PTY input breakage, frontend action/error contract mismatch, Ralph worker safety gaps, and destructive CLI lifecycle behavior.
- Medium: inconsistent path safety, brittle route validation, reconnect edge cases, plan bookkeeping drift, and config/load split-brain risks.
- Low: timer cleanup, cache pruning, and duplicated/disconnected helper logic.

## Global Themes

- The system has a few hard correctness bugs at module boundaries rather than in isolated leaf functions.
- The frontend is carrying too much behavior inside one `public/index.html` file, which has already led to duplicated state logic and drift.
- Several tests mirror production logic instead of importing production modules, so they can stay green while the shipped code regresses.

## Server Runtime Review

### 1. High: session authorization uses a path prefix check that is too weak

Affected code:

- `src/server/tmux.ts` -> `_realTmuxList()`
- `src/server/http.ts` -> `isAllowedSession()`
- All routes and websocket handlers that rely on `isAllowedSession()`

What is happening:

- Session allowlisting is based on `pane_current_path.startsWith(DEV_DIR)`.
- A path like `/Users/home/Developer/foo` still matches `/Users/home/Dev`.
- That means a session outside the intended dev root can be treated as allowed if its path shares a string prefix.

Why this matters:

- This is the main boundary protecting which tmux sessions the app can control.
- Once a session is misclassified as allowed, the app can send input, resize, or kill it.

Suggested fix:

- Replace string-prefix checking with normalized path containment.
- Resolve both paths first and compare using `path.relative()` or `DEV_DIR + path.sep` boundary logic.
- Add a regression test for a sibling path like `/Users/home/Developer`.

### 2. High: PTY websocket input drops binary payloads that start with `{`

Affected code:

- `src/server/websocket.ts` -> `setupNewPtyEntry()` message handler

What is happening:

- PTY input treats any binary frame whose first byte is `{` as JSON control traffic.
- Desktop stdin is sent as binary.
- Typing or pasting content that begins with `{` can be parsed as JSON, fail, and get discarded.

Why this matters:

- This is a real user-facing data-loss/input-loss bug in the desktop terminal path.
- It will hit common coding workflows because `{` is a normal first character in many languages and JSON snippets.

Suggested fix:

- Make the protocol explicit: string websocket frames are control messages, binary frames are raw stdin.
- Remove the "first byte is `{`" heuristic entirely.
- Add a websocket regression test that sends a binary frame beginning with `{`.

### 3. Medium: Ralph route path safety is inconsistent across endpoints

Affected code:

- `src/server/routes.ts` -> `GET /api/ralph/branches`
- `src/server/routes.ts` -> `POST /api/ralph/start`
- `src/server/routes.ts` -> `GET /api/ralph/plans`
- `src/server/routes.ts` -> `GET /api/ralph/log`
- `src/server/routes.ts` -> `GET /api/ralph/task-count`
- `src/server/routes.ts` -> `POST /api/ralph/cancel`
- `src/server/routes.ts` -> `POST /api/ralph/dismiss`

What is happening:

- Some Ralph endpoints reject symlinked project directories.
- Other Ralph endpoints read from or delete files under the project without the same symlink guard.

Why this matters:

- The safety model for project directories becomes endpoint-dependent.
- A symlink under `DEV_DIR` can let some routes escape the intended project tree even if others are safe.

Suggested fix:

- Centralize project directory resolution into one helper that validates:
- project name
- existence
- realpath containment under `DEV_DIR`
- not a symlink if that is the policy
- Use that helper in every Ralph route.

### 4. Medium: `/api/git-status` guesses the project from the session name

Affected code:

- `src/server/routes.ts` -> `GET /api/git-status`

What is happening:

- The route converts a session name into a project directory by stripping a trailing `-2`, `-3`, and so on.
- That assumes sessions always use dedupe suffixes and that project names never naturally end with numbers.

Why this matters:

- Custom session names can point this route at the wrong directory.
- Legitimate project names that end in a numeric suffix can be mis-resolved.

Suggested fix:

- Resolve the project from tmux metadata rather than from string surgery on the session name.
- If the route only supports project-backed sessions, make that explicit in the API contract.

### 5. Medium: route body validation is too loose in several hot paths

Affected code:

- `src/server/routes.ts` -> `POST /api/send`
- `src/server/routes.ts` -> `POST /api/create`
- `src/server/routes.ts` -> `POST /api/settings`
- `src/server/routes.ts` -> `POST /api/resize`
- `src/validation.ts` -> `clampCols()`, `clampRows()`

What is happening:

- Several handlers accept partially-untyped JSON and rely on truthiness checks or downstream coercion.
- `clampCols()` and `clampRows()` return `NaN` if `NaN` reaches them.
- Some routes call `.trim()` on fields after only partial validation.

Why this matters:

- Invalid requests should produce clean `400` responses.
- Instead, the current shape can produce silent coercion, inconsistent behavior, or route exceptions.

Suggested fix:

- Add a tiny shared validator per route or per payload shape.
- Validate types before trimming or clamping.
- Reject non-string and non-number values explicitly.

### 6. Medium: server startup mutates `PATH` via a login shell at import time

Affected code:

- `src/server/index.ts` -> top-level `PATH` initialization

What is happening:

- Startup runs `SHELL -lic "echo $PATH"` and trusts the output.
- This happens at module import time, before the server starts handling requests.

Why this matters:

- A noisy login shell, custom prompt output, or slow startup script can corrupt `PATH` or delay startup.
- Import-time side effects make the server harder to reason about and harder to test.

Suggested fix:

- Prefer a deterministic path augmentation strategy.
- If shell-derived `PATH` is still needed, run it in a safer, isolated helper with validation and a timeout.

### 7. Low: discovery timers are not always cleared on failure paths

Affected code:

- `src/server/http.ts` -> `discoverPeers()`
- `src/server/routes.ts` -> aggregated Ralph fetch path

What is happening:

- Abort timers are cleared on success but not consistently in failure cases.

Why this matters:

- This is small, but repeated failed discovery can leave unnecessary timers alive until they fire.

Suggested fix:

- Move timer cleanup into `finally`.

### 8. Low: session triage caches are never pruned

Affected code:

- `src/server/routes.ts` -> `prevPaneContent`
- `src/server/tmux.ts` -> triage cache map

What is happening:

- Old session state stays in memory even after sessions disappear.

Why this matters:

- This is minor memory growth.
- It also risks stale classification when a session name is reused.

Suggested fix:

- Prune cache entries when sessions disappear or when a session is explicitly killed.

## Frontend / PWA Review

### 1. High: the frontend API helper and action handlers disagree about failures

Affected code:

- `public/index.html` -> `api()`
- `public/index.html` -> `sendMsg()`
- `public/index.html` -> `sendQuickCmd()`
- `public/index.html` -> `sendKey()`
- `public/index.html` -> `killSession()`
- `public/index.html` -> `resizePane()`

What is happening:

- `api()` returns parsed JSON even on non-2xx responses.
- Several callers treat any resolved promise as success and only handle thrown errors in `catch`.

Why this matters:

- Failed actions can look successful.
- `sendMsg()` clears the composer before the request and only restores it in `catch`, so a structured 4xx response can lose typed input.
- `killSession()` and `sendKey()` can continue UI flows even when the backend rejected the request.

Suggested fix:

- Pick one contract and use it everywhere:
- either throw on any non-2xx response
- or return `{ ok, data, error }`
- Then update all action handlers to branch on that contract consistently.

### 2. Medium: grid reconnect behavior is weaker than single-terminal reconnect

Affected code:

- `public/index.html` -> `connectGridCellWs()`
- `public/index.html` -> `scheduleGridCellReconnect()`
- `public/index.html` -> desktop reconnect path for comparison

What is happening:

- Desktop terminal reconnect handles more close states and has clearer recovery behavior.
- Grid cells reconnect on a timer budget but do not have the same state handling or recovery affordances.

Why this matters:

- In grid mode, a long sleep or network flap can leave cells dead until the user manually rebuilds the grid.
- Desktop and grid behavior have already drifted into two different reliability models.

Suggested fix:

- Extract a shared reconnect strategy for PTY clients.
- Make grid and single-terminal paths share close-code handling, budget logic, and manual retry affordances.

### 3. Medium: malformed local storage can brick the frontend on startup

Affected code:

- `public/index.html` -> `wpSettings` initialization

What is happening:

- `wpSettings` is initialized with raw `JSON.parse(localStorage.getItem("wp-effects") || "{}")` at top level.
- Most other local storage reads in the file use `try/catch`, but this one does not.

Why this matters:

- A malformed `wp-effects` value or storage exception can stop the entire script before any UI renders.

Suggested fix:

- Wrap settings loading in a safe helper that falls back to defaults.
- Consider validating individual keys instead of trusting the parsed object wholesale.

### 4. Medium: grid focus restoration is wrong when removing a lower-index cell

Affected code:

- `public/index.html` -> `removeFromGrid()`
- `src/grid-logic.ts` -> `removeFromGridState()`

What is happening:

- Focus is only clamped after removal.
- If the removed cell was before the currently focused one, the focus index should shift left by one.

Why this matters:

- In larger grids, focus can jump to the wrong terminal after a removal.
- The extracted grid helper and the live UI share the same flaw.

Suggested fix:

- Decrement focus when `removedIndex < focusIndex`.
- Add a regression test for a 4+ cell grid where the focused cell is after the removed one.

### 5. Medium: active grid terminals do not react to font setting changes

Affected code:

- `public/index.html` -> `applyTermToXterm()`
- `public/index.html` -> grid xterm creation in `renderGridCells()`

What is happening:

- Settings changes update `desktopTerm`.
- Existing grid terminals keep the old font and size until the grid is rebuilt.

Why this matters:

- Desktop single-terminal mode and grid mode behave differently for the same settings.
- This is a sign that terminal setup logic is duplicated and drifting.

Suggested fix:

- Extract a shared "apply terminal settings" helper that updates both the single desktop terminal and all grid terminals.

### 6. Low: machine discovery state management is duplicated and destructive

Affected code:

- `public/index.html` -> startup discovery sync
- `public/index.html` -> machine discovery/settings paths

What is happening:

- Machine discovery logic is implemented in more than one place.
- Saved machines are pruned aggressively to the latest discovered peer set.

Why this matters:

- This makes machine persistence harder to reason about.
- Duplicate sync logic increases the chance that one path updates state differently from another.

Suggested fix:

- Centralize machine registry sync into one helper with a clear policy for:
- discovered peers
- manual entries
- renames
- pruning

## Ralph Automation Review

### 1. High: worker scope is enforced by prompt, not by execution boundary

Affected code:

- `src/ralph-macchio.ts` -> `ALLOWED_TOOLS`
- `src/ralph-macchio.ts` -> agent configs for `claude`, `codex`, `gemini`, `cursor`
- `src/ralph-macchio.ts` -> `buildPrompt()`
- `src/ralph-macchio.ts` -> `CLEANUP_PROMPT`

What is happening:

- The prompt says "only work under this project directory."
- The actual worker configuration still grants broad file-changing and shell tools.
- Some agent modes are launched with effectively very loose permissions.

Why this matters:

- Ralph is intended to be scoped per project.
- Today, that scope is more social than enforced.

Suggested fix:

- Tighten the execution boundary, not just the prompt.
- Reduce destructive tools where possible.
- Prefer per-project working directory restrictions and stricter allowed tool sets.

### 2. High: subtask expansion only adds one iteration regardless of how many subtasks were emitted

Affected code:

- `src/ralph-macchio.ts` -> main iteration loop around `parseSubtasks()`

What is happening:

- If a task breaks into multiple subtasks, the worker appends all of them but only increments `maxIterations` by one.

Why this matters:

- A late breakdown can leave new subtasks still open when the run ends.
- The loop budget no longer matches the amount of work Ralph just added to the plan.

Suggested fix:

- Increase the remaining work budget based on the number of accepted subtasks, subject to a ceiling.
- Add a regression test for a late iteration that emits multiple subtasks.

### 3. Medium: task completion tracking is brittle if the agent rewrites task text

Affected code:

- `src/ralph-macchio.ts` -> `markSectionDone()`
- `src/ralph-macchio.ts` -> `markCheckboxDone()`
- `src/ralph-macchio.ts` -> corruption detection in `main()`

What is happening:

- Completion marking depends on exact text matches.
- Corruption detection only notices task-count or done-count shrinkage.

Why this matters:

- If the agent rewrites a task header or checkbox text without changing the counts, the mark-done step can silently fail.
- Ralph can then re-pick work it already counted as completed.

Suggested fix:

- Track tasks by stable identifiers or header numbers rather than raw text alone.
- Add a regression test where the task text changes but task counts do not.

### 4. Medium: `/api/ralph/start` mutates git state before request validation is complete

Affected code:

- `src/server/routes.ts` -> `POST /api/ralph/start`

What is happening:

- The route acquires the lock and may create/switch a branch before validating the selected plan file fully.

Why this matters:

- A failing request can still mutate repository state.
- It also leaves startup flow harder to reason about because validation and side effects are interleaved.

Suggested fix:

- Validate everything first:
- project
- plan filename
- plan existence
- iteration bounds
- agent
- only then acquire locks and mutate git state

### 5. Medium: cleanup scope is broader than the current Ralph session

Affected code:

- `src/ralph-macchio.ts` -> `START_COMMIT`
- `src/ralph-macchio.ts` -> `CLEANUP_PROMPT`

What is happening:

- The worker records `START_COMMIT`.
- Cleanup still tells the agent to inspect `HEAD~10..HEAD` rather than the actual start commit boundary.

Why this matters:

- On a long-lived branch, cleanup can inspect or remove code unrelated to the current Ralph run.

Suggested fix:

- Base cleanup on `START_COMMIT..HEAD` when available.

### 6. Low-Medium: Ralph log parsing has side effects and trusts raw PID liveness too much

Affected code:

- `src/server/ralph.ts` -> `parseRalphLog()`

What is happening:

- A read-style function deletes `.ralph.lock` when it decides a PID is dead.
- "active" is based on `process.kill(pid, 0)` alone.

Why this matters:

- Read paths should not quietly mutate lock state.
- PID reuse can create false positives.

Suggested fix:

- Split parsing from reconciliation.
- Make stale-lock cleanup explicit and scoped to start/cancel flows.

## CLI / Setup / Service Review

### 1. High: `killPortHolder()` can terminate unrelated local processes

Affected code:

- `src/cli/config.ts` -> `killPortHolder()`
- `src/cli/service.ts` -> callers in service lifecycle commands

What is happening:

- The helper looks up any PID listening on the configured port and sends `SIGTERM`.
- It does not verify that the process belongs to Wolfpack.

Why this matters:

- A user can accidentally kill another local app that happens to use the same port.
- The current log message labels that process as "stale" even when it is not.

Suggested fix:

- Verify the process identity before killing it.
- If verification is not possible, prompt the user or refuse automatic termination.

### 2. High: plain `wolfpack` currently does a heavy reinstall/restart path

Affected code:

- `src/cli/index.ts` -> `start()`
- `src/cli/service.ts` -> `serviceInstall()`

What is happening:

- A normal `wolfpack` invocation calls `serviceInstall()`.
- `serviceInstall()` is not just "ensure running"; it stops, rewrites, and restarts service state.

Why this matters:

- This is heavier and more disruptive than users would expect from a normal start command.
- It can bounce active sessions and rewrite service definitions unnecessarily.

Suggested fix:

- Split service behavior into:
- install or update definition
- ensure running
- Use the lightweight path for plain `wolfpack`.

### 3. Medium: config loading is unvalidated and can produce CLI/server disagreement

Affected code:

- `src/cli/config.ts` -> `loadConfig()`
- `src/cli/index.ts` -> daemon-mode env population
- `src/server/index.ts` -> `PORT`
- `src/server/tmux.ts` -> `DEV_DIR`

What is happening:

- `loadConfig()` trusts raw JSON.
- The CLI copies the loaded fields directly into environment variables.
- The server and tmux layers apply different fallback behavior once those values are consumed.

Why this matters:

- A malformed config can make the CLI advertise one port while the daemon uses another.
- Invalid paths can flow further than they should before validation happens.

Suggested fix:

- Normalize and validate config once at load time.
- Make all downstream consumers depend on the same validated shape.

## Testing / QA Review

### 1. High: several "integration" and snapshot tests mirror production code instead of importing it

Affected code:

- `tests/integration/api.test.ts`
- `tests/integration/ralph-api.test.ts`
- `tests/snapshot/plist.test.ts`
- `tests/snapshot/systemd.test.ts`
- `tests/unit/escaping.test.ts`

What is happening:

- The tests reimplement helpers, routes, and generators instead of calling the shipped modules directly.

Why this matters:

- These tests can pass while production code drifts.
- This is already visible in places where the tests no longer reflect current production behavior.

Suggested fix:

- Prefer importing real production helpers and testing them directly.
- Reserve mirrors only for cases where the real code is impossible to isolate.

### 2. Medium: desktop-specific flows have weak end-to-end coverage

Affected code:

- `tests/e2e/terminal.spec.ts`
- `tests/e2e/reconnect.spec.ts`
- other e2e flows that skip the desktop project

What is happening:

- The existing e2e suite focuses on the mobile `/ws/terminal` path.
- Desktop `/ws/pty`, reconnect, takeover, and grid behaviors are much less covered.

Why this matters:

- Several of the most important current bugs live in the desktop-only path.

Suggested fix:

- Add desktop e2e coverage for:
- raw PTY input
- reconnect
- takeover/displacement
- grid mode

### 3. Medium: some tests are too shallow for the feature they claim to cover

Affected code:

- `tests/e2e/session-switch.spec.ts`

What is happening:

- The current session-switch test verifies opening the drawer, not a full switch flow.

Why this matters:

- State-reset bugs, reconnect behavior, and terminal-state transfer can slip through.

Suggested fix:

- Extend the test to actually switch sessions and verify the resulting terminal behavior.

### 4. Medium: important regressions currently have no direct tests

Missing direct tests for:

- session path-boundary authorization in `tmuxList()`
- PTY binary payloads beginning with `{`
- structured non-2xx JSON frontend action failures
- malformed `wp-effects` local storage
- grid focus after removal of a lower-index cell
- Ralph late subtask expansion
- Ralph task rewrite with stable counts
- Ralph start branch creation combined with invalid or missing plan file
- symlink safety on all Ralph endpoints

## Simplification Opportunities

These are not the highest-severity bugs, but they are where the codebase would benefit from simplification.

### Frontend

- Split `public/index.html` into small modules:
- API client
- settings store
- machine registry
- mobile terminal controller
- desktop terminal controller
- grid controller
- Ralph UI
- escaping/render helpers
- Either make `src/grid-logic.ts` the true runtime source of truth or remove it. Right now it is described as canonical, but the live UI still has separate grid logic.
- Replace large inline `onclick="..."` HTML generation with event delegation and `data-*` attributes.
- Extract a shared xterm factory and shared PTY reconnect strategy.

### Server

- Centralize route payload validation.
- Centralize project directory resolution and path safety rules.
- Move import-time startup effects out of module top level where possible.

### Ralph

- Split `src/ralph-macchio.ts` into:
- plan parsing and mutation
- agent invocation
- iteration loop
- cleanup pass
- Make plan grammar single-source across prompts, validators, and tests.

### CLI / Service

- Split service definition generation from lifecycle actions.
- Normalize config in one place.
- Avoid destructive automatic process cleanup unless the target process is verified.

### Tests

- Replace mirrored helpers with imported production modules.
- Keep regression tests close to the bug that motivated them.

## Recommended Fix Order

### Phase 1: correctness and safety

- Fix tmux session path containment.
- Fix PTY `{` binary input handling.
- Fix frontend API error contract and `sendMsg()` input loss.
- Stop `killPortHolder()` from terminating unrelated processes.
- Validate all `ralph/start` inputs before lock creation and git mutation.
- Tighten Ralph worker execution scope.

### Phase 2: reliability and consistency

- Unify Ralph project path validation across endpoints.
- Fix grid reconnect parity and grid focus restoration.
- Harden frontend settings loading.
- Validate route payloads consistently.
- Normalize config loading and plain `wolfpack` lifecycle behavior.

### Phase 3: simplification and maintainability

- Modularize the frontend.
- Split `ralph-macchio.ts`.
- Replace mirrored tests with direct production imports.
- Consolidate discovery, terminal setup, and validation helpers.

## Final Notes

- This audit was based on static review of the repository state present during the audit.
- The biggest structural risk is not "bad code quality" in the abstract; it is drift between duplicated implementations:
- desktop vs grid terminal logic
- production vs test helpers
- prompt rules vs validator rules
- CLI expectations vs actual lifecycle behavior
- Fixing those duplication boundaries will remove a large fraction of the current bug surface.
