# Mission Control — Manual E2E Test Plan (2.0, native sessions)

> **Context**: We are dogfooding this plugin from within the plugin's own repo.
> All `mc_*` tool calls are made by the AI agent (us) in an OpenCode 2.x session.
> This plan covers **all 18 tools**, **all 12 job states**, and **all 8 plan states**.
>
> **Backend**: every job is a native OpenCode session running in the job's git worktree on the
> same server as this session. There is no tmux, no per-job server and no port to check.
> Verification uses `mc_jobs` / `mc_status`, the OpenCode session list, `git worktree list`,
> `git branch`, and the state files.

> **Dynamic Path Convention**: All paths use `$(basename $(git rev-parse --show-toplevel))` instead of
> hardcoded project names. Run these from the **main worktree**. Variables used throughout:
>
> ```bash
> PROJECT_NAME=$(basename $(git rev-parse --show-toplevel))
> MC_ROOT=~/.local/share/opencode-mission-control/$PROJECT_NAME   # worktrees live here
> STATE_DIR=$MC_ROOT/state                                        # jobs.json, plan.json, config.json
> REPORTS_DIR=$MC_ROOT/reports                                    # <job-id>.json
> ```

---

## Emergency Nuclear Cleanup Script

**Run this FIRST if the environment is dirty, or LAST to guarantee clean state.**

Prefer the tools when they still work, because only they remove the jobs' OpenCode sessions:

1. `mc_plan_cancel` (if a plan is active)
2. `mc_kill` every running `tmc-*` job
3. `mc_cleanup` all=true, deleteBranch=true

Then run the script. It is idempotent and every command is fault-tolerant.

> **Warning**: steps 7–8 delete `plan.json` and `jobs.json` for this project, which forgets **all**
> jobs, not only `tmc-*` ones. Do not run it while real (non-test) jobs or plans exist.

```bash
#!/bin/bash
# Mission Control — Nuclear Cleanup (native backend)
# Safe to run at any time. All commands are idempotent.

PROJECT_NAME=$(basename $(git rev-parse --show-toplevel))
MC_ROOT=~/.local/share/opencode-mission-control/$PROJECT_NAME
STATE_DIR=$MC_ROOT/state
REPORTS_DIR=$MC_ROOT/reports

echo "=== Nuclear Cleanup: $PROJECT_NAME ==="

# 1. Remove ALL tmc-* worktrees (standalone jobs and plan jobs)
echo "Removing worktrees..."
for wt in $(git worktree list --porcelain 2>/dev/null | grep '^worktree ' | awk '{print $2}' | grep 'tmc-'); do
  git worktree remove --force "$wt" 2>/dev/null || true
done

# 2. Remove integration worktrees (from plan tests)
for wt in $(git worktree list --porcelain 2>/dev/null | grep '^worktree ' | awk '{print $2}' | grep 'mc-integration-'); do
  git worktree remove --force "$wt" 2>/dev/null || true
done

# 3. Prune stale worktree references
git worktree prune 2>/dev/null || true

# 4. Delete ALL mc/tmc-* branches (standalone test jobs)
echo "Deleting test branches..."
for br in $(git branch --list 'mc/tmc-*' --format='%(refname:short)' 2>/dev/null); do
  git branch -D "$br" 2>/dev/null || true
done

# 5. Delete plan job branches of test jobs: mc/plan/<plan>/tmc-*
for br in $(git branch --list 'mc/plan/*/tmc-*' --format='%(refname:short)' 2>/dev/null); do
  git branch -D "$br" 2>/dev/null || true
done

# 6. Delete ALL mc/integration-* branches
for br in $(git branch --list 'mc/integration-*' --format='%(refname:short)' 2>/dev/null); do
  git branch -D "$br" 2>/dev/null || true
done

# 7. Clean report files and plan state
echo "Cleaning reports and plan state..."
rm -f "$REPORTS_DIR/"*.json "$REPORTS_DIR/"*.json.tmp 2>/dev/null || true
rm -f "$STATE_DIR/plan.json" 2>/dev/null || true

# 8. Clean jobs state
echo "Cleaning jobs state..."
rm -f "$STATE_DIR/jobs.json" 2>/dev/null || true

# 9. Final prune
git worktree prune 2>/dev/null || true

echo "=== Nuclear Cleanup Complete ==="
echo "Now delete any leftover '[MC] tmc-*' sessions from the OpenCode session list."
```

**Leftover sessions**: the script cannot remove OpenCode sessions. If jobs were not cleaned up
with `mc_cleanup` first, open the session list and delete every session titled `[MC] tmc-*`.

---

## Standalone Reload Procedure

OpenCode loads the plugin from `src/`, so a code change needs no build:

```bash
# 1. (Optional) check that the server part still typechecks and bundles
bun run typecheck && bun run build

# 2. Reload OpenCode so the plugin is loaded again (/reload, or exit and re-enter).

# 3. Verify plugin loaded
#    Run mc_overview — if it responds, the plugin is loaded.
```

---

## Safety Rules

1. **Test name prefix**: All test jobs use the prefix `tmc-` (test-mission-control) to distinguish from real work.
2. **No pushes**: We never call `mc_pr` or `git push` during testing. `mc_pr` is verified structurally only (documented but never invoked).
3. **Simple prompts only**: Test job prompts create trivial files only (e.g., "Create test.txt containing hello").
4. **Snapshot & restore**: We record pre-test state (Phase 0) and verify post-test state matches (Final Phase).
5. **SHA-based resets**: NEVER use `HEAD~N` for git resets. Always save SHAs before merges (e.g., `$PHASE4_SHA`) and reset to them explicitly.
6. **Always `deleteBranch=true` on cleanup**: Every `mc_cleanup` call must include `deleteBranch=true` to prevent branch leaks.
7. **Cancel before completion**: Plans must be cancelled before all jobs reach `merged` state. If all jobs merge, an autopilot plan pushes the integration branch to the remote and enters `creating_pr`. Use `supervisor` mode for any plan whose jobs are allowed to finish: it stops at `pre_merge` and `pre_pr`.
8. **Dynamic paths only**: Never hardcode project names in paths. Use the variables defined at the top.
9. **Agent timing**: A job's session starts during the `mc_launch` call itself. Simple prompts complete in well under a minute. Two standard prompts are used below:
   - `$IDLE_PROMPT` = `"Reply with the single word READY. Do not create, modify or delete any file."` — finishes quickly and leaves the worktree untouched.
   - `$LONG_PROMPT` = `"Read every file in src/ one at a time and write a one-line summary of each to notes.txt as you go."` — keeps the job `running` long enough to inspect it.
10. **Cleanup before and after**: Run the Nuclear Cleanup before Phase 0 and again in the Final Phase.
11. **State file edits**: Only edit files under `$STATE_DIR` / `$REPORTS_DIR` where a step says so, and never while a tool call is in flight.

---

## Quick Smoke Test (5 minutes)

Run these tests for basic validation after a code change. References use test IDs from the full phases.

| Step | Source | Test | Purpose |
|------|--------|------|---------|
| 1 | Phase 0 | Nuclear Cleanup, 0.2–0.5 | Clean environment |
| 2 | Phase 1 | 1.1–1.7 (launch → worktree/branch/session → duplicate rejected) | Launch path |
| 3 | Phase 1 | 1.8–1.12 (status, capture, attach) | Observation tools |
| 4 | Phase 2 | 2.1 (error on nonexistent job), 2.7 (cleanup running job rejected) | Error handling |
| 5 | Phase 1 | 1.15–1.22 (kill → cleanup) | Stop and teardown |
| 6 | Phase 8 | 8.1–8.9 (blocked → `mc_answer` → completed) | Question round trip |
| 7 | Phase 5 | 5.7–5.10 (plan with deps → verify `waiting_deps` → cancel) | Plan basics |
| 8 | Phase 5 | 5.60 (retry + relaunch mutual exclusion) | Plan param validation |
| 9 | Phase 9 | 9.1 (overview empty) | Dashboard baseline |
| 10 | Final | Nuclear Cleanup + verification table | Clean exit |

**Pass criteria**: All 10 steps succeed. If any fail, run the full test plan for that phase.

---

## Tools Coverage Matrix

All 18 tools must be exercised during this plan. Check off as tested:

| Tool | Phase(s) | Notes |
|------|----------|-------|
| `mc_launch` | 1, 2, 3, 4, 6, 7, 8, 9, 10 | Core lifecycle, agent/model |
| `mc_jobs` | 1, 2, 3, 5, 12 | List/filter jobs |
| `mc_status` | 1, 2, 7, 8 | Detailed job info, usage, report |
| `mc_capture` | 1, 2, 8 | Transcript tail + structured events |
| `mc_attach` | 1, 2, 10, 12 | Instructions to open the session |
| `mc_answer` | 2, 8 | Answer a blocked job |
| `mc_diff` | 1, 2, 4 | Branch comparison |
| `mc_kill` | 1, 2, 3 | Interrupt a job's session |
| `mc_cleanup` | 1, 2, 3, 4, 5, 6, 12 | Remove session, worktree, branch |
| `mc_sync` | 2, 4 | Rebase/merge sync |
| `mc_merge` | 2, 4, 6 | Merge to base branch |
| `mc_pr` | — | **NOT tested** (pushes to remote). Structural mention only. |
| `mc_plan` | 5, 6, 9 | Create orchestrated plans |
| `mc_plan_status` | 5, 6 | Plan progress |
| `mc_plan_cancel` | 5, 6, 9 | Cancel active plan |
| `mc_plan_approve` | 5 | Approve copilot/supervisor, accept/relaunch/retry touchSet violations |
| `mc_report` | 8 | Called by job agents; verified through report files and status |
| `mc_overview` | 8, 9 | Dashboard summary |

---

## Job States Reference (12 total)

From `plan-types.ts`. Standalone jobs in `jobs.json` only use `running`, `completed`, `failed`, `stopped`; the rest are plan job states.

| State | Description | Observed In |
|-------|-------------|-------------|
| `queued` | Job created but not yet launched | Phase 5 |
| `waiting_deps` | Waiting for dependencies to merge | Phase 5, 6 |
| `running` | Agent is actively working (or waiting for an answer) | Phase 1, 3, 8 |
| `completed` | Agent finished successfully | Phase 1, 4, 8 |
| `failed` | Session failed/was interrupted, or touchSet violation | Phase 5G, 11 |
| `ready_to_merge` | Completed and queued for merge train | Phase 5 |
| `merging` | Currently being merged into integration | Phase 5 (observational) |
| `merged` | Successfully merged into integration | Phase 5 (observational) |
| `conflict` | Merge conflict detected | Phase 5 (observational) |
| `needs_rebase` | Trial merge found conflicts | Phase 5 (observational) |
| `stopped` | Manually killed via `mc_kill`, or migrated from an older state file | Phase 1, 3, 12 |
| `canceled` | Skipped/cancelled within a plan | Phase 5 (observational) |

---

## Plan States Reference (8 total)

From `plan-types.ts`:

| State | Description | Observed In |
|-------|-------------|-------------|
| `pending` | Created in copilot mode, awaiting approval | Phase 5E |
| `running` | Plan is actively executing | Phase 5A, 5B |
| `paused` | Checkpoint hit | Phase 5F, 5G |
| `merging` | Merge train running | Phase 5 (observational) |
| `creating_pr` | **NEVER reach this** — cancel before all jobs merge | — |
| `completed` | Plan fully done (PR created) | — |
| `failed` | Plan failed | Phase 5 (observational) |
| `canceled` | Plan cancelled via `mc_plan_cancel` (plan state is cleared) | Phase 5D |

---

## Phase 0 — Pre-Test State Snapshot

Record these before any testing begins:

| Artifact | Command | Baseline Value |
|----------|---------|----------------|
| git branches (mc/*) | `git branch --list 'mc/*'` | (record — should be empty) |
| git worktrees | `git worktree list` | (record — main only) |
| state dir contents | `ls $MC_ROOT $STATE_DIR` | (record) |
| jobs.json | `cat $STATE_DIR/jobs.json` | (record) |
| config.json | `cat $STATE_DIR/config.json` | (record — may be absent) |
| MC sessions | OpenCode session list, titles starting `[MC] tmc-` | none |
| working tree status | `git status` | clean |
| current branch | `git rev-parse --abbrev-ref HEAD` | Save as `$BASE_BRANCH` |
| HEAD SHA | `git rev-parse HEAD` | Save as `$INITIAL_SHA` |

| # | Action | Verify |
|---|--------|--------|
| 0.1 | Run Nuclear Cleanup (above) | All `tmc-*` artifacts removed |
| 0.2 | `mc_jobs` | "No jobs found." |
| 0.3 | `git worktree list` | Only main worktree |
| 0.4 | `git branch --list 'mc/*'` | Empty |
| 0.5 | `mc_plan_status` | "No active plan." |
| 0.6 | Record `$INITIAL_SHA` and `$BASE_BRANCH` | Saved for later phases |

---

## Phase 1 — Single Job Lifecycle

### 1A: Launch

| # | Test | Action | Expected |
|---|------|--------|----------|
| 1.1 | Launch basic job | `mc_launch` name=tmc-alpha, prompt=`$LONG_PROMPT` | `Job "tmc-alpha" launched successfully.` with ID, Branch `mc/tmc-alpha`, Base (the branch checked out in the main worktree), Worktree path, Session ID, and the "Watch it with" hints |
| 1.2 | Verify worktree created | `git worktree list \| grep tmc-alpha` | Entry at `$MC_ROOT/mc-tmc-alpha` |
| 1.3 | Verify branch created | `git branch --list mc/tmc-alpha` | Branch exists |
| 1.4 | Verify session exists | OpenCode session list | A session titled `[MC] tmc-alpha` |
| 1.5 | Verify job state persisted | `mc_jobs` | tmc-alpha under Running, with `Session: ses…` (and `Model:` when one was resolved) |
| 1.6 | Verify state file | `cat $STATE_DIR/jobs.json` | `"version": 4`; the job has `sessionID` and `launchSessionID`; no tmux/port fields |
| 1.7 | Duplicate name rejected | `mc_launch` name=tmc-alpha, prompt="anything" | Error: "already exists" |

### 1B: Status & Monitoring

| # | Test | Action | Expected |
|---|------|--------|----------|
| 1.8 | Status of running job | `mc_status` name=tmc-alpha | Shows Status, ID, Branch, Session, Created, Duration, Cost/Tokens, Worktree, Git Status, and "Recent Output (last 10 lines)" |
| 1.9 | Capture transcript | `mc_capture` name=tmc-alpha | Plain text: the prompt (`> …`), agent text, and tool lines like `[read path] completed` |
| 1.10 | Capture with line limit | `mc_capture` name=tmc-alpha, lines=5 | At most 5 lines |
| 1.11 | Capture structured events | `mc_capture` name=tmc-alpha, filter=all | JSON with `job`, `status`, `filter`, `summary`, `events` (or "No events accumulated yet") |
| 1.12 | Attach instructions | `mc_attach` name=tmc-alpha | Session ID, worktree path, "A tab for this session was requested in the TUI", the title `[MC] tmc-alpha` to pick from the session list, and a `cd <worktree> && opencode --session <id>` line. A connected TUI opens the job's session (Phase 14C); switch back to this session to continue |

### 1C: Diff

| # | Test | Action | Expected |
|---|------|--------|----------|
| 1.13 | Diff on job | `mc_diff` name=tmc-alpha | Shows diff, or "(no changes)" if nothing is committed yet |
| 1.14 | Diff stat mode | `mc_diff` name=tmc-alpha, stat=true | File-level summary |

### 1D: Kill

| # | Test | Action | Expected |
|---|------|--------|----------|
| 1.15 | Kill running job | `mc_kill` name=tmc-alpha | `stopped successfully`; output lists Session and Worktree |
| 1.16 | Verify job status updated | `mc_jobs` | tmc-alpha shows as `stopped` — and stays `stopped` (the interruption must not flip it to `failed`) |
| 1.17 | Verify session stopped, not deleted | Session list | `[MC] tmc-alpha` still exists and is no longer working |
| 1.18 | Kill already-stopped job | `mc_kill` name=tmc-alpha | "is already stopped." |
| 1.19 | Force flag accepted | `mc_kill` name=tmc-alpha, force=true | Same as 1.18 (flag has no effect) |
| 1.19b | Finished job keeps its status | `mc_kill` on a job that is `completed` | "is not running (status: completed); nothing to stop."; `mc_jobs` still shows it as `completed` |

### 1E: Cleanup

| # | Test | Action | Expected |
|---|------|--------|----------|
| 1.20 | Cleanup specific job | `mc_cleanup` name=tmc-alpha, deleteBranch=true | `✓ Cleaned up job "tmc-alpha" (stopped) and deleted branch` |
| 1.21 | Verify worktree and branch gone | `git worktree list`; `git branch --list mc/tmc-alpha` | No tmc-alpha entry; empty |
| 1.22 | Verify session and state gone | Session list; `mc_jobs` | No `[MC] tmc-alpha` session; "No jobs found." |

**Phase 1 Gate**: All artifacts from tmc-alpha must be fully cleaned before proceeding.

---

## Phase 2 — Error Handling & Edge Cases

| # | Test | Action | Expected |
|---|------|--------|----------|
| 2.1 | Status nonexistent job | `mc_status` name=doesnt-exist | Error: "not found" |
| 2.2 | Kill nonexistent job | `mc_kill` name=doesnt-exist | Error: "not found" |
| 2.3 | Cleanup nonexistent job | `mc_cleanup` name=doesnt-exist | Error: "not found" |
| 2.4 | Capture nonexistent job | `mc_capture` name=doesnt-exist | Error: "not found" |
| 2.5 | Diff nonexistent job | `mc_diff` name=doesnt-exist | Error: "not found" |
| 2.6 | Attach nonexistent job | `mc_attach` name=doesnt-exist | Error: "not found" |
| 2.7 | Cleanup running job rejected | Launch `tmc-beta` with `$LONG_PROMPT`, then `mc_cleanup` name=tmc-beta | Error: "Cannot cleanup running job" |
| 2.8 | Cleanup no args | `mc_cleanup` (no name, no all) | Error: Must specify either "name" or "all" |
| 2.9 | Cleanup both args | `mc_cleanup` name=tmc-beta, all=true | Error: Cannot specify both "name" and "all" |
| 2.10 | Sync nonexistent job | `mc_sync` name=doesnt-exist | Error: "not found" |
| 2.11 | Merge nonexistent job | `mc_merge` name=doesnt-exist | Error: "not found" |
| 2.12 | Answer nonexistent job | `mc_answer` name=doesnt-exist, response="x" | Error: "not found" |

**Cleanup after 2.1–2.12**:

| # | Action | Verify |
|---|--------|--------|
| 2.13 | `mc_kill` name=tmc-beta | Stopped |
| 2.14 | `mc_answer` name=tmc-beta, response="x" | Error: "is not running (status: stopped)" |
| 2.15 | `mc_cleanup` name=tmc-beta, deleteBranch=true | Fully cleaned |
| 2.16 | `mc_jobs` | "No jobs found." |

### 2B: Removed 1.x Arguments

| # | Test | Action | Expected |
|---|------|--------|----------|
| 2.17 | `placement` rejected | `mc_launch` name=tmc-old, prompt=`$IDLE_PROMPT`, placement=session | Rejected as an unknown argument; no job, worktree or branch created |
| 2.18 | `mode` rejected | `mc_launch` name=tmc-old, prompt=`$IDLE_PROMPT`, mode=vanilla | Rejected as an unknown argument |
| 2.19 | Nothing leaked | `mc_jobs`; `git branch --list mc/tmc-old` | No tmc-old |

### 2C: Post-Create Hook Parameters

| # | Test | Action | Expected |
|---|------|--------|----------|
| 2.20 | Launch with commands | `mc_launch` name=tmc-cmds, prompt=`$IDLE_PROMPT`, commands=["echo setup-ran > .mc-setup-marker"] | OpenCode asks for the `shell` permission for the command (unless your rules already allow it); once allowed the job launches, and the output warns that the command contains risky shell syntax (redirection) |
| 2.21 | Verify command ran | `cat $MC_ROOT/mc-tmc-cmds/.mc-setup-marker` | "setup-ran" |
| 2.22 | Failing command aborts launch | `mc_launch` name=tmc-cmdfail, prompt=`$IDLE_PROMPT`, commands=["false"] | Error mentions "Post-create command failed"; no job in `mc_jobs`, no `[MC] tmc-cmdfail` session; the worktree and the `mc/tmc-cmdfail` branch are removed again (`git worktree list`, `git branch --list mc/tmc-cmdfail`) |
| 2.23 | Launch with symlinkDirs | `mc_launch` name=tmc-symlink, prompt=`$IDLE_PROMPT`, symlinkDirs=["node_modules"] | Job launches |
| 2.24 | Verify symlink | `ls -la $MC_ROOT/mc-tmc-symlink/node_modules` | Shows symlink arrow (→) |
| 2.25 | Create temp file for copy test | Create `.env.example` in main worktree with content `TEST_VAR=hello` | File exists |
| 2.26 | Launch with copyFiles | `mc_launch` name=tmc-copy, prompt=`$IDLE_PROMPT`, copyFiles=[".env.example"] | Job launches |
| 2.27 | Verify file copied | `ls -la $MC_ROOT/mc-tmc-copy/.env.example` | Regular file (not a symlink), content matches |
| 2.28 | Cleanup | Wait for the jobs to complete (or `mc_kill` them); `mc_cleanup` all=true, deleteBranch=true; `rm .env.example` | Clean. `git branch --list 'mc/tmc-*'` is empty |

---

## Phase 3 — Multiple Jobs

| # | Test | Action | Expected |
|---|------|--------|----------|
| 3.1 | Launch job 1 | `mc_launch` name=tmc-multi-1, prompt=`$LONG_PROMPT` | Success |
| 3.2 | Launch job 2 | `mc_launch` name=tmc-multi-2, prompt=`$LONG_PROMPT` | Success, different session ID and worktree |
| 3.3 | List shows both | `mc_jobs` | Both shown as `running`, each with its own `Session:` |
| 3.4 | Two sessions | Session list | `[MC] tmc-multi-1` and `[MC] tmc-multi-2` |
| 3.5 | Status filter: running | `mc_jobs` status=running | Only running jobs shown |
| 3.6 | Kill one, list mixed states | `mc_kill` name=tmc-multi-1, then `mc_jobs` | multi-1=`stopped`, multi-2=`running` |
| 3.7 | Cleanup all non-running | `mc_cleanup` all=true, deleteBranch=true | multi-1 cleaned, multi-2 untouched (still running) |
| 3.8 | Status filter: completed | `mc_jobs` status=completed | Only completed jobs (may be empty) |
| 3.9 | Status filter: failed | `mc_jobs` status=failed | Only failed jobs (may be empty) |
| 3.10 | Status filter: all | `mc_jobs` status=all | All jobs |
| 3.11 | Kill remaining | `mc_kill` name=tmc-multi-2 | Stopped |
| 3.12 | Cleanup all | `mc_cleanup` all=true, deleteBranch=true | All cleaned |
| 3.13 | Cleanup with nothing to do | `mc_cleanup` all=true | "No non-running jobs to cleanup." |
| 3.14 | Verify clean state | `mc_jobs` + `git worktree list` + session list | No test artifacts remain |

**Note**: `status=stopped` is NOT a valid filter value. Stopped jobs appear when using `status=all`.

---

## Phase 4 — Git Workflow (Sync & Merge)

This phase tests the git integration tools on a job with real commits.

**CRITICAL**: Save SHAs before any merges. NEVER use `HEAD~N`.

> `mc_merge` requires the main worktree to be on the job's base branch with no uncommitted
> changes. A job launched without `baseBranch` records the branch checked out in the main
> worktree as its base, so `baseBranch=$BASE_BRANCH` (recorded in Phase 0) only makes that
> explicit. Stay on `$BASE_BRANCH` in the main worktree for the whole phase.

### Setup

| # | Action | Expected |
|---|--------|----------|
| 4.1 | Record `$PHASE4_SHA` = `git rev-parse HEAD`; confirm `git status` is clean | SHA saved |
| 4.2 | `mc_launch` name=tmc-git, prompt=`$IDLE_PROMPT`, baseBranch=`$BASE_BRANCH` | Job launched |
| 4.3 | Wait until `mc_jobs` shows tmc-git as `completed` | Completed; 🟢 completion notification arrives in this session |

### Create a Commit in the Worktree

| # | Action | Expected |
|---|--------|----------|
| 4.4 | `WT=$MC_ROOT/mc-tmc-git` | Path set |
| 4.5 | `echo 'test' > $WT/mc-test-file.txt && git -C $WT add mc-test-file.txt && git -C $WT commit -m "test: add file"` | Commit created |
| 4.6 | `mc_diff` name=tmc-git | Shows mc-test-file.txt added, and nothing else: only what the job added since it forked from its base |
| 4.7 | `mc_diff` name=tmc-git, stat=true | Shows 1 file changed |

### Sync

| # | Action | Expected |
|---|--------|----------|
| 4.8 | `mc_sync` name=tmc-git, strategy=rebase, source=local | "Successfully synced … using rebase strategy." |
| 4.9 | `mc_sync` name=tmc-git, strategy=merge, source=local | "Successfully synced … using merge strategy." |

> Pass `source=local` explicitly: for a job with a recorded base branch (every job launched
> from a named branch), omitting `source` fetches and syncs against `origin/<base>`, which
> may not exist for a local branch.

### Merge

| # | Action | Expected |
|---|--------|----------|
| 4.10 | `mc_merge` name=tmc-git | "Successfully merged", Strategy: squash (config default) |
| 4.11 | Verify file exists: `cat mc-test-file.txt` | Contains 'test' |

### Cleanup (CRITICAL — revert merge, restore base branch)

| # | Action | Expected |
|---|--------|----------|
| 4.12 | `git reset --hard $PHASE4_SHA` (saved in step 4.1) | Merge reverted |
| 4.13 | `mc_cleanup` name=tmc-git, deleteBranch=true | Session, worktree and branch cleaned |
| 4.14 | `git status`; `git rev-parse HEAD` | Clean; SHA matches `$PHASE4_SHA` |
| 4.15 | `mc_jobs` | "No jobs found." |

---

## Phase 5 — Plan Orchestration

> Plan jobs launch through the same path as `mc_launch`: each is a session titled
> `[MC] <job>` in a worktree on branch `mc/plan/<first 8 chars of plan id>/<job>`.
> The integration branch is `mc/integration-<plan id>` with a worktree at
> `$MC_ROOT/mc-integration-<plan id>`.
>
> Root jobs start from the tip of the plan's base branch (the default branch unless
> `baseBranch` is given), **not** from the branch checked out in the main worktree. When
> testing from a feature branch, pass `baseBranch=$BASE_BRANCH` to `mc_plan` if the jobs must
> contain that branch's code.
>
> **Not verified live on 2.0**: copilot mode (5E), touchSet violations (5G), and retry /
> relaunch from `on_error`. Record every deviation carefully.

### 5A: Simple Plan (Autopilot)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.1 | Create 2-job plan | `mc_plan` name=tmc-plan-simple, mode=autopilot, jobs=[{name: "tmc-p1", prompt: `$LONG_PROMPT`}, {name: "tmc-p2", prompt: `$LONG_PROMPT`}] | `Plan "tmc-plan-simple" started.` |
| 5.2 | Plan status | `mc_plan_status` (within ~10s) | Plan `running`, both jobs `running` |
| 5.3 | Jobs visible | `mc_jobs`; session list; `git branch --list 'mc/plan/*'` | tmc-p1 and tmc-p2 running, two `[MC]` sessions, two plan-scoped branches |
| 5.4 | Integration branch | `git branch --list 'mc/integration-*'`; `git worktree list` | One integration branch and worktree |

### 5B: Plan with Dependencies

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.5 | Cancel current plan first | `mc_plan_cancel` | `Plan "tmc-plan-simple" canceled.` Plan job sessions, worktrees, branches and the integration branch are gone |
| 5.6 | Clear job records | `mc_cleanup` all=true, deleteBranch=true; `mc_jobs` | "No jobs found." |
| 5.7 | Create dependent plan | `mc_plan` name=tmc-plan-deps, mode=autopilot, jobs=[{name: "tmc-d1", prompt: `$LONG_PROMPT`}, {name: "tmc-d2", prompt: `$IDLE_PROMPT`, dependsOn: ["tmc-d1"]}] | Plan started |
| 5.8 | Verify dependency wait | `mc_plan_status` | tmc-d1=`running`, tmc-d2=`waiting_deps` |
| 5.9 | Only one session | `mc_jobs` | Only tmc-d1 exists as a job |
| 5.10 | Cancel | `mc_plan_cancel`; `mc_cleanup` all=true, deleteBranch=true | Cancelled and clean |

### 5C: Plan Validation Errors

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.11 | Circular dependency | `mc_plan` name=tmc-plan-circ, jobs=[{name: "tmc-a", prompt: "a", dependsOn: ["tmc-b"]}, {name: "tmc-b", prompt: "b", dependsOn: ["tmc-a"]}] | Error: "Plan contains circular dependencies" |
| 5.12 | Duplicate names | `mc_plan` name=tmc-plan-dup, jobs=[{name: "tmc-dup", prompt: "a"}, {name: "tmc-dup", prompt: "b"}] | Error: "Job names must be unique" |
| 5.13 | Unknown dependency | `mc_plan` name=tmc-plan-unk, jobs=[{name: "tmc-x", prompt: "x", dependsOn: ["nonexistent"]}] | Error: depends on unknown job |
| 5.14 | Removed per-job `mode` | `mc_plan` name=tmc-plan-mode, jobs=[{name: "tmc-m", prompt: "x", mode: "vanilla"}] | Rejected as an unknown field |
| 5.15 | No plan left behind | `mc_plan_status` | "No active plan." |

### 5D: Plan Cancel

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.16 | Launch plan then cancel | `mc_plan` name=tmc-plan-cancel, mode=autopilot, jobs=[{name: "tmc-c1", prompt: `$LONG_PROMPT`}, {name: "tmc-c2", prompt: `$LONG_PROMPT`}], then `mc_plan_cancel` | Jobs stopped; their sessions, worktrees and branches removed; `mc_plan_status` → "No active plan." |
| 5.17 | Cleanup | `mc_cleanup` all=true, deleteBranch=true | Cleaned |
| 5.18 | Cancel with no plan | `mc_plan_cancel` | "No active plan to cancel." |
| 5.19 | Second plan rejected while one is active | (during any active plan) `mc_plan` name=tmc-plan-second, jobs=[…] | Error: "Active plan already exists" |

### 5E: Plan Approve (Copilot)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.20 | Create copilot plan | `mc_plan` name=tmc-plan-copilot, mode=copilot, jobs=[{name: "tmc-cp1", prompt: `$LONG_PROMPT`}] | `created (pending approval)` |
| 5.21 | Plan status shows pending | `mc_plan_status`; `mc_jobs` | Plan `pending`; no job launched yet |
| 5.22 | Approve plan | `mc_plan_approve` | `approved and started` |
| 5.23 | Verify job launched | `mc_jobs` (within ~10s) | tmc-cp1 `running` with a session |
| 5.24 | Approve with nothing pending | `mc_plan_approve` | Error: "is not pending or paused" |
| 5.25 | Cancel and cleanup | `mc_plan_cancel`; `mc_cleanup` all=true, deleteBranch=true | Clean |
| 5.26 | Approve with no plan | `mc_plan_approve` | Error: "No active plan to approve" |

### 5F: Supervisor Mode (Checkpoint)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.27 | Create supervisor plan | `mc_plan` name=tmc-plan-super, mode=supervisor, jobs=[{name: "tmc-sv1", prompt: "Create sv1.txt containing the word super, then commit it."}] | Plan started |
| 5.28 | Wait for the job to complete | `mc_plan_status` until tmc-sv1 leaves `running` | Plan `paused`; tmc-sv1 `ready_to_merge` |
| 5.29 | Checkpoint recorded | `cat $STATE_DIR/plan.json` | `"status": "paused"`, `"checkpoint": "pre_merge"` |
| 5.30 | Toast | TUI | Warning toast titled "Checkpoint: pre_merge": `Plan "tmc-plan-super" is paused at the pre_merge checkpoint. Open the dashboard (/mc-dashboard) and press p to approve.` |
| 5.31 | Approve checkpoint | `mc_plan_approve` checkpoint=pre_merge | `Checkpoint "pre_merge" cleared.` |
| 5.32 | Merge happens, then pauses before PR | `mc_plan_status` (the merge train first runs the repo's `test` script in the integration worktree, installing dependencies if needed — allow for it) | tmc-sv1 `merged`; plan `paused` at `pre_pr` (**do not approve**). If the tests fail, the plan pauses at `on_error` instead — record the output |
| 5.33 | Nothing pushed | `git ls-remote --heads origin 'mc/integration-*'` | Empty |
| 5.34 | Cancel and cleanup | `mc_plan_cancel`; `mc_cleanup` all=true, deleteBranch=true | Clean |

### 5G: TouchSet Enforcement

TouchSet validation runs after a job completes but before it enters the merge train. If
violations are found, the plan pauses at an `on_error` checkpoint with `checkpointContext`
containing `failureKind`, `jobName`, `touchSetViolations`, and `touchSetPatterns`.

`$TS_PROMPT` = `"Create allowed.txt containing hello and rogue.txt containing oops. Commit both files."`

> If the agent does not produce the violation, create it by hand in the job's worktree
> (`echo oops > rogue.txt && git add rogue.txt && git commit -m "test: rogue"`) **while the job
> is still running**, before it reports completion.

#### 5G-1: Violation Detection

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.35 | Create plan with touchSet | `mc_plan` name=tmc-plan-touch, mode=supervisor, jobs=[{name: "tmc-ts1", prompt: `$TS_PROMPT`, touchSet: ["allowed.txt"]}] | Plan started |
| 5.36 | Wait for completion | `mc_plan_status` | Plan `paused`; tmc-ts1 `failed` with "Modified files outside touchSet: rogue.txt" |
| 5.37 | Notification | This session | `❌ Job "tmc-ts1" modified files outside its touchSet:` with the three options |
| 5.38 | Verify checkpoint context | `cat $STATE_DIR/plan.json` | `checkpoint` = `"on_error"`, `checkpointContext.failureKind` = `"touchset"`, `jobName` = `"tmc-ts1"`, `touchSetViolations` includes `"rogue.txt"`, `touchSetPatterns` = `["allowed.txt"]` |

#### 5G-2: Accept Path

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.39 | Accept violations | `mc_plan_approve` checkpoint=on_error | `TouchSet violations for job "tmc-ts1" accepted.` |
| 5.40 | Verify plan resumed | `mc_plan_status` | tmc-ts1 `ready_to_merge`, `merging` or `merged`; plan stops again at `pre_pr` at the latest |
| 5.41 | Cancel and cleanup | `mc_plan_cancel`; `mc_cleanup` all=true, deleteBranch=true | Clean |

#### 5G-3: Relaunch Path (Agent Correction)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.42 | Reproduce the violation | Repeat 5.35–5.36 with plan tmc-plan-relaunch, job tmc-rl1 | Paused at `on_error` |
| 5.43 | Record the old session | `mc_status` name=tmc-rl1 | Note the Session ID |
| 5.44 | Relaunch agent | `mc_plan_approve` checkpoint=on_error, relaunch=tmc-rl1 | `Job "tmc-rl1" relaunched with correction prompt.` |
| 5.45 | New session, same worktree | `mc_status` name=tmc-rl1 | `running`; a **different** Session ID; same worktree and branch |
| 5.46 | Verify correction prompt | `mc_capture` name=tmc-rl1, lines=50 | Transcript starts with "CORRECTION TASK — TouchSet Violation" listing rogue.txt |
| 5.47 | After completion | `mc_plan_status` | touchSet re-validated: job proceeds to merge (plan stops at `pre_pr`), or pauses again at `on_error` if rogue.txt is still there |
| 5.48 | Cancel and cleanup | `mc_plan_cancel`; `mc_cleanup` all=true, deleteBranch=true | Clean |

#### 5G-4: Retry Path (Manual Fix + Re-validation)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.49 | Reproduce the violation | Repeat 5.35–5.36 with plan tmc-plan-retry, job tmc-rt1 | Paused at `on_error` |
| 5.50 | Retry WITHOUT fixing | `mc_plan_approve` checkpoint=on_error, retry=tmc-rt1 | Error: "still has touchSet violations after manual fix" |
| 5.51 | Verify plan still paused | `mc_plan_status` | Still paused |
| 5.52 | Fix violation manually | In the job worktree: `git rm rogue.txt && git commit -m "test: remove rogue file"` | rogue.txt removed |
| 5.53 | Retry after fix | `mc_plan_approve` checkpoint=on_error, retry=tmc-rt1 | `Job "tmc-rt1" reset to ready_to_merge.` |
| 5.54 | Verify plan resumed | `mc_plan_status` | Job merges; plan stops at `pre_pr` |
| 5.55 | Cancel and cleanup | `mc_plan_cancel`; `mc_cleanup` all=true, deleteBranch=true | Clean |

#### 5G-5: Parameter Validation

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.60 | Both retry and relaunch | `mc_plan_approve` checkpoint=on_error, retry=tmc-x, relaunch=tmc-x | Error: Cannot specify both "retry" and "relaunch" |
| 5.61 | Relaunch on non-touchset failure | (If a plan is paused with a non-touchset failure) `mc_plan_approve` checkpoint=on_error, relaunch=jobname | Error: "was not failed due to a touchSet violation" |

### Phase 5 Cleanup

| # | Action | Verify |
|---|--------|--------|
| 5.62 | `mc_plan_cancel` (if still active) | Plan cancelled |
| 5.63 | `mc_cleanup` all=true, deleteBranch=true | All plan artifacts cleaned |
| 5.64 | `mc_jobs`; `mc_plan_status` | "No jobs found."; "No active plan." |
| 5.65 | `git branch --list 'mc/*'`; `git worktree list` | No plan or integration leftovers |

---

## Phase 6 — Realistic Multi-Job Scenario (Overlap & Conflicts)

This phase tests a workflow where several jobs touch related files. Jobs are launched with
`$IDLE_PROMPT` so the agents leave the worktrees untouched; we then create the commits by hand
to control timing and merge ordering. Wait for each job to show `completed` before committing.

All launches in this phase use `baseBranch=$BASE_BRANCH` (see the note in Phase 4).

### 6A: Setup

| # | Action | Expected |
|---|--------|----------|
| 6.1 | Record `$PHASE6_BASE_SHA` = `git rev-parse HEAD` | SHA saved |
| 6.2 | `printf 'line1: original\nline2: original\nline3: original\nline4: original\nline5: original\n' > shared-config.txt && git add shared-config.txt && git commit -m "test: add shared-config.txt for conflict testing"` | File committed |

### 6B: Launch 3 Jobs

| # | Test | Action | Expected |
|---|------|--------|----------|
| 6.3 | Launch | `mc_launch` tmc-docs, tmc-bugfix, tmc-feature (each `$IDLE_PROMPT`, baseBranch=`$BASE_BRANCH`) | Three jobs, three sessions |
| 6.4 | All complete | `mc_jobs` | All 3 `completed`; three 🟢 notifications |

### 6C: Controlled Commits

| # | Action | Expected |
|---|--------|----------|
| 6.5 | **Docs commit**: in `$MC_ROOT/mc-tmc-docs`, create `docs-note.md` and commit | No overlap |
| 6.6 | **Bugfix commit**: in `$MC_ROOT/mc-tmc-bugfix`, change `line2` of `shared-config.txt` to "bugfix-applied" and commit | Touches line2 |
| 6.7 | **Feature commit**: in `$MC_ROOT/mc-tmc-feature`, change `line4` of `shared-config.txt` to "cache-enabled" and commit | Touches line4 |

### 6D: Merge Ordering (Non-Conflicting Overlap)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 6.8 | Merge docs | `mc_merge` name=tmc-docs | Clean merge |
| 6.9 | Merge bugfix | `mc_merge` name=tmc-bugfix | Clean merge |
| 6.10 | Merge feature | `mc_merge` name=tmc-feature | Clean merge (different line) |
| 6.11 | Verify merged state | `cat shared-config.txt`; `ls docs-note.md` | line2=bugfix-applied, line4=cache-enabled, others original; docs-note.md present |

### 6E: Cleanup Non-Conflicting Test

| # | Action | Expected |
|---|--------|----------|
| 6.12 | `git reset --hard $PHASE6_BASE_SHA` | Back to pre-phase baseline |
| 6.13 | `mc_cleanup` all=true, deleteBranch=true; `mc_jobs` | Sessions, worktrees and branches gone; empty |

### 6F: Provoke a Merge Conflict

| # | Action | Expected |
|---|--------|----------|
| 6.14 | Re-create and commit shared-config.txt (as 6.2); record `$PHASE6_CONFLICT_SHA` | SHA saved |
| 6.15 | `mc_launch` tmc-conflict-a and tmc-conflict-b (`$IDLE_PROMPT`, baseBranch=`$BASE_BRANCH`); wait for `completed` | Two jobs |
| 6.16 | In conflict-a's worktree change `line2` to "version-A" and commit; in conflict-b's change `line2` to "version-B" and commit | Done |
| 6.17 | `mc_merge` name=tmc-conflict-a | Clean merge |
| 6.18 | `mc_merge` name=tmc-conflict-b | **FAILS** ("Squash merge failed") |
| 6.19 | Main worktree not corrupted | `git status`; `cat shared-config.txt` | Clean; line2="version-A" |

### 6G: Cleanup Conflict Test

| # | Action | Expected |
|---|--------|----------|
| 6.20 | `git reset --hard $PHASE6_BASE_SHA` | Back to pre-phase baseline (no shared-config.txt) |
| 6.21 | `mc_cleanup` all=true, deleteBranch=true; `mc_jobs` | Cleaned; empty |
| 6.22 | `ls shared-config.txt` | File not found |

### 6H: Plan-Based Dependency Chain

| # | Action | Expected |
|---|--------|----------|
| 6.23 | `mc_plan` name=tmc-plan-chain, mode=supervisor, jobs=[{name: "tmc-po-a", prompt: `$LONG_PROMPT`}, {name: "tmc-po-b", prompt: `$IDLE_PROMPT`, dependsOn: ["tmc-po-a"]}, {name: "tmc-po-c", prompt: `$IDLE_PROMPT`, dependsOn: ["tmc-po-b"]}] | Plan started, only tmc-po-a launches |
| 6.24 | `mc_plan_status` | a=`running`, b and c=`waiting_deps`, with `(deps: …)` shown |
| 6.25 | `mc_plan_cancel`; `mc_cleanup` all=true, deleteBranch=true | All artifacts cleaned |

---

## Phase 7 — Agent & Model Selection

Jobs take an optional `agent` and `model` (`provider/model` or `provider/model#variant`).
Model resolution for `mc_launch`: argument → `defaultModel` config → the launching session's
current model → the server's default model. Agent: argument → `defaultAgent` config → session
default. A job launched from the dashboard has no launching session (Phase 14E).

| # | Test | Action | Expected |
|---|------|--------|----------|
| 7.1 | Identify session model | Note the model this session uses | Record as `$CURRENT_MODEL` (`provider/model`) |
| 7.2 | Default model | `mc_launch` name=tmc-model-default, prompt=`$IDLE_PROMPT` | Launch output shows `Model: $CURRENT_MODEL` (omitted only if the session's model is not known yet) |
| 7.3 | Explicit model | `mc_launch` name=tmc-model-explicit, prompt=`$IDLE_PROMPT`, model=`<another provider/model you have access to>` | Launch output and `mc_status` show that model |
| 7.4 | Session really uses it | Open the job's session (`mc_attach`) | The session shows the requested model |
| 7.5 | Invalid model format | `mc_launch` name=tmc-model-bad, prompt=`$IDLE_PROMPT`, model="no-slash" | Error: `Invalid model "no-slash"`; no job, worktree or branch created |
| 7.6 | Explicit agent | `mc_launch` name=tmc-agent, prompt=`$IDLE_PROMPT`, agent=`<an agent that exists in this setup>` | Launch output, `mc_status` and `mc_jobs` show `Agent:` |
| 7.7 | `defaultModel` config | Set `"defaultModel": "<provider/model>"` in `$STATE_DIR/config.json`; `mc_launch` name=tmc-model-config, prompt=`$IDLE_PROMPT` | Job shows the configured model |
| 7.8 | Restore config | Remove `defaultModel` (delete `config.json` if it did not exist in Phase 0) | Config restored |
| 7.9 | Usage shown while running | `mc_launch` name=tmc-usage, prompt=`$LONG_PROMPT`; `mc_jobs`; `mc_status` name=tmc-usage | `Cost: $… \| Tokens: … in / … out` for the running job |
| 7.10 | Cleanup | `mc_kill` name=tmc-usage; `mc_cleanup` all=true, deleteBranch=true; `mc_jobs` | Empty |

---

## Phase 8 — mc_report, Blocked Jobs & mc_answer

Job agents call `mc_report` because every job prompt ends with reporting instructions
(`MC_REPORT_SUFFIX` in `src/lib/job-launcher.ts`). Job sessions get only `mc_report` and
`mc_status`, and no interactive `question` tool: a job that needs a decision reports `blocked`
and ends its turn. `mc_answer` delivers the reply as a new message and the job continues.

### 8A: Blocked → mc_answer Round Trip

`$ASK_PROMPT` = `"Before doing anything else you need a decision from the user: should the file be named alpha.txt or beta.txt? Ask by reporting blocked, then stop. When the answer arrives, create that file containing the word answered and commit it."`

| # | Test | Action | Expected |
|---|------|--------|----------|
| 8.1 | Launch | `mc_launch` name=tmc-ask, prompt=`$ASK_PROMPT` | Job launched |
| 8.2 | Job waits instead of completing | Wait ~30s; `mc_jobs` | tmc-ask is still `running` (a finished turn with a `blocked` report must not complete the job) |
| 8.3 | Report visible | `mc_status` name=tmc-ask | "Agent Report:" with `Status: blocked` and the question as Message |
| 8.4 | Notification | This session | `⚠️ Job 'tmc-ask' is blocked … Agent says: …`; warning toast; session title gains 🚧 |
| 8.5 | Overview alert | `mc_overview` | Alerts: `- tmc-ask [blocked]: …`; Suggested Actions mentions the blocked job |
| 8.6 | Report file | `cat $REPORTS_DIR/<job id>.json` | `{jobId, jobName: "tmc-ask", status: "blocked", message, timestamp}` |
| 8.7 | Answer | `mc_answer` name=tmc-ask, response="Use beta.txt" | `Answer sent to job "tmc-ask": "Use beta.txt"` |
| 8.8 | Job resumes | `mc_capture` name=tmc-ask; `cat $REPORTS_DIR/<job id>.json` | Transcript shows `> Use beta.txt`; report is no longer `blocked` |
| 8.9 | Job completes | `mc_jobs`; `ls $MC_ROOT/mc-tmc-ask/beta.txt`; `git -C $MC_ROOT/mc-tmc-ask log --oneline -1` | `completed`; beta.txt exists and is committed; 🟢 completion notification |
| 8.10 | Answer a finished job | `mc_answer` name=tmc-ask, response="x" | Error: "is not running (status: completed)" |
| 8.11 | Cleanup | `mc_cleanup` name=tmc-ask, deleteBranch=true | Cleaned |

### 8B: Normal Reporting

| # | Test | Action | Expected |
|---|------|--------|----------|
| 8.12 | Launch | `mc_launch` name=tmc-reporter, prompt="Create report-test.txt containing hello world." | Job launched |
| 8.13 | Reports appear | `ls $REPORTS_DIR` during the run | `<job id>.json`; status moves through `working` / `progress` |
| 8.14 | Completion | `mc_jobs`; report file | `completed`; final report `status: "completed"` |
| 8.15 | Auto-commit | `git -C $MC_ROOT/mc-tmc-reporter log --oneline -1` | A Conventional Commit made by the agent |
| 8.16 | Cleanup | `mc_cleanup` name=tmc-reporter, deleteBranch=true | Cleaned; the report file is removed too |

### 8C: Deterministic Report Injection

Synthetic reports exercise the monitor's reconcile pass (every 10 seconds). A report never
finishes a job by itself: it takes effect when the job's turn has ended. The agent's own
`mc_report` calls can overwrite an injected file; if that happens, inject again.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 8.17 | Launch | `mc_launch` name=tmc-inject, prompt=`$LONG_PROMPT` | Job launched |
| 8.18 | Get Job ID | `mc_status` name=tmc-inject | Note the `ID:` (UUID) |
| 8.19 | Inject `needs_review` | Write `$REPORTS_DIR/<UUID>.json`: `{"jobId": "<UUID>", "jobName": "tmc-inject", "status": "needs_review", "message": "Synthetic review test", "timestamp": "<now ISO>"}` | File written |
| 8.20 | Wait 15 seconds | `mc_status` name=tmc-inject | Reconcile pass ran; the job is still `running` (its turn has not ended) and the injected report is shown |
| 8.21 | Job completed once its turn ends | Wait for the job to stop working (inject again if it overwrote the report; it is asked once to commit `notes.txt` first); `mc_status` name=tmc-inject | Status `completed` |
| 8.22 | Notification | This session | `👀 Job 'tmc-inject' needs review … Reviewer note: Synthetic review test` |
| 8.23 | Overview | `mc_overview` | Alerts: `- tmc-inject [needs_review]: Synthetic review test`; Suggested Actions: `1 job(s) need review - run mc_diff on completed work` |
| 8.24 | Cleanup | `mc_cleanup` name=tmc-inject, deleteBranch=true (add force=true if it reports uncommitted changes) | Cleaned |

---

## Phase 9 — mc_overview Dashboard

| # | Test | Action | Expected |
|---|------|--------|----------|
| 9.1 | Overview with no jobs | `mc_overview` | Active Plan: None; `0 running, 0 completed, 0 failed`; Suggested Actions: "No active work - run mc_launch to start a new job" |
| 9.2 | Launch 2 jobs | `mc_launch` tmc-dash-1 and tmc-dash-2 with `$LONG_PROMPT` | Both launched |
| 9.3 | Overview with running jobs | `mc_overview` | Running Jobs lines: `- <name> \| <activity> \| <time> \| <branch> \| … \| last report: …`, including `model:` and usage when available |
| 9.4 | Kill one job | `mc_kill` name=tmc-dash-1; `mc_overview` | Summary shows `1 running, … , 1 stopped` |
| 9.5 | Kill second job | `mc_kill` name=tmc-dash-2; `mc_overview` | `0 running, …, 2 stopped` |
| 9.6 | Cleanup prior jobs | `mc_cleanup` all=true, deleteBranch=true | Cleaned |
| 9.7 | Overview with plan | `mc_plan` name=tmc-plan-dash, mode=supervisor, jobs=[{name: "tmc-pd1", prompt: `$LONG_PROMPT`}]; `mc_overview` | Active Plan shows Name, Status, Progress `0/1 merged`, Mode |
| 9.8 | Cancel plan | `mc_plan_cancel`; `mc_overview` | Active Plan: None |
| 9.9 | Cleanup | `mc_cleanup` all=true, deleteBranch=true; `mc_jobs` | Empty |

---

## Phase 10 — mc_attach: Opening a Job's Session

| # | Test | Action | Expected |
|---|------|--------|----------|
| 10.1 | Launch | `mc_launch` name=tmc-attach, prompt=`$LONG_PROMPT` | Job launched; note the Session ID |
| 10.2 | Instructions | `mc_attach` name=tmc-attach | Session ID matches 10.1; worktree path; title `[MC] tmc-attach`; shell command |
| 10.3 | Slash command | `/mc-attach tmc-attach` | Same content, shown in a dialog titled `/mc-attach` (no AI roundtrip, nothing added to the session); the job's session is opened as in 10.2 |
| 10.4 | Slash command without a name | `/mc-attach` | A dialog with "No job name provided." followed by the job list |
| 10.5 | Open from the TUI | Open the session list and pick `[MC] tmc-attach` | The job's live transcript; its working directory is the job worktree |
| 10.6 | Open from a shell | Run the printed `cd <worktree> && opencode --session <id>` in another terminal | Same session opens |
| 10.7 | Job session is restricted | In the job session, inspect the available tools | Of the `mc_*` tools only `mc_report` and `mc_status`; no `question` tool |
| 10.8 | Return and clean up | Back in the main session: `mc_kill` name=tmc-attach; `mc_cleanup` name=tmc-attach, deleteBranch=true | Cleaned; the session disappears from the list |

---

## Phase 11 — Monitor, Notifications & Hooks (Observational)

Observed while running the other phases, plus two direct checks.

| # | Test | How to Observe | Expected |
|---|------|----------------|----------|
| 11.1 | Completion detected from events | Any job with `$IDLE_PROMPT` | `completed` shortly after the turn ends, without waiting for a poll |
| 11.2 | Completion notification | After 11.1 | `🟢 Job '<name>' completed in …` in the **launching** session; success toast; title gains ✅ |
| 11.3 | Title prefix and reset | Use any `mc_*` tool, then send a prompt | Session title is prefixed `[MC]`; the ✅ marker is removed on the next prompt or tool call |
| 11.4 | launchSessionID routing | `cat $STATE_DIR/jobs.json` after a launch | Job has `launchSessionID` equal to this session's ID |
| 11.5 | Failure detected | Launch with `$LONG_PROMPT`, open the job session (Phase 10) and interrupt it there | Job becomes `failed`; `🔴 Job '<name>' failed …`; error toast; title gains ❌ |
| 11.6 | `mc_kill` is not a failure | `mc_kill` a running job | Job is `stopped`, no 🔴 notification |
| 11.7 | Reconcile after reload | Launch with `$IDLE_PROMPT`, reload OpenCode immediately, wait 15s | Job ends up `completed` even if the event was missed |
| 11.8 | Auto-status toast | Finish a turn in this session while a job is running | Toast "📊 Mission Control Status" listing running jobs (at most once per 5 minutes) |
| 11.9 | Compaction context | When OpenCode compacts context during testing | Current job state is injected into the context |
| 11.10 | Shared-server cwd | Start OpenCode's server from a directory **outside** the project, then run `/mc-jobs` | Jobs of this project are listed (in a dialog); state is read from `$STATE_DIR` |
| 11.11 | Cleanup | `mc_cleanup` all=true, deleteBranch=true | Clean |

---

## Phase 12 — Upgrade Migration (State Version 4)

Simulates a `jobs.json` written by 1.x. Requires an empty job list (`mc_jobs` → "No jobs found.").

| # | Test | Action | Expected |
|---|------|--------|----------|
| 12.1 | Create a stand-in worktree | `git worktree add -b mc/tmc-legacy $MC_ROOT/mc-tmc-legacy` | Worktree created |
| 12.2 | Write a version 3 state file | Write `$STATE_DIR/jobs.json`: `{"version": 3, "updatedAt": "2026-01-01T00:00:00.000Z", "jobs": [{"id": "tmc-legacy-id", "name": "tmc-legacy", "worktreePath": "<absolute $MC_ROOT>/mc-tmc-legacy", "branch": "mc/tmc-legacy", "status": "running", "prompt": "legacy job", "createdAt": "2026-01-01T00:00:00.000Z", "tmuxTarget": "mc-tmc-legacy", "placement": "session", "mode": "vanilla", "port": 14100}]}` | File written |
| 12.3 | Running job becomes stopped | `mc_jobs` | tmc-legacy listed as `stopped`, no `Session:` line |
| 12.4 | No session to open | `mc_attach` name=tmc-legacy | "has no session to open (it was launched by an older version of Mission Control)" plus the worktree path |
| 12.5 | No session to capture | `mc_capture` name=tmc-legacy | Error: "has no session to capture" |
| 12.6 | Only cleanup is possible | `mc_cleanup` name=tmc-legacy, deleteBranch=true | Cleaned; worktree and branch removed |
| 12.7 | State rewritten | `cat $STATE_DIR/jobs.json` | `"version": 4`, empty `jobs`, no legacy fields |

### 12B: Legacy Config Keys

| # | Test | Action | Expected |
|---|------|--------|----------|
| 12.8 | Add removed keys | Put `"defaultPlacement": "session", "useServeMode": true, "idleThreshold": 300000, "omo": {"enabled": true}` into `$STATE_DIR/config.json` | Saved |
| 12.9 | Config still loads | `mc_launch` name=tmc-legacy-config, prompt=`$IDLE_PROMPT` | Launches normally; no config error |
| 12.10 | Restore | Restore `config.json` to its Phase 0 content (delete it if it was absent); `mc_cleanup` all=true, deleteBranch=true | Clean |

---

## Phase 13 — Permission Policy

The monitor answers permission requests raised by job sessions from the permission policy:
`auto-approve`, `deny`, or `ask-user` (never approved by Mission Control: relayed to the
launching session and to the TUI, and denied after 2 minutes if unanswered). Policy evaluation
is covered by unit tests (`tests/lib/permission-policy.test.ts`, `tests/lib/question-relay.test.ts`,
`tests/lib/monitor.test.ts`). Live permission
prompts depend on the agent and the OpenCode permission settings, so the live check is
observational.

> **Not verified live on 2.0** (permission prompts).

### 13A: Default Policy (from `PermissionPolicy.getDefaultPolicy()`)

| # | Check | Expected |
|---|-------|----------|
| 13.1 | `permissions.fileEdit` | inside `"auto-approve"`, outside `"deny"` |
| 13.2 | `permissions.shellCommand` | inside `"auto-approve"`, outside `"ask-user"` (only `inside` applies to requests from job sessions) |
| 13.3 | `permissions.networkAccess` | `"deny"` |
| 13.4 | `permissions.installPackages` | `"ask-user"` |
| 13.5 | `permissions.mcpTools` | `"auto-approve"` |

### 13B: Custom Policy Override

| # | Test | Action | Expected |
|---|------|--------|----------|
| 13.6 | Invalid policy rejected | Set `"defaultPermissionPolicy": {"permissions": {"fileEdit": "yes"}}` in `$STATE_DIR/config.json`; run `mc_launch` name=tmc-badpolicy, prompt=`$IDLE_PROMPT` | Error: `Invalid config in …/config.json` |
| 13.7 | Valid override accepted | Replace with a complete policy where every value is `"deny"`; `mc_launch` name=tmc-policy, prompt=`$IDLE_PROMPT` | Launches |
| 13.8 | Restore | Remove `defaultPermissionPolicy` (restore Phase 0 config); `mc_cleanup` all=true, deleteBranch=true | Clean |

### 13C: Live Relay (Observational)

| # | Test | How to Observe | Expected |
|---|------|----------------|----------|
| 13.9 | Request inside the worktree | A job that edits files while OpenCode is set to ask for edit permission | Approved automatically; the job does not stall |
| 13.10 | Unanswered request keeps the job open | A job waiting on an `ask-user` request (for example a package install under the default policy, with OpenCode set to ask for shell permission) | Job stays `running`; `🔔 Job "<name>" needs your attention:` message in the launching session; a toast `Job "<name>" needs permission` in the TUI |
| 13.11 | Unanswered request is denied | Leave 13.10 unanswered for 2 minutes | The request is denied (not approved); the job continues without it or reports `blocked` |
| 13.12 | Dashboard-launched job | Repeat 13.10 with a job launched from the dashboard (`n`) | Same toast in the TUI, and the same denial after 2 minutes, although there is no launching session |

---

## Phase 13D — Safeguards Added Before the 2.0 Release

> **Not verified live on 2.0.** Each of these is covered by unit tests; the live behaviour
> depends on how the OpenCode server reports sessions, permissions and events.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 13.13 | Invalid job name | `mc_launch` name=`"tmc bad name"`, prompt=`$IDLE_PROMPT` | Error: `Invalid job name`; no worktree, branch or session |
| 13.14 | Uncommitted work is asked about once | `mc_launch` name=tmc-dirty, prompt=`"Create scratch.txt containing hello. Do not commit anything, even if asked later."` | When its first turn ends the job gets one message asking it to commit, and stays `running` |
| 13.15 | Still dirty: completed, flagged | Wait for tmc-dirty to stop again | Status `completed`; `👀 Job 'tmc-dirty' needs review … uncommitted file(s) …: scratch.txt`; the dashboard shows it under ⚠ with the note |
| 13.16 | Cleanup protects the work | `mc_cleanup` name=tmc-dirty, deleteBranch=true | Error: `uncommitted changes that would be lost: scratch.txt`; worktree, session and job are still there |
| 13.17 | Forced cleanup | `mc_cleanup` name=tmc-dirty, deleteBranch=true, force=true | Cleaned |
| 13.18 | Cleanup leaves plan jobs alone | During a paused plan (for example at 5.x `pre_merge`): `mc_cleanup` all=true, deleteBranch=true | Plan jobs are listed under `Skipped:` with the plan's name; their worktrees and branches still exist |
| 13.19 | Deleted session | Launch tmc-gone with `$LONG_PROMPT`; delete the session `[MC] tmc-gone` in the session list | Within ~10 seconds the job is `failed`; the notification says its session was deleted |
| 13.20 | Restart resumes a job | Launch tmc-restart with `$LONG_PROMPT`; `opencode service restart`; wait ~15 seconds | The job is still `running` and its session received `The server restarted while you were working. Continue your task from where you left off.` exactly once |
| 13.21 | Reload keeps one orchestrator | With a running plan, run `/reload` twice; watch `mc_plan_status` | Each job is launched once and merged once; no duplicate `Launched` / `Merging` notifications |
| 13.22 | Failed plan job pauses the plan | In a running plan, `mc_kill` one of its running jobs | The plan pauses at `on_error` naming the job (`the job was stopped`); `mc_plan_approve` checkpoint=on_error, retry=<job> continues |
| 13.23 | Slash command without a TUI | From a client without the TUI part (web or desktop), run `/mc-jobs` | The output is added to the session as a message; no turn starts |
| 13.24 | Cleanup | `mc_kill` the remaining jobs; `mc_cleanup` all=true, deleteBranch=true, force=true | Clean |

---

## Phase 14 — Terminal UI

The TUI part (`src/tui.tsx`, `src/tui/`) is loaded by the same `plugins` entry as the server
part. It adds a footer indicator, a sidebar section, the dashboard, dialogs and notifications.

> **Verified live on OpenCode 2.3.0 (macOS)**: footer, sidebar, the dashboard's launch /
> transcript / cleanup, and click-to-open. **Not verified live**: the dashboard's answer (`a`),
> stop (`x`), approve (`p`) and cancel (`c`) keys, and system notifications (14H).

Run this phase from a session in the main worktree, starting with no jobs and no plan.
`$ASK_PROMPT` is defined in Phase 8A.

### 14A: Loading and Empty State

| # | Test | Action | Expected |
|---|------|--------|----------|
| 14.1 | TUI part loads | Start the TUI with only the single `plugins` entry; type `/mc-d` in the prompt | No plugin load error; `/mc-dashboard` is offered. If it is missing because the plugin was added while OpenCode was already running, run `opencode service restart` and retry |
| 14.2 | Nothing shown without jobs | Look at the footer and the sidebar | No `MC` indicator; no **Mission Control** sidebar section |
| 14.3 | Empty dashboard | `/mc-dashboard` | Dashboard opens with "No jobs yet. Press n to launch one." and the key hint line at the bottom. Close it with `esc` |

### 14B: Footer Indicator

| # | Test | Action | Expected |
|---|------|--------|----------|
| 14.4 | Running count | `mc_launch` name=tmc-tui-run, prompt=`$LONG_PROMPT` | Footer shows `MC ▶1` shortly after the launch, without reloading |
| 14.5 | Attention count | `mc_launch` name=tmc-tui-ask, prompt=`$ASK_PROMPT`; wait until it reports blocked | Footer shows `MC ▶1 ⚠1`: the blocked job is counted under `⚠` only, not under `▶` |
| 14.6 | Home screen | Go to the home screen | The same indicator is in the home footer |
| 14.7 | Click opens the dashboard | Click the indicator | The dashboard opens (full page on the home screen, side panel inside a session). Close it |

Later steps change the counts: `✓` completed, `✗` failed, `■` stopped. A count of zero is not shown.

### 14C: Sidebar

| # | Test | Action | Expected |
|---|------|--------|----------|
| 14.8 | Section content | Open the sidebar in the main session | A **Mission Control** section with one row per job: `▶ tmc-tui-run` followed by its current tool and file (or latest report), and `⚠ tmc-tui-ask` followed by the agent's question |
| 14.9 | Click the title | Click **Mission Control** | The dashboard opens. Close it |
| 14.10 | Click a job row | Click the `tmc-tui-run` row | The job's session opens: in a tab when tabs are enabled, otherwise the TUI navigates to it |
| 14.11 | Jobs visible inside the job's session | Look at the footer and sidebar while the job's session is shown | Same indicator and same job rows as in the main session |
| 14.12 | Jobs stay visible after returning | Go back to the main session (its tab, or the session list) | Footer indicator and sidebar rows are still there and current; the job list has not disappeared |
| 14.13 | `mc_attach` opens the session | `mc_attach` name=tmc-tui-run | The job's session is opened the same way as in 14.10. Return to the main session; the jobs are still listed |

With more than six jobs the sidebar lists six (running first, then jobs needing attention, then
finished ones) and ends with `+N more`. Check it whenever a phase happens to have that many jobs.

### 14D: Opening the Dashboard

| # | Test | Action | Expected |
|---|------|--------|----------|
| 14.14 | Slash command | In the main session: `/mc-dashboard` | The dashboard opens as a side panel of the session and has keyboard focus. It lists both jobs; the first is marked `›` and its details (Status, Branch, Worktree, Session, Model if set, Report, Activity) are shown below the list. `esc` closes it |
| 14.15 | Command palette | Open the command palette and run **Mission Control: Open dashboard** | Same panel. `q` closes it |
| 14.16 | Default keybinding | Press `<leader>j` | Same panel. Close it |
| 14.17 | Outside a session | From the home screen, open the dashboard any of the three ways | The dashboard opens as a full page; `esc` or `q` returns to the home screen |

### 14E: Dashboard Keys

Open the dashboard in the main session. Jobs at this point: `tmc-tui-run` (running) and
`tmc-tui-ask` (blocked). Every action reports its result as a toast: the first line of the
tool's output on success, the error message on failure.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 14.18 | Select with the keyboard | `↓`, `↑`, then `j`, `k` | The `›` marker and the highlighted row move; the details below follow the selection; the selection stops at the first and last row |
| 14.19 | Select with the mouse | Click the other job's row | That row becomes selected |
| 14.20 | Refresh | `r` | The list is refetched; nothing else changes |
| 14.21 | Transcript | Select tmc-tui-run, press `t` | A large dialog titled `Transcript of "tmc-tui-run"` with the end of the transcript (up to 200 lines) and the hint `↑↓ scroll · esc close`. `↑` / `↓` scroll; `esc` closes it and the dashboard is still open |
| 14.22 | Open the session | Select tmc-tui-run, press `enter` | The job's session opens as in 14.10. Return to the main session and reopen the dashboard: both jobs are still listed |
| 14.23 | Answer: cancel | Select tmc-tui-ask, press `a`; press `esc`. Press `a` again and submit an empty message | A prompt titled `Message for job "tmc-tui-ask"` whose description is the agent's question. Neither attempt sends anything; the job stays blocked |
| 14.24 | Answer a blocked job | `a`, type `Use beta.txt`, submit | Toast `Answer sent to job "tmc-tui-ask": "Use beta.txt"`. The job resumes as in 8.8: once the agent reports again its row changes from `⚠ blocked` to `▶ running`, then `✓ completed`; footer counts follow |
| 14.25 | Answer a finished job | Select tmc-tui-ask (completed), press `a` | Warning toast `Job "tmc-tui-ask" is not running.`; no prompt |
| 14.26 | Launch: invalid name | `n`, type `bad name!`, submit | First prompt is titled `Launch job: name`. Error toast "Use letters, digits, dots, dashes and underscores only."; no job is launched |
| 14.27 | Launch | `n`, name `tmc-tui-new`, then in the prompt titled `Launch job "tmc-tui-new": task` enter `$IDLE_PROMPT` | Toast `Job "tmc-tui-new" launched successfully.`; the job appears in the list. In `$STATE_DIR/jobs.json` it has no `launchSessionID`; its `model` is the configured `defaultModel`, or else the model most recently used by a session on the server, or else the server's default model. Its completion notification arrives in the active session |
| 14.28 | Launch: cancel | `n`, then `esc` at the name prompt; `n`, a valid name, then `esc` at the task prompt | Nothing is launched either time |
| 14.29 | Clean up refused while running | Select tmc-tui-run, press `d` | Warning toast `Job "tmc-tui-run" is still running. Stop it first (x).`; no dialog |
| 14.30 | Stop: cancel | Select tmc-tui-run, press `x`, choose **Cancel** | Dialog `Stop job "tmc-tui-run"?` ("Its session is interrupted. The worktree and branch are kept.") with **Stop job** / **Cancel**. The job keeps running |
| 14.31 | Stop | `x`, choose **Stop job** | Toast `Job "tmc-tui-run" stopped successfully.`; the row shows `■ stopped`; the footer shows `■1` |
| 14.32 | Stop a stopped job | `x` again | Warning toast `Job "tmc-tui-run" is not running.`; no dialog |
| 14.33 | Clean up: cancel | `d`, choose **Cancel** | Dialog `Clean up job "tmc-tui-run"?` ("Removes its worktree and session. The branch mc/tmc-tui-run is kept.") with **Clean up** / **Cancel**. Nothing is removed |
| 14.34 | Clean up | `d`, choose **Clean up** | Success toast with the first line of the cleanup output; the row disappears; the worktree and the `[MC] tmc-tui-run` session are gone; `git branch --list mc/tmc-tui-run` still shows the branch |
| 14.35 | Plan keys without a plan | `p`, then `c` | Warning toast "There is no plan." each time |
| 14.36 | Close | `esc`; reopen; `q` | The dashboard closes both ways |

### 14F: Plan in the TUI

| # | Test | Action | Expected |
|---|------|--------|----------|
| 14.37 | Plan section | `mc_plan` name=tmc-plan-tui, mode=supervisor, jobs=[{name: "tmc-tp1", prompt: "Create tp1.txt containing the word tui, then commit it."}, {name: "tmc-tp2", prompt: `$IDLE_PROMPT`, dependsOn: ["tmc-tp1"]}]; open the dashboard | Above the jobs: `Plan tmc-plan-tui [supervisor] running · 0/2 merged`, then one line per plan job with icon and status; the tmc-tp2 line ends with `← tmc-tp1` |
| 14.38 | Sidebar plan line | Look at the sidebar | `tmc-plan-tui · running · 0/2 merged` under the title |
| 14.39 | Nothing to approve | Press `p` while the plan is running with no checkpoint | Warning toast `Plan "tmc-plan-tui" has nothing to approve.` |
| 14.40 | Checkpoint shown | Wait for tmc-tp1 to complete | Warning toast titled `Checkpoint: pre_merge` ending in "Open the dashboard (/mc-dashboard) and press p to approve."; the plan section shows `⚠ Checkpoint pre_merge: Waiting for approval before merging (p to approve)`; the sidebar plan line reads `tmc-plan-tui · checkpoint pre_merge · 0/2 merged` |
| 14.41 | Approve: cancel | `p`, choose **Cancel** | Dialog `Approve checkpoint pre_merge?` with **Approve** / **Cancel**. The plan stays paused |
| 14.42 | Approve | `p`, choose **Approve** | Toast starting `Checkpoint "pre_merge" cleared.`; the checkpoint line disappears and the merge proceeds as in 5.32 |
| 14.43 | Cancel plan: keep | `c`, choose **Keep running** | Dialog `Cancel plan "tmc-plan-tui"?` ("All of its running jobs are stopped.") with **Cancel plan** / **Keep running**. The plan continues |
| 14.44 | Cancel plan | `c`, choose **Cancel plan** — never approve `pre_pr`; cancel instead | Toast `Plan "tmc-plan-tui" canceled.`; the plan section and the sidebar plan line disappear |

### 14G: Slash-Command Output Dialogs

Output of the direct slash commands is shown in a dialog and is **not** added to the session.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 14.45 | `/mc` | Run `/mc` | A dialog titled `/mc` with the `mc_overview` text; `esc` closes it. No new message appears in the session transcript |
| 14.46 | `/mc-jobs` | Run `/mc-jobs` | A dialog titled `/mc-jobs` with the job list; nothing added to the session |
| 14.47 | Command with a name | `/mc-status tmc-tui-new` | A dialog titled `/mc-status` with the job's status |
| 14.48 | Command without a name | `/mc-status` | A dialog with "No job name provided. Here are your current jobs:" and the job list |
| 14.49 | Error output | `/mc-status doesnt-exist` | A dialog titled `/mc-status` whose text starts with `Error:` and says the job was not found |
| 14.50 | Not sent to the agent | After 14.45–14.49, send the prompt "What was the last thing I showed you?" | The agent does not know about the command output |

### 14H: Notifications

| # | Test | Action | Expected |
|---|------|--------|----------|
| 14.51 | Completion toast | Run any job to completion (14.27 does) | Success toast titled `Job "<name>" completed` |
| 14.52 | Blocked toast | 14.5 | Warning toast titled `Job "tmc-tui-ask" is blocked` with the agent's question followed by "Open the dashboard (/mc-dashboard) and press a to answer."; it stays up about 10 seconds |
| 14.53 | Plan toast | 14.37 | Toast `Plan "tmc-plan-tui" started.` |
| 14.54 | System notification when unfocused | Launch a job with `$IDLE_PROMPT`, then put the terminal in the background until it completes | A system notification and a sound, subject to OpenCode's own attention settings. **Not verified live** |
| 14.55 | No system notification when focused | Repeat 14.54 with the terminal focused | Only the toast |

### Phase 14 Cleanup

| # | Action | Verify |
|---|--------|--------|
| 14.56 | `mc_plan_cancel` (if still active); `mc_kill` any running `tmc-tui-*` job; `mc_cleanup` all=true, deleteBranch=true | Clean |
| 14.57 | `git branch -D mc/tmc-tui-run` (kept by 14.34) | Branch deleted; `git branch --list 'mc/tmc-*'` is empty |
| 14.58 | Footer and sidebar | No `MC` indicator and no **Mission Control** section once `mc_jobs` reports "No jobs found." |

---

## Final Phase — Verification & Nuclear Cleanup

> **Run this LAST** — after all other phases.

This ensures we leave the repo in **exactly** the same state we found it.

| # | Action | Verify |
|---|--------|--------|
| F.1 | `mc_plan_cancel` (if a plan is active); `mc_kill` any running `tmc-*` job; `mc_cleanup` all=true, deleteBranch=true | Tools report clean |
| F.2 | Run the Nuclear Cleanup script | Completes |
| F.3 | Delete leftover `[MC] tmc-*` sessions from the session list | None remain |
| F.4 | Restore `$STATE_DIR/config.json` to its Phase 0 content | Matches |

### Verify against the pre-test snapshot

| Artifact | Command | Must Match Baseline |
|----------|---------|---------------------|
| git branches (mc/*) | `git branch --list 'mc/*'` | Empty |
| git worktrees | `git worktree list` | Only main worktree |
| working tree | `git status` | clean (except this test plan file if modified) |
| current branch | `git rev-parse --abbrev-ref HEAD` | `$BASE_BRANCH` |
| HEAD SHA | `git rev-parse HEAD` | Matches `$INITIAL_SHA` |
| jobs.json | `cat $STATE_DIR/jobs.json` | Empty jobs array or absent |
| plan.json | `ls $STATE_DIR/plan.json` | Absent |
| reports | `ls $REPORTS_DIR` | Empty |
| MC sessions | Session list | No `[MC] tmc-*` |
| remote | `git ls-remote --heads origin 'mc/*'` | Nothing pushed by the tests |

| # | Test | Action | Expected |
|---|------|--------|----------|
| F.5 | Final overview | `mc_overview` | No jobs, no plan |

---

## Results Tracking

| Phase | Description | Pass | Fail | Blocked | Notes |
|-------|-------------|------|------|---------|-------|
| 0 | Pre-test state snapshot & cleanup | | | | |
| 1 | Single job lifecycle | | | | |
| 2 | Error handling & edge cases | | | | |
| 3 | Multiple jobs | | | | |
| 4 | Git workflow (sync & merge) | | | | |
| 5 | Plan orchestration | | | | Copilot, touchSet, retry/relaunch not verified live on 2.0 |
| 6 | Realistic multi-job (overlap/conflict) | | | | |
| 7 | Agent & model selection | | | | |
| 8 | mc_report, blocked jobs & mc_answer | | | | |
| 9 | mc_overview dashboard | | | | |
| 10 | mc_attach: opening a job's session | | | | |
| 11 | Monitor, notifications & hooks | | | | |
| 12 | Upgrade migration (state v4, legacy config) | | | | Simulated state file; a real 1.x upgrade is not verified live |
| 13 | Permission policy | | | | Permission prompts not verified live on 2.0 |
| 14 | Terminal UI | | | | Answer / stop / approve / cancel keys and system notifications not verified live |
| Final | Verification & nuclear cleanup | | | | Run LAST |

---

## Known Issues to Watch For

None recorded against the current source. Two earlier entries no longer apply:

- `mc_cleanup` after `mc_plan_cancel` tolerates a worktree that is already gone (`removeWorktreeWithFallback` in `src/tools/cleanup.ts` prunes git's stale record of it).
- A failed post-create command removes the worktree and the branch it created (`createWorktree` in `src/lib/worktree.ts`).

---

## Key Risks

1. **Dogfooding paradox**: We're testing Mission Control from within a session that has Mission Control loaded. Launching jobs creates worktrees of this repo, and the job sessions load the plugin too — in job-agent mode, with only `mc_report` and `mc_status`.
2. **Merge pollution (Phases 4 & 6)**: The merge tests temporarily bring test commits into the base branch. We immediately `git reset --hard $SAVED_SHA` to undo. These are the highest-risk steps. **NEVER use `HEAD~N`** — always use saved SHAs. `mc_merge` refuses to run on a dirty main worktree, so commit or stash unrelated work first.
3. **State file corruption**: If we crash mid-test, `jobs.json` and `plan.json` may have orphaned entries. The Nuclear Cleanup script handles this.
4. **Session leak**: Deleting `jobs.json` (or a worktree) by hand does not delete the job's OpenCode session. Always prefer `mc_cleanup`, and remove leftover `[MC] tmc-*` sessions from the session list.
5. **Integration branch leak**: Plan tests create `mc/integration-<plan id>` branches and `mc-integration-<plan id>` worktrees. Both are cleaned by `mc_plan_cancel` and by the Nuclear Cleanup script.
6. **Plan auto-push**: If all jobs in an autopilot plan reach `merged`, the plan pushes the integration branch to the remote and creates a PR. **ALWAYS cancel plans before all jobs complete**, and use `supervisor` mode whenever jobs are allowed to finish.
7. **Agent non-determinism**: Agents are instructed to call `mc_report` and to commit, but behavior is not guaranteed. A missing report or commit warrants investigation but is not necessarily a plugin failure. Phases 5G and 8A depend on the agent following the prompt; the notes there give a manual fallback.
8. **Cost**: Every test job is a real model session. `$LONG_PROMPT` jobs keep spending until they are killed — kill them as soon as the step is verified.
9. **TouchSet testing on feature branches**: TouchSet validation compares the job branch against the integration branch. Root plan jobs and the integration branch both start from the tip of the plan's base branch (the default branch unless `baseBranch` is given) when the plan is created, not from the branch checked out in the main worktree.
10. **Permission non-determinism**: Live permission requests depend on the agent triggering them and on the OpenCode permission configuration. Unit tests are the source of truth for policy evaluation.
11. **Unanswered `ask-user` requests are approved after 2 minutes**: keep this in mind when a test job is left waiting on a permission request.

---

## Agent Capabilities Reference

A session that runs inside a managed worktree is detected as a **job agent**
(`isInManagedWorktree` in `src/lib/worktree.ts`, wired in `src/index.ts`). The `.opencode/`
directory is automatically symlinked into every worktree (`BUILTIN_SYMLINKS` in
`src/lib/worktree-setup.ts`).

| Capability | Available? | Why |
|------------|------------|-----|
| `mc_report` | **YES** | Registered for job agents |
| `mc_status` | **YES** | Registered for job agents |
| Other `mc_*` tools (`mc_launch`, `mc_kill`, `mc_merge`, `mc_plan_*`, …) | **NO** | Not registered inside managed worktrees |
| `/mc-*` slash commands | **NO** | Not registered inside managed worktrees |
| Interactive `question` tool | **NO** | Removed from job sessions; jobs report `blocked` instead |
| Standard OpenCode tools | **YES** | Read, write, shell, search, etc. |
| Git operations | **YES** | Full git access within the worktree |
| Plan awareness | **NO** | Plan context is not part of the job prompt |
| Job monitor | **NO** | The monitor only runs in the command-center instance |
| Permission policy | **PASSIVE** | The monitor answers the job's permission requests from the policy; the agent does not see or control it |

### Monitor Mechanisms

| Mechanism | How It Detects | Resulting State |
|-----------|---------------|-----------------|
| Event stream | One subscription to the server's event stream; events are routed to the running job with the same session ID | Real-time updates |
| Turn finished (`session.execution.succeeded`, idle) | Job has no pending question, no unanswered permission, its last report is not `blocked`, no background work of its own is running (unless it reported `completed`), and its worktree has no uncommitted changes it was not yet asked about | `running` → `completed` (flagged for review if uncommitted changes remain) |
| Turn finished while waiting | Pending question or unanswered permission → `awaiting_input` notification; `blocked` report → `blocked` notification | stays `running` |
| `session.execution.failed` / `.interrupted` / `session.deleted` | Session execution failed, was interrupted by the user or by inactivity, or the session was deleted | `running` → `failed` (unless `mc_kill` already marked it `stopped`). An interruption with reason `superseded` is ignored; one with reason `shutdown` is not a failure — the job is told once to continue after the restart |
| Reconcile (start, then every 10 seconds) | Session's recorded outcome and the `mc_report` file | `completed` / `failed`; a `completed` or `needs_review` report takes effect once the session is idle; a session that no longer exists fails the job |
| Job without a session | Running job with no `sessionID` | `failed` |
| Event accumulator | Tracks files edited, current activity and last activity time per job | Powers `mc_status`, `mc_capture` (with `filter`), `mc_overview` |
| Permission policy | `permission.asked` events and the pending list on first reconcile | `auto-approve`, `deny`, or relay (`ask-user`: never approved here, denied after 2 minutes unanswered) |

---

## State Transition Maps

### Job State Transitions

```
queued ──────> waiting_deps ──> running ──> completed ──> ready_to_merge ──> merging ──> merged
  │               │               │            │                                │
  │               │               ├──> failed  └──> failed (touchSet)           ├──> conflict ──> ready_to_merge
  │               │               │              │                              │
  │               │               ├──> stopped   ├──> ready_to_merge (accept)   └──> (canceled/stopped)
  │               │               │              ├──> running (relaunch)
  │               │               └──> canceled  └──> ready_to_merge (retry)
  │               │
  │               ├──> stopped
  │               └──> canceled
  │
  ├──> running
  ├──> stopped
  └──> canceled

merged ──> needs_rebase ──> ready_to_merge
```

### Plan State Transitions

```
pending ──> running ──> paused ──> running (resume)
  │           │           │
  │           ├──> merging ──> creating_pr ──> completed
  │           │                    │
  │           ├──> failed          ├──> failed
  │           │                    └──> canceled
  │           └──> canceled
  │
  ├──> failed
  └──> canceled
```
