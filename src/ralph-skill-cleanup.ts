/**
 * Ralph cleanup+simplification skill — dead code removal and code quality.
 */

export interface CleanupSkillParams {
  projectDir: string;
  planFile: string;
  progressFile: string;
  diffBase: string;
}

export function buildCleanupPrompt(p: CleanupSkillParams): string {
  return `You may ONLY create/edit/delete files under ${p.projectDir}. Do NOT touch files outside this directory.

@${p.planFile} @${p.progressFile}

You are running a CLEANUP + SIMPLIFICATION pass after all tasks have been implemented.

PHASE 1 — INVENTORY (read-only, no edits yet):
1. Run \`git diff --name-only ${p.diffBase} HEAD 2>/dev/null || git diff --name-only HEAD\` to find all files changed during this session.
2. Run \`git diff ${p.diffBase} HEAD\` to get the full diff.
3. For each changed file, read the full file and map its exports, imports, and dependents.
4. Also identify files that IMPORT FROM the changed files (use grep/glob to find all importers).

PHASE 2 — DEAD CODE REMOVAL:
For each changed file and its dependents, identify:
   - Unreachable functions, unused imports, orphaned variables
   - Old code paths that were replaced but not removed
   - Commented-out code that is no longer relevant
   - Stale TODO/FIXME comments referencing completed work
   - Exports that are no longer imported anywhere
   - Interfaces/types that lost all consumers
   - Test helpers that test removed functionality

PHASE 3 — SIMPLIFICATION (review recently changed code only):
For each changed file, evaluate:

Unnecessary complexity:
   - Can any function be fewer lines while preserving behavior?
   - Are there abstractions that don't earn their weight? (wrappers around single calls, classes that should be functions, generics used once)
   - Would a senior dev look at this and say "why didn't you just..."?
   - Premature generalization: code handling cases that don't exist yet

Duplication & reuse:
   - Near-identical code blocks that should share a helper
   - Reimplemented logic that already exists elsewhere in the codebase
   - Copy-pasted patterns with minor variations that could be parameterized

Clarity:
   - Meaningless names (temp, data, result, val, item) — replace with intent-revealing names
   - Unnecessarily clever code that could be obvious instead
   - Boolean parameters that are confusing at call sites
   - Deep nesting that could be flattened with early returns

Consistency:
   - Style mismatches with the surrounding codebase (naming, patterns, error handling)
   - Mixed paradigms within the same module (callbacks + promises, classes + functions)

PHASE 4 — APPLY:
1. Remove all confirmed dead code.
2. Apply simplifications that clearly improve readability without changing behavior.
3. Do NOT simplify code you're uncertain about — leave it and note why.
4. Run all relevant tests to confirm nothing breaks.
5. Commit with message "chore: cleanup and simplify after ralph session".
6. Update ${p.progressFile} with:
   - Dead code removed (with file:line references)
   - Simplifications applied (what changed and why)
   - Items left alone (with reasoning)

RULES:
- Do NOT add new features.
- Do NOT change public API signatures or behavior.
- Do NOT remove comments that explain non-obvious logic.
- Only remove code you can confirm is unreachable or unused.
- Only simplify code that was changed in this session.
- If unsure, leave it.

BEGIN.`;
}
