# Differential Security Review — `feat/worktree-isolation-ui`

**Date:** 2026-03-19
**Reviewer:** automated (claude-opus-4-6)
**Base:** `557498d` (fix: rewrite ralph worktree flow + merge ui-refactor work)
**Scope:** Uncommitted changes on `feat/worktree-isolation-ui` (6 files, +95/-9)

---

## Files Changed

| File | Delta | Summary |
|------|-------|---------|
| `src/ralph-macchio.ts` | +50/-2 | mainWorkDir/workingDir split, task sub-worktrees, merge, orphan cleanup |
| `src/server/ralph.ts` | +4/0 | `worktreeMode` field in `RalphStatus`; workdir-aware plan reading |
| `src/server/routes.ts` | (no diff) | Already committed — worktree mode validation, branch regex gating |
| `public/app-ralph.ts` | +35/-5 | Continue/Discard buttons, worktree mode enforcement on restart |
| `public/app-state.ts` | +1/0 | `currentRalphWorktreeMode` state field |
| `public/app.ts` | +1/-1 | Import rename: `restartRalph` -> `continueRalph`, add `discardRalph` |
| `src/public-assets.ts` | +3/-1 | Bundled JS update (auto-generated) |

---

## Finding 1 — PATH TRAVERSAL via `workdir` log field (MEDIUM)

**Location:** `src/server/ralph.ts:170-174`

```ts
const workdirMatch = content.match(/^workdir:\s*(.+)/m);
const planBase = workdirMatch && existsSync(join(workdirMatch[1].trim(), status.planFile))
  ? workdirMatch[1].trim()
  : projectDir;
const tasks = countPlanTasks(join(planBase, status.planFile));
```

**Issue:** The `workdir` value is read from `.ralph.log` (a file written by the worker). If an attacker can influence the log file contents (e.g. the agent writes arbitrary text that includes a line matching `^workdir: /etc/`), the server will read an arbitrary file via `countPlanTasks()`.

**Mitigating factors:**
- The `.ralph.log` file is written by the worker process itself, not by user input directly.
- `countPlanTasks` only calls `readFileSync` and runs regex counting — it doesn't expose file contents to the HTTP response, only task counts.
- The `status.planFile` is parsed from the same log and must end in `.md`.
- The agent runs with restricted tools (`ALLOWED_TOOLS`) but could still write to the log file indirectly (the worker appends agent stdout to the log).

**Risk:** LOW-MEDIUM. An agent outputting a crafted line `workdir: /some/path` to stdout would get it appended to `.ralph.log`. The server would then read `/some/path/PLAN.md` (or whatever the plan file is). The file contents are never returned to the client — only `{done, total}` counts. Practical exploitability is low but it violates the principle of least privilege.

**Recommendation:** Validate that `workdirMatch[1].trim()` starts with `projectDir` or is under the `.wolfpack/worktrees/` subtree before trusting it:
```ts
const workdir = workdirMatch?.[1]?.trim();
const planBase = workdir && workdir.startsWith(projectDir) && existsSync(join(workdir, status.planFile))
  ? workdir : projectDir;
```

---

## Finding 2 — `git branch -D` on orphan cleanup uses unvalidated branch names (LOW)

**Location:** `src/ralph-macchio.ts:731`

```ts
execFileSync("git", ["branch", "-D", orphan.branch], { cwd: PROJECT_DIR, stdio: "pipe" });
```

**Issue:** `orphan.branch` comes from `listWorktrees()`, which parses `git worktree list --porcelain` output. The branch name is extracted from `branch refs/heads/<name>` lines.

**Mitigating factors:**
- Uses `execFileSync` (not `exec`), so shell injection is impossible — arguments are passed as an array, not interpolated into a shell string.
- The branch name comes from git's own porcelain output, not from user input.
- The filter `w.branch.startsWith("ralph/")` constrains which branches are eligible for deletion.

**Risk:** LOW. No injection vector. The `ralph/` prefix guard prevents deleting unrelated branches. The `execFileSync` array form prevents shell metacharacter attacks.

**Verdict:** SAFE.

---

## Finding 3 — `discardRalph` validation (LOW)

**Location:** `public/app-ralph.ts:485-497`

```ts
export async function discardRalph() {
  if (!confirm("Discard this ralph loop? This removes the log and progress files.")) return;
  await deps.api("/ralph/dismiss", {
    method: "POST",
    body: JSON.stringify({ project: state.currentRalphProject }),
  }, state.currentRalphMachine);
}
```

**Issue:** `discardRalph` sends `state.currentRalphProject` to `/ralph/dismiss` without the `deletePlan` flag (defaults to `undefined`/falsy). The server-side handler:

1. Validates project via `resolveProjectDir` (name regex + `isUnderDevDir` realpath check)
2. Checks the loop is not active (409 if so)
3. Uses `SAFE_FILENAME` regex + `..` check before deleting progress/plan files
4. Only deletes `.ralph.log`, `.ralph.lock`, and the progress file

**Risk:** LOW. Server-side validation is thorough. The dismiss endpoint cannot be used to delete arbitrary files — the filenames come from the log file (not user input) and are validated against `SAFE_FILENAME`. The `discardRalph` function specifically does NOT pass `deletePlan: true`, so plan files are preserved.

**Verdict:** SAFE. No new risk introduced by the Discard button.

---

## Finding 4 — Worktree path sandbox escape (LOW)

**Location:** `src/worktree.ts:43-65`, `src/ralph-macchio.ts:626-678`

**Analysis:** Worktree paths are constructed as:
```ts
const slug = branchName.replace(/^ralph\//, "").replace(/[^a-z0-9-]/g, "-");
const worktreePath = join(realProjectDir, WORKTREE_DIR, slug);
```

The slug is aggressively sanitized — only `[a-z0-9-]` survives. Path traversal characters (`..`, `/`) are replaced with `-`. The branch name itself is validated by `BRANCH_REGEX` (`/^[a-zA-Z0-9._\-/]+$/`) on the server before being passed to the worker.

**Risk:** LOW. The slug sanitization eliminates directory traversal. Even if `branchName` contained `../../etc`, the slug would become `----etc`. The `realProjectDir` base path is resolved via `realpathSync`, preventing symlink attacks.

**Verdict:** SAFE.

---

## Finding 5 — Plan file path traversal in worktree context (LOW)

**Location:** `src/ralph-macchio.ts:72-74`

```ts
let PLAN_PATH = join(PROJECT_DIR, PLAN_FILE);
```

`PLAN_FILE` comes from `args.plan` which is passed by the server as `--plan <resolvedPlan>`. The server validates it with `isValidPlanFile()`:
```ts
export const PLAN_FILE_REGEX = /^[a-zA-Z0-9._\- ]+\.md$/;
```

This regex requires the name to be alphanumeric with dots/dashes/spaces, ending in `.md`. No slashes or `..` are possible.

**Verdict:** SAFE.

---

## Finding 6 — Isolation mode enforcement is client-side only (INFO)

**Location:** `public/app-ralph.ts:312-325`

When continuing a worktree-mode ralph loop, the radio buttons are disabled client-side:
```ts
isoRadios.forEach(r => {
  r.checked = r.value === mode;
  r.disabled = true;
});
```

The server does NOT enforce that a restarted loop must use the same worktree mode. A user could bypass the disabled radios via DevTools and start a new loop with a different mode.

**Risk:** INFO. This is a UX guardrail, not a security boundary. The user is already trusted — they own the machine and the project. Changing worktree mode mid-loop could cause orphaned worktrees but no privilege escalation.

**Recommendation:** If mode enforcement matters, add a server-side check in `POST /api/ralph/start` that compares the requested worktree mode against the existing `.ralph.log`'s `worktree:` field when restarting.

---

## Finding 7 — `continueRalph` passes worktreeMode via HTML onclick attribute (LOW)

**Location:** `public/app-ralph.ts:124-127`

```ts
const wt = escAttr(loop.worktreeMode || 'false');
actions.innerHTML = '<button ... onclick="continueRalph(\'' + escAttr(loop.planFile || '') + '\', ... ,\'' + wt + '\')">Continue</button>';
```

**Analysis:** `loop.worktreeMode` comes from the server's `RalphStatus.worktreeMode` field, which is parsed from `.ralph.log`. The value is escaped through `escAttr()` before HTML insertion. `escAttr` handles `\`, `'`, `"`, `<`, `>`, `&` — sufficient for the onclick context.

**Risk:** LOW. The escaping is correct for this context. Even if the log file contained malicious content in the `worktree:` field, it would be escaped before injection into the DOM.

**Verdict:** SAFE.

---

## Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Path traversal via `workdir` log field in plan reading | MEDIUM | Recommend fix |
| 2 | `git branch -D` orphan cleanup | LOW | Safe (execFileSync array form) |
| 3 | `discardRalph` validation | LOW | Safe (server validates) |
| 4 | Worktree path sandbox escape | LOW | Safe (slug sanitization) |
| 5 | Plan file path traversal | LOW | Safe (PLAN_FILE_REGEX) |
| 6 | Isolation mode enforcement client-side only | INFO | UX concern, not security |
| 7 | HTML attribute injection via worktreeMode | LOW | Safe (escAttr) |

**Overall assessment:** The worktree isolation implementation is well-defended. The only actionable finding is #1 (validate `workdir` path origin before trusting it for file reads). All git command invocations use `execFileSync` with array arguments, eliminating shell injection. Input validation on the server side is thorough and consistent.
