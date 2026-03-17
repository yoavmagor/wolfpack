# Worktree Isolation for Ralph Tasks (#73)

## Context

When ralph runs tasks, agents all operate on the same working tree. This causes merge conflicts, file stomping, and git state corruption with concurrent agents. Worktree isolation gives each task (or entire plan) its own git worktree — separate working directory, shared object store, zero conflicts.

## Modes

| Mode | `worktree` param | Behavior |
|------|-----------------|----------|
| Off | `false` (default) | Current behavior, no worktrees |
| Plan | `"plan"` | One worktree for entire ralph run |
| Task | `"task"` | New worktree per task, chained (task N branches off task N-1) |

### Task mode chaining

```
source branch (e.g. main)
  └─ ralph/<id>-add-auth        ← task 1 worktree
       └─ ralph/<id>-write-tests   ← task 2 worktree (branches off task 1)
            └─ ralph/<id>-add-api     ← task 3 worktree (branches off task 2)
                                        ↑ final worktree = all changes
```

- Worktrees persist between tasks (no mid-run cleanup)
- Branch names: `ralph/<task-id>-<task-name-slug>` (e.g. `ralph/1-add-auth`)
- On dismiss: clean up all worktrees EXCEPT the final one
- No auto-merge back to source

---

## ~~1. Add `.wolfpack/` to .gitignore and create worktree utility module~~

**Files**: `.gitignore`, `src/worktree.ts` (new)

New module `src/worktree.ts` with:
- `slugifyTaskName(header: string): string` — extract task title from `## N. Title` header, lowercase, kebab-case, truncate to 40 chars
- `createWorktree(projectDir: string, branchName: string, baseBranch: string): string` — runs `git worktree add .wolfpack/worktrees/<slug> -b <branchName> <baseBranch>`, returns worktree path
- `removeWorktree(worktreePath: string): void` — runs `git worktree remove <path>`
- `listWorktrees(projectDir: string): WorktreeInfo[]` — runs `git worktree list --porcelain`, parses output
- `cleanupAllExceptFinal(projectDir: string): { removed: string[], kept: string }` — removes all `.wolfpack/worktrees/*` except the last one (by creation order)

Add `.wolfpack/` to `.gitignore`.

## ~~2. Extend ralph worker to support worktree modes~~

**Files**: `src/ralph-macchio.ts`

- Add `--worktree` CLI arg (`false` | `plan` | `task`)
- **Plan mode**:
  - At startup, call `createWorktree()` once, set `PROJECT_DIR` to worktree path
  - All iterations run in that single worktree
  - On exit (normal + SIGTERM), leave worktree in place (no cleanup)
- **Task mode**:
  - Before each iteration, call `createWorktree()` with previous task's branch as base
  - Track `currentWorktreeDir` — set as `cwd` for `runIteration()`
  - Track `previousBranch` to chain worktrees
  - Use `slugifyTaskName()` on extracted task header for branch name
  - Keep `LOG_FILE` and `LOCK_FILE` in original `PROJECT_DIR` (not worktree) so status tracking still works
  - `PLAN_PATH` must be read from original project dir (plan lives in main tree)
  - Agent `cwd` = worktree dir (where it makes changes)
  - Agent prompt constraint updated to worktree path
- **Key detail**: `buildPrompt()` line 239 needs to use worktree path instead of PROJECT_DIR when in worktree mode
- Cleanup/audit phases run in the final worktree (task mode) or the single worktree (plan mode)

## ~~3. Extend start API to accept worktree param~~

**Files**: `src/server/routes.ts`

- Add `worktree?: false | "plan" | "task"` to `POST /api/ralph/start` body
- Validate the param
- Pass `--worktree <mode>` to worker args (line 613-623)
- For plan mode: create the worktree before spawning worker, pass worktree path as `cwd`
- For task mode: worker handles worktree creation internally (per iteration)

## ~~4. Extend dismiss API for worktree cleanup~~

**Files**: `src/server/routes.ts`

- In `POST /api/ralph/dismiss`:
  - Detect if worktrees exist under `.wolfpack/worktrees/`
  - If task mode: prompt includes info that all worktrees except final will be removed
  - Call `cleanupAllExceptFinal()` from worktree module
  - Return `{ kept: "ralph/3-final-task", removed: ["ralph/1-add-auth", "ralph/2-write-tests"] }` in response
  - Also run `git worktree prune` to clean stale refs

## ~~5. Tests~~

**Files**: `tests/unit/worktree.test.ts` (new), `tests/integration/ralph-api.test.ts` (extend)

Unit tests for `src/worktree.ts`:
- `slugifyTaskName` — various header formats, special chars, truncation
- worktree path generation

Integration tests:
- Start ralph with `worktree: "plan"` — verify worktree created, worker runs in it
- Start ralph with `worktree: "task"` — verify chained worktrees
- Dismiss with worktrees — verify cleanup keeps final

---

## Key files to modify

| File | Change |
|------|--------|
| `.gitignore` | Add `.wolfpack/` |
| `src/worktree.ts` | NEW — worktree lifecycle utilities |
| `src/ralph-macchio.ts` | Worktree mode arg, per-iteration worktree creation (task mode), path routing |
| `src/server/routes.ts` | Start endpoint (worktree param + plan-mode creation), dismiss endpoint (cleanup) |
| `tests/unit/worktree.test.ts` | NEW — unit tests for worktree module |
| `tests/integration/ralph-api.test.ts` | Extend with worktree integration tests |

## Verification

1. `bun test` — all existing tests pass
2. Manual: start ralph with `worktree: "plan"` → verify `.wolfpack/worktrees/<id>` created, agent runs there
3. Manual: start ralph with `worktree: "task"` → verify chained worktrees, each on own branch
4. Manual: dismiss → verify intermediate worktrees removed, final kept
5. `git worktree list` — verify clean state after dismiss

## Status

- [x] 1. Worktree utility module + .gitignore
- [x] 2. Ralph worker worktree support
- [x] 3. Start API extension
- [x] 4. Dismiss API worktree cleanup
- [x] 5. Tests
