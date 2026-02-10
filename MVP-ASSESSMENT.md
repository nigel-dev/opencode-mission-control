# MVP Readiness Assessment — opencode-mission-control v0.1.0

**Date:** 2025-02-10
**Assessed by:** Automated audit (Sisyphus)

---

## Executive Summary

**Ship it.** All 492 tests pass, the build produces a clean 0.61 MB bundle in 8ms, and every core feature (job launch, monitoring, plan orchestration, merge train, notifications) is implemented with proper error handling, cleanup paths, and test coverage. The Phase 0 security fixes (shell injection, singleton orchestrator, tmux validation, state validators) are complete. Remaining issues are quality-of-life: duplicated utility functions (3× `atomicWrite`, 3× `extractConflicts`, 4× `formatDuration`), two dead code files, an unused `zod` dependency, and some hardcoded `'main'` branch references. None of these are ship-blockers. The plugin is ready for a v0.1.0 npm publish.

---

## Test & Build Status

### Test Results

```
bun test v1.3.6 (d530ed99)

 492 pass
 0 fail
 1032 expect() calls
Ran 492 tests across 40 files. [58.34s]
```

One non-fatal console warning during tests (monitor.test.ts mocking produces a `TypeError: undefined is not an object` from `getRunningJobs()` returning `undefined` in a mock edge case). This does **not** cause any test failure — it's a log-level artifact of test isolation, not a production bug.

### Build Results

```
$ bun build ./src/index.ts --outdir ./dist --target bun
Bundled 114 modules in 8ms

  index.js  0.61 MB  (entry point)
```

Clean build, no warnings, no errors.

---

## Core Feature Readiness

| Feature | Status | Evidence |
|---------|--------|----------|
| **Job launch** (worktree + tmux) | ✅ Ready | `mc_launch` creates worktree, tmux session/window, prompt file, launcher script. Proper cleanup on all error paths. Supports session/window placement, OMO modes, worktree setup hooks (copyFiles, symlinkDirs, commands). |
| **Job monitoring** (polling, idle, pane death) | ✅ Ready | `JobMonitor` polls at configurable interval (default 10s, min 10s enforced). Idle detection via output hashing + session state detection (`ctrl+p commands` → idle, `⬝` → streaming). Pane death captured via exit code. Agent report checking integrated into poll loop. |
| **Job lifecycle** (kill, cleanup, diff, merge, PR, sync) | ✅ Ready | All 6 lifecycle tools implemented: `mc_kill` (session/window kill), `mc_cleanup` (single/all, with optional branch deletion), `mc_diff` (stat or full), `mc_merge` (squash/ff-only/merge strategies), `mc_pr` (gh CLI, draft support), `mc_sync` (rebase/merge with conflict abort). |
| **Plan orchestration** (DAG, dependencies, modes) | ✅ Ready | Full DAG support: circular dependency detection, topological sort, merge-order respecting. Three modes: autopilot (fully automatic), copilot (pending → approve), supervisor (checkpoints at pre_merge, on_error, pre_pr). Reconciler runs every 5s, respects `maxParallel`, launches jobs when deps satisfied. |
| **Merge train** (sequential merge, test gate, rollback) | ✅ Ready | `MergeTrain` class handles sequential merging into integration branch. Supports squash, ff-only, and --no-ff strategies. Test command auto-detected from package.json or via config. Timeout support with rollback. Conflict detection with file-level reporting. Automatic rollback on test failure or conflict. |
| **Agent reporting** (mc_report, mc_overview) | ✅ Ready | `mc_report` auto-detects managed worktree, writes report with status/message/progress. `mc_overview` provides full dashboard: running jobs, recent completions/failures, alerts (blocked/needs_review), suggested actions, active plan status. Report dedup by job ID + timestamp. |
| **Notifications** (session.prompt, dedup) | ✅ Ready | Event-driven notifications for complete, failed, blocked, needs_review. Dedup via `getDedupKey()` (event + job ID + timestamp). Messages sent via `client.session.prompt` with `noReply: true`. Actionable next-step suggestions in each notification. Queue-based delivery (`pending = pending.then(...)`) prevents races. |
| **Configuration** (load, save, defaults) | ✅ Ready | Config stored at `~/.local/share/opencode-mission-control/{project}/config.json`. Full defaults provided. Atomic writes via temp file + rename. All config fields documented: placement, pollInterval, idleThreshold, maxParallel, autoCommit, mergeStrategy, testCommand, testTimeout, worktreeSetup, omo. |
| **Slash commands** | ✅ Ready | 6 commands registered: `/mc`, `/mc-jobs`, `/mc-launch`, `/mc-status`, `/mc-attach`, `/mc-cleanup`. Direct commands execute tools and send output via `noReply` session prompt. `/mc-launch` uses template delegation to AI. Error display to user with graceful `__MC_HANDLED__` control flow. |

---

## Critical Blockers

**None.** No ship-blocking issues identified.

---

## Recommended Pre-Ship Fixes

Prioritized by risk and effort:

### P0 — Fix Before Publish

1. **Remove `zod` from dependencies** — Listed in package.json `dependencies` but never imported anywhere in `src/`. Adds unnecessary weight for users. One-line fix.

2. **Hardcoded `'main'` branch references** — Six locations across `integration.ts`, `orchestrator.ts`, `worktree.ts`, `merge.ts`, `pr.ts`, `diff.ts` hardcode `'main'` as the default branch. Should detect via `git symbolic-ref refs/remotes/origin/HEAD` or accept a config option. Affects users with `master` or other default branches.

### P1 — Fix Soon After Publish

3. **Deduplicate `atomicWrite`** — Identical implementation copy-pasted in `config.ts`, `job-state.ts`, `plan-state.ts`. Extract to a shared `src/lib/fs-utils.ts`.

4. **Deduplicate `extractConflicts`** — Identical function in `merge-train.ts`, `integration.ts`, `worktree.ts`. Extract to shared git utility.

5. **Deduplicate `formatDuration`** — Four slightly different implementations in `notifications.ts`, `overview.ts`, `status.ts`, `jobs.ts`. Consolidate signatures and extract.

6. **Remove dead code** — `src/lib/test-runner.ts` (unused, superseded by `runTestCommand` in merge-train.ts) and `src/hooks/awareness.ts` (unreferenced). Neither is imported anywhere.

### P2 — Nice to Have

7. **Monitor test mock cleanup** — The `TypeError` in `monitor.test.ts` is cosmetic but noisy. Ensure `getRunningJobs()` mock always returns an array.

---

## Post-Ship Improvements (v0.2.0+)

- **Configurable default branch** — Add `defaultBranch` to `MCConfig`, detect from remote HEAD on first run.
- **Zod validation for config** — Define a Zod schema for `MCConfig` to validate user config files at load time (if keeping zod, otherwise remove it).
- **Worktree health check** — `mc_overview` could verify worktree integrity (existence, git status) not just tmux pane state.
- **Retry failed jobs** — `mc_retry` tool to relaunch a failed job with same params.
- **Plan persistence across restarts** — `resumePlan()` exists but could be more robust around edge cases (e.g., partial merge state).
- **Structured logging** — Replace `console.error`/`console.warn` with a proper log utility (levels, timestamps, optional file output).
- **Bundle size optimization** — 0.61 MB is acceptable for MVP but could be reduced with tree-shaking review.
- **TypeScript strict mode** — Enable `strict: true` and resolve any resulting type issues.
- **E2E integration tests** — Current tests are unit-level with mocks. Add a small E2E suite that actually creates worktrees and tmux sessions.

---

## File Count Summary

| Category | Count |
|----------|-------|
| Source files | 45 |
| Test files | 40 |
| MCP tools | 17 |
| Tests passing | 492 / 492 |
| expect() calls | 1,032 |
