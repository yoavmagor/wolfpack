# Refactor Plan

## ~~1. Audit for duplicated code patterns
Scan `src/`, `public/`, and `tests/` for duplicated logic. Produce a list of dedup candidates with file paths, line ranges, and what's duplicated. Write findings to `progress.txt`. Do NOT refactor yet — just catalog.

## ~~2. Audit for refactoring opportunities
Scan for: oversized functions (>100 lines), repeated inline patterns, copy-pasted validation, similar error handling that could be unified. Add findings to `progress.txt` alongside the dedup list. Do NOT refactor yet.

## ~~3. Deduplicate shared validation logic
Extract repeated validation patterns (session name, project name, plan file, branch name) into a single reusable module if not already consolidated. Remove duplicates from callers.

## ~~4. Extract repeated error handling patterns
Identify repeated try/catch + log + return patterns across `src/server/routes.ts` and other server files. Extract into helpers where it reduces noise without hiding control flow.

## ~~5. Break up oversized functions
Split any functions over 100 lines into focused sub-functions. Prioritize `src/server/routes.ts` handlers and `src/ralph-macchio.ts`.

## 6. Deduplicate test helpers

Look for repeated test setup/teardown patterns across `tests/`. Extract shared fixtures and helpers into `tests/helpers/` if not already there.

- [ ] Split `POST /api/ralph/start` handler in routes.ts (~152 lines) into focused sub-functions: lock acquisition, input validation, branch creation, and worker spawning
- [ ] Split `main()` in ralph-macchio.ts (~286 lines) into focused sub-functions: setup/formatting phase, task-mode worktree management, iteration loop body, and post-loop finalization
