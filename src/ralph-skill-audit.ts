/**
 * Ralph audit+fix skill — security-focused differential review.
 */

export interface AuditSkillParams {
  projectDir: string;
  planFile: string;
  progressFile: string;
  diffBase: string;
}

export function buildAuditFixPrompt(p: AuditSkillParams): string {
  return `You may ONLY create/edit/delete files under ${p.projectDir}. Do NOT touch files outside this directory.

@${p.planFile} @${p.progressFile}

You are running a SECURITY-FOCUSED DIFFERENTIAL REVIEW after all implementation iterations.

═══════════════════════════════════════════════════
PHASE 0 — INTAKE & TRIAGE
═══════════════════════════════════════════════════

1. Extract changes:
   \`\`\`
   git diff --stat ${p.diffBase} HEAD
   git log --oneline ${p.diffBase}..HEAD
   git diff --name-only ${p.diffBase} HEAD 2>/dev/null || git diff --name-only HEAD
   \`\`\`

2. Assess codebase size and select strategy:
   - SMALL (<20 changed files): DEEP — read all deps, full git blame
   - MEDIUM (20-200): FOCUSED — 1-hop deps, priority files only
   - LARGE (200+): SURGICAL — critical paths only

3. Risk-score EACH changed file:
   - HIGH: auth, crypto, external calls, process spawning, validation removal, file I/O with user input
   - MEDIUM: business logic, state changes, new public APIs, config changes
   - LOW: comments, tests, UI cosmetics, logging

═══════════════════════════════════════════════════
PHASE 1 — CHANGED CODE ANALYSIS
═══════════════════════════════════════════════════

For each changed file (prioritize HIGH risk first):

1. Read the full file, not just the diff. Understand its role.

2. Analyze each diff region:
   BEFORE: [exact removed code]
   AFTER:  [exact added code]
   CHANGE: [behavioral impact]
   SECURITY: [implications]

3. Git blame removed code — understand WHY it existed:
   \`\`\`
   git log -S "removed_code_pattern" --all --oneline
   \`\`\`
   Red flags:
   - Removed code from "fix", "security", "CVE", "audit" commits → CRITICAL
   - Recently added (<1 month) then removed → HIGH
   - No explanation for removal → investigate

4. Check for regressions (previously removed code re-added):
   \`\`\`
   git log -S "added_code_pattern" --all --oneline -p
   \`\`\`
   Pattern: code added → removed for security → re-added now = REGRESSION

5. Micro-adversarial analysis for each change:
   - What attack did removed code prevent?
   - What new attack surface does new code expose?
   - Can modified logic be bypassed?
   - Are checks weaker? Edge cases covered?

═══════════════════════════════════════════════════
PHASE 2 — TEST COVERAGE ANALYSIS
═══════════════════════════════════════════════════

1. Identify production code changes vs test changes:
   \`\`\`
   git diff --name-only ${p.diffBase} HEAD | grep -v test
   git diff --name-only ${p.diffBase} HEAD | grep test
   \`\`\`

2. For each changed function, search for corresponding tests.

3. Risk elevation rules:
   - NEW function + NO tests → elevate MEDIUM→HIGH
   - MODIFIED validation + UNCHANGED tests → HIGH RISK
   - Complex logic (>20 lines changed) + NO tests → HIGH RISK

═══════════════════════════════════════════════════
PHASE 3 — BLAST RADIUS ANALYSIS
═══════════════════════════════════════════════════

For each modified function/export:

1. Count all callers/importers using grep.

2. Classify blast radius:
   - 1-5 callers: LOW
   - 6-20 callers: MEDIUM
   - 21-50 callers: HIGH
   - 50+ callers: CRITICAL

3. Priority matrix:
   | Change Risk | Blast Radius    | Priority | Analysis Depth    |
   |-------------|-----------------|----------|-------------------|
   | HIGH        | CRITICAL        | P0       | Deep + all deps   |
   | HIGH        | HIGH/MEDIUM     | P1       | Deep              |
   | HIGH        | LOW             | P2       | Standard          |
   | MEDIUM      | CRITICAL/HIGH   | P1       | Standard + callers|

═══════════════════════════════════════════════════
PHASE 4 — DEEP CONTEXT (HIGH RISK changes only)
═══════════════════════════════════════════════════

For each HIGH RISK changed function:

1. Map complete function flow:
   - Entry conditions (preconditions, guards, middleware)
   - State reads (which variables/files/DBs accessed)
   - State writes (which variables/files/DBs modified)
   - External calls (to processes, APIs, filesystem)
   - Return values and side effects

2. Trace callers recursively — build call graph.

3. Identify invariants:
   - What must ALWAYS be true?
   - What must NEVER happen?
   - Are invariants maintained after changes?

4. Five Whys root cause:
   - WHY was this code changed?
   - WHY did the original code exist?
   - WHY might this break?
   - WHY is this approach chosen?
   - WHY could this fail in production?

═══════════════════════════════════════════════════
PHASE 5 — ADVERSARIAL ANALYSIS (HIGH RISK changes only)
═══════════════════════════════════════════════════

For each HIGH RISK finding, model the attacker:

1. Define attacker:
   - WHO: unauthenticated user, authenticated user, local process, network peer
   - WHAT ACCESS: public APIs, CLI args, file system, network
   - WHERE: specific endpoints, functions, entry points

2. Build concrete exploit scenario:
   ATTACKER POSITION: [starting state]
   Step 1: [specific action with exact parameters]
   Step 2: [how it reaches vulnerable code]
   Step 3: [what happens — reference the code change]
   IMPACT: [specific, measurable harm]

3. Rate exploitability:
   - EASY: single request, no special privileges
   - MEDIUM: multiple steps or specific conditions
   - HARD: requires privileged access or rare state

═══════════════════════════════════════════════════
VULNERABILITY CHECKLIST
═══════════════════════════════════════════════════

Systematically check changed code for:

Injection & input handling:
   - Command injection: user/external input reaching shell commands, exec, spawn
   - Path traversal: unsanitized paths in file operations, directory escapes via ../
   - SQL/NoSQL injection, template injection, header injection
   - Regex DoS (ReDoS): catastrophic backtracking in user-facing patterns

Authentication & authorization:
   - Missing or bypassable auth checks on new endpoints/routes
   - Privilege escalation: actions permitted beyond intended scope
   - IDOR: direct object references without ownership validation

Data & secrets:
   - Hardcoded secrets, API keys, credentials in source
   - Sensitive data in logs, error messages, or responses
   - Missing encryption for data at rest or in transit

API & configuration footguns:
   - Dangerous defaults: insecure-by-default configs that users won't override
   - Misuse-prone APIs: parameter ordering that invites mistakes, boolean traps
   - Missing rate limiting, size limits, or timeout enforcement on new endpoints
   - Error handling that leaks internals or fails open instead of closed

Concurrency & state:
   - Race conditions: TOCTOU in file ops, unguarded shared state
   - Resource leaks: unclosed handles, missing cleanup on error paths
   - Deadlock potential in new lock/mutex usage

Logic & correctness:
   - Off-by-one errors, boundary condition failures
   - Incorrect edge-case handling, missing null/undefined guards
   - Type coercion bugs, implicit conversions
   - Mismatches between intended behavior and test assertions

Security regressions:
   - Previously removed code re-added
   - Validation removed without replacement
   - Access controls relaxed

═══════════════════════════════════════════════════
PHASE 6 — FIXES (apply only confirmed issues)
═══════════════════════════════════════════════════

1. Classify each finding: CRITICAL / HIGH / MEDIUM / LOW.
2. Fix CRITICAL and HIGH issues directly.
3. For each fix, add or update a targeted test that would have caught the issue.
4. Run all relevant tests to verify fixes don't regress.
5. Commit fixes with a message describing what was found and fixed.
6. Note MEDIUM/LOW findings in ${p.progressFile} without fixing.

═══════════════════════════════════════════════════
PHASE 7 — REPORT (write to ${p.progressFile})
═══════════════════════════════════════════════════

Append a structured audit report to ${p.progressFile}:

## Audit Report

### Summary
| Severity | Count |
|----------|-------|
| CRITICAL | N     |
| HIGH     | N     |
| MEDIUM   | N     |
| LOW      | N     |

### What Changed
| File | +Lines | -Lines | Risk | Blast Radius |
|------|--------|--------|------|--------------|

### Findings
For each finding:
- [SEVERITY] Title
- File: path:lineNumber
- Description + attack scenario
- Fix applied (or noted for future)

### Test Coverage
- Functions without tests (risk-elevated)

### Analysis Methodology
- Strategy used (DEEP/FOCUSED/SURGICAL)
- Files analyzed: X/Y
- Confidence level

═══════════════════════════════════════════════════
RULES
═══════════════════════════════════════════════════

- Do NOT add new features.
- Do NOT run broad refactors.
- Keep scope to changed files and directly-coupled code only.
- If no issues are found, leave code unchanged and record that in progress.
- Prioritize real exploitable issues over theoretical concerns.
- Every finding must reference specific file:line and commit.
- Attack scenarios must be CONCRETE — not "could cause issues".

BEGIN.`;
}
