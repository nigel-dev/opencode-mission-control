# Mission Control — Comprehensive Manual E2E Test Plan

> **Context**: We are dogfooding this plugin from within the plugin's own repo.
> All `mc_*` tool calls are made by the AI agent (us) in this session.
> This plan covers **all 17 MCP tools**, **all 12 job states**, and **all 8 plan states**.

> **Dynamic Path Convention**: All paths use `$(basename $(git rev-parse --show-toplevel))` instead of
> hardcoded project names. This makes the plan portable across repos and forks.

---

## Emergency Nuclear Cleanup Script

**Run this FIRST if the environment is dirty, or LAST to guarantee clean state.**

This script is idempotent and safe to run at any time. Every command is fault-tolerant.

```bash
#!/bin/bash
# Mission Control — Nuclear Cleanup
# Safe to run at any time. All commands are idempotent.

PROJECT_NAME=$(basename $(git rev-parse --show-toplevel))
STATE_DIR=~/.local/share/opencode-mission-control/$PROJECT_NAME

echo "=== Nuclear Cleanup: $PROJECT_NAME ==="

# 1. Kill ALL mc-tmc-* tmux sessions
echo "Killing tmux sessions..."
for s in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^mc-tmc-'); do
  tmux kill-session -t "$s" 2>/dev/null || true
done

# 2. Remove ALL tmc-* worktrees
echo "Removing worktrees..."
for wt in $(git worktree list --porcelain 2>/dev/null | grep '^worktree ' | awk '{print $2}' | grep 'tmc-'); do
  git worktree remove --force "$wt" 2>/dev/null || true
done

# 3. Remove integration worktrees (from plan tests)
for wt in $(git worktree list --porcelain 2>/dev/null | grep '^worktree ' | awk '{print $2}' | grep 'mc-integration'); do
  git worktree remove --force "$wt" 2>/dev/null || true
done

# 4. Prune stale worktree references
git worktree prune 2>/dev/null || true

# 5. Delete ALL mc/tmc-* branches
echo "Deleting test branches..."
for br in $(git branch --list 'mc/tmc-*' 2>/dev/null); do
  git branch -D "$br" 2>/dev/null || true
done

# 6. Delete ALL mc/integration-* branches (flat pattern)
for br in $(git branch --list 'mc/integration-*' 2>/dev/null); do
  git branch -D "$br" 2>/dev/null || true
done

# 7. Delete ALL mc/integration/* branches (nested pattern)
for br in $(git branch --list 'mc/integration/*' 2>/dev/null); do
  git branch -D "$br" 2>/dev/null || true
done

# 8. Clean report files
echo "Cleaning report files..."
rm -f "$STATE_DIR/reports/"*.json 2>/dev/null || true
rm -f "$STATE_DIR/reports/"*.json.tmp 2>/dev/null || true

# 9. Clean plan state
echo "Cleaning plan state..."
rm -f "$STATE_DIR/state/plan.json" 2>/dev/null || true

# 10. Final prune
git worktree prune 2>/dev/null || true

# 11. Clean jobs state
echo "Cleaning jobs state..."
rm -f "$STATE_DIR/state/jobs.json" 2>/dev/null || true

echo "=== Nuclear Cleanup Complete ==="
```

---

## Standalone Rebuild & Restart Procedure

If the plugin needs rebuilding mid-test (e.g., after a code change):

```bash
# 1. Build the plugin
bun run build

# 2. Verify the build output
ls -la dist/index.js

# 3. Restart OpenCode (the plugin re-loads on startup)
#    Exit and re-enter your OpenCode session.

# 4. Verify plugin loaded
#    Run mc_overview — if it responds, the plugin is loaded.
```

---

## Safety Rules

1. **Test name prefix**: All test jobs use the prefix `tmc-` (test-mission-control) to distinguish from real work.
2. **No pushes**: We never call `mc_pr` or `git push` during testing. `mc_pr` is verified structurally only (documented but never invoked).
3. **No OMO modes except plan mode**: We only test `vanilla` and `plan` modes. Never `ralph` or `ulw` — these launch recursive agent loops.
4. **Simple prompts only**: Test job prompts create trivial files only (e.g., `echo hello > test.txt`).
5. **Snapshot & restore**: We record pre-test state (Phase 0) and verify post-test state matches (Phase 12).
6. **SHA-based resets**: NEVER use `HEAD~N` for git resets. Always save SHAs before merges (e.g., `$PHASE4_SHA`) and reset to them explicitly.
7. **Wait 3-5 seconds after every `mc_launch`**: The tmux session and worktree need time to initialize before monitoring/capture calls.
8. **Always `deleteBranch=true` on cleanup**: Every `mc_cleanup` call must include `deleteBranch=true` to prevent branch leaks.
9. **Cancel before completion**: Plans must be cancelled before all jobs reach `merged` state. If all jobs merge, the plan auto-pushes to remote and enters `creating_pr` state.
10. **Dynamic paths only**: Never hardcode project names in paths. Always use `$(basename $(git rev-parse --show-toplevel))` or the `$PROJECT_NAME` variable.
11. **Agent timing**: Simple prompts (echo, file creation) complete in 10-25 seconds. If you need the agent to be in `running` state when you check, either check within 5-10 seconds of launch, use a longer-running prompt like "Read every file in src/ and summarize each one", or kill the agent immediately after launch.

---

## Quick Smoke Test (5 minutes)

Run these tests for basic validation after a code change. References use test IDs from the full phases.

| Step | Source | Test | Purpose |
|------|--------|------|---------|
| 1 | Phase 0 | Nuclear Cleanup | Clean environment |
| 2 | Phase 1 | 1.1-1.6 (launch → status → capture → kill → cleanup) | Core lifecycle |
| 3 | Phase 1 | 1.7 (duplicate name rejected) | Input validation |
| 4 | Phase 2 | 2.1 (error on nonexistent job) | Error handling |
| 5 | Phase 2 | 2.7 (cleanup running job rejected) | Safety check |
| 6 | Phase 5 | 5.7-5.10 (plan with deps → verify waiting_deps → cancel) | Plan basics |
| 7 | Phase 9 | 9.1 (overview empty) | Dashboard baseline |
| 8 | Phase 9 | 9.4 (overview with jobs) | Dashboard with data |
| 9 | Phase 9 | 9.14 (overview after cleanup) | Dashboard cleanup |
| 10 | Phase 12 | Nuclear Cleanup | Clean exit |

**Pass criteria**: All 10 steps succeed. If any fail, run the full test plan for that phase.

---

## MCP Tools Coverage Matrix

All 17 tools must be exercised during this plan. Check off as tested:

| Tool | Phase(s) | Notes |
|------|----------|-------|
| `mc_launch` | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 | Core lifecycle |
| `mc_jobs` | 1, 2, 3, 4, 5, 6, 9 | List/filter jobs |
| `mc_status` | 1, 2, 9, 10 | Detailed job info |
| `mc_capture` | 1, 2, 7, 8, 10 | Terminal output |
| `mc_attach` | 1, 2 | Tmux attach command |
| `mc_diff` | 1, 2, 4 | Branch comparison |
| `mc_kill` | 1, 2, 3, 4, 6, 7, 8 | Stop running jobs |
| `mc_cleanup` | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12 | Remove artifacts |
| `mc_sync` | 4 | Rebase/merge sync |
| `mc_merge` | 4, 6 | Merge to main |
| `mc_pr` | — | **NOT tested** (pushes to remote). Structural mention only. |
| `mc_plan` | 5, 6 | Create orchestrated plans |
| `mc_plan_status` | 5, 6 | Plan progress |
| `mc_plan_cancel` | 5, 6 | Cancel active plan |
| `mc_plan_approve` | 5 | Approve copilot/supervisor |
| `mc_report` | 8 | Agent status reporting (filesystem verification) |
| `mc_overview` | 9 | Dashboard summary |

---

## Job States Reference (12 total)

From `plan-types.ts`:

| State | Description | Observed In |
|-------|-------------|-------------|
| `queued` | Job created but not yet launched | Phase 5 (dependency chains) |
| `waiting_deps` | Waiting for dependencies to merge | Phase 5, 6 |
| `running` | Agent is actively working | Phase 1, 3, 6 |
| `completed` | Agent finished successfully | Phase 1 (if agent completes), 6 |
| `failed` | Agent crashed or exited non-zero | Phase 11 (observational) |
| `ready_to_merge` | Completed and queued for merge train | Phase 6 (plan context) |
| `merging` | Currently being merged into integration | Phase 6 (plan context) |
| `merged` | Successfully merged into integration | Phase 6 (plan context) |
| `conflict` | Merge conflict detected | Phase 6F |
| `needs_rebase` | Post-merge rebase required | Phase 6 (plan context) |
| `stopped` | Manually killed via `mc_kill` | Phase 1, 3, 4 |
| `canceled` | Cancelled via plan cancel | Phase 5 |

---

## Plan States Reference (8 total)

From `plan-types.ts`:

| State | Description | Observed In |
|-------|-------------|-------------|
| `pending` | Created in copilot mode, awaiting approval | Phase 5E |
| `running` | Plan is actively executing | Phase 5A, 5B, 6H |
| `paused` | Supervisor checkpoint hit | Phase 5F |
| `merging` | All jobs complete, merge train running | Phase 6 (observational) |
| `creating_pr` | **NEVER reach this** — cancel before all jobs merge | — |
| `completed` | Plan fully done (PR created) | — |
| `failed` | Plan failed (merge conflict, test failure) | Phase 6 (observational) |
| `canceled` | Plan cancelled via `mc_plan_cancel` | Phase 5D |

---

## Phase 0 — Pre-Test State Snapshot

Record these before any testing begins:

| Artifact | Command | Baseline Value |
|----------|---------|----------------|
| tmux sessions | `tmux list-sessions` | (record) |
| git branches (mc/*) | `git branch --list 'mc/*'` | (record — should be empty) |
| git worktrees | `git worktree list` | (record — main only) |
| state dir contents | `ls ~/.local/share/opencode-mission-control/$(basename $(git rev-parse --show-toplevel))/` | (record) |
| jobs.json | `cat ~/.local/share/opencode-mission-control/$(basename $(git rev-parse --show-toplevel))/state/jobs.json` | (record) |
| working tree status | `git status` | clean |
| HEAD SHA | `git rev-parse HEAD` | Save as `$INITIAL_SHA` |

| # | Action | Verify |
|---|--------|--------|
| 0.1 | Run Nuclear Cleanup script (above) | All `tmc-*` artifacts removed |
| 0.2 | `mc_jobs` | "No jobs found." or empty list |
| 0.3 | `git worktree list` | Only main worktree |
| 0.4 | `tmux list-sessions` — no `mc-tmc-*` entries | Only main session |
| 0.5 | `mc_plan_status` | "No active plan" |
| 0.6 | Record `$INITIAL_SHA` = `git rev-parse HEAD` | SHA saved for Phase 12 |

---

## Phase 1 — Single Job Lifecycle

> **Timing Note**: Simple prompts complete in 10-25 seconds. Check `running` state within 5-10 seconds of launch, or use a longer prompt.

### 1A: Launch

| # | Test | Action | Expected |
|---|------|--------|----------|
| 1.1 | Launch basic job | `mc_launch` name=tmc-alpha, prompt="Create a file called test.txt with 'hello from tmc-alpha'" | Success message with job ID, branch `mc/tmc-alpha`, worktree path, tmux target `mc-tmc-alpha` |
| 1.2 | **Wait 3-5 seconds** | Allow tmux + worktree initialization | — |
| 1.3 | Verify tmux session created | `tmux list-sessions \| grep mc-tmc-alpha` | Session exists |
| 1.4 | Verify worktree created | `git worktree list \| grep tmc-alpha` | Worktree entry present |
| 1.5 | Verify branch created | `git branch --list mc/tmc-alpha` | Branch exists |
| 1.6 | Verify job state persisted | `mc_jobs` | Shows tmc-alpha as `running` |
| 1.7 | Duplicate name rejected | `mc_launch` name=tmc-alpha, prompt="anything" | Error: "already exists" |

### 1B: Status & Monitoring

| # | Test | Action | Expected |
|---|------|--------|----------|
| 1.8 | Status of running job | `mc_status` name=tmc-alpha | Shows branch, worktree, tmux target, uptime, mode |
| 1.9 | Capture terminal output | `mc_capture` name=tmc-alpha | Returns terminal content (may be opencode startup) |
| 1.10 | Capture with line limit | `mc_capture` name=tmc-alpha, lines=5 | Returns ~5 lines |
| 1.11 | Attach command | `mc_attach` name=tmc-alpha | Returns `tmux attach -t mc-tmc-alpha` |

### 1C: Diff

| # | Test | Action | Expected |
|---|------|--------|----------|
| 1.12 | Diff on job | `mc_diff` name=tmc-alpha | Shows diff (may be empty if agent hasn't committed) |
| 1.13 | Diff stat mode | `mc_diff` name=tmc-alpha, stat=true | Shows file-level summary |

### 1D: Kill

| # | Test | Action | Expected |
|---|------|--------|----------|
| 1.14 | Kill running job | `mc_kill` name=tmc-alpha | Success: status changed to `stopped` |
| 1.15 | Verify tmux session gone | `tmux list-sessions \| grep mc-tmc-alpha` | No match |
| 1.16 | Verify job status updated | `mc_jobs` | tmc-alpha shows as `stopped` |
| 1.17 | Kill already-stopped job | `mc_kill` name=tmc-alpha | "already stopped" or error |
| 1.18 | Force kill | `mc_kill` name=tmc-alpha, force=true | Accepted (idempotent on stopped) |

### 1E: Cleanup

| # | Test | Action | Expected |
|---|------|--------|----------|
| 1.19 | Cleanup specific job | `mc_cleanup` name=tmc-alpha, deleteBranch=true | Worktree removed, branch deleted, job removed from state |
| 1.20 | Verify worktree gone | `git worktree list` | No tmc-alpha entry |
| 1.21 | Verify branch gone | `git branch --list mc/tmc-alpha` | Empty |
| 1.22 | Verify job state clean | `mc_jobs` | "No jobs found." |

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
| 2.7 | Cleanup running job rejected | Launch `tmc-beta`, **wait 3-5s**, then `mc_cleanup` name=tmc-beta | Error: "Cannot cleanup running job" |
| 2.8 | Cleanup no args | `mc_cleanup` (no name, no all) | Error: "Must specify either name or all" |
| 2.9 | Sync nonexistent job | `mc_sync` name=doesnt-exist | Error: "not found" |
| 2.10 | Merge nonexistent job | `mc_merge` name=doesnt-exist | Error: "not found" |

**Cleanup after Phase 2**:

| # | Action | Verify |
|---|--------|--------|
| 2.11 | `mc_kill` name=tmc-beta | Stopped |
| 2.12 | `mc_cleanup` name=tmc-beta, deleteBranch=true | Fully cleaned |
| 2.13 | `mc_jobs` | "No jobs found." |

### 2D: Window Placement (Improvement #7)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 2.14 | Launch with window placement | `mc_launch` name=tmc-window, prompt="echo hi", placement=window | Job launched |
| 2.15 | Verify window (not session) | `tmux list-sessions` — should NOT show `mc-tmc-window` as a session | Window attached to current session instead |
| 2.16 | Verify status shows placement | `mc_status` name=tmc-window | Shows `placement: window` |
| 2.17 | Kill and cleanup | `mc_kill` name=tmc-window; `mc_cleanup` name=tmc-window, deleteBranch=true | Clean |

### 2E: Post-Create Hook Parameters (Improvements #8, #9)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 2.18 | Launch with commands | `mc_launch` name=tmc-cmds, prompt="echo test", commands=["echo setup-ran > .mc-setup-marker"] | Job launches |
| 2.19 | Verify command ran | Check worktree for `.mc-setup-marker` file | File exists with content "setup-ran" |
| 2.20 | Cleanup cmds job | `mc_kill` name=tmc-cmds; `mc_cleanup` name=tmc-cmds, deleteBranch=true | Clean |
| 2.21 | Launch with symlinkDirs | `mc_launch` name=tmc-symlink, prompt="echo test", symlinkDirs=["node_modules"] | Job launches |
| 2.22 | Verify symlink | `ls -la <worktree>/node_modules` | Shows symlink arrow (→) |
| 2.23 | Cleanup symlink job | `mc_kill` name=tmc-symlink; `mc_cleanup` name=tmc-symlink, deleteBranch=true | Clean |
| 2.24 | Create temp file for copy test | Create `.env.example` in main worktree with content `TEST_VAR=hello` | File exists |
| 2.25 | Launch with copyFiles | `mc_launch` name=tmc-copy, prompt="echo test", copyFiles=[".env.example"] | Job launches |
| 2.26 | Verify file copied | Check worktree for `.env.example` — should be a regular file (not symlink) | File exists, content matches, `ls -la` shows no symlink |
| 2.27 | Cleanup copy job | `mc_kill` name=tmc-copy; `mc_cleanup` name=tmc-copy, deleteBranch=true | Clean |
| 2.28 | Remove temp file | `rm .env.example` | Cleaned |

---

## Phase 3 — Multiple Jobs

> **Timing Note**: Simple prompts complete in 10-25 seconds. Check `running` state within 5-10 seconds of launch, or use a longer prompt.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 3.1 | Launch job 1 | `mc_launch` name=tmc-multi-1, prompt="echo 'job1' > job1.txt" | Success |
| 3.2 | **Wait 3-5 seconds** | — | — |
| 3.3 | Launch job 2 | `mc_launch` name=tmc-multi-2, prompt="echo 'job2' > job2.txt" | Success |
| 3.4 | **Wait 3-5 seconds** | — | — |
| 3.5 | List shows both | `mc_jobs` | Both tmc-multi-1 and tmc-multi-2 shown as `running` |
| 3.6 | Status filter: running | `mc_jobs` status=running | Only running jobs shown |
| 3.7 | Kill one, list mixed states | `mc_kill` name=tmc-multi-1, then `mc_jobs` | multi-1=`stopped`, multi-2=`running` |
| 3.8 | Cleanup all non-running | `mc_cleanup` all=true, deleteBranch=true | multi-1 cleaned, multi-2 untouched (still running) |
| 3.9 | Kill remaining | `mc_kill` name=tmc-multi-2 | Stopped |
| 3.10 | Cleanup all | `mc_cleanup` all=true, deleteBranch=true | All cleaned |
| 3.11 | Verify clean state | `mc_jobs` + `git worktree list` + `tmux list-sessions` | No test artifacts remain |

### 3C: Status Filter Tests (Improvement #6)

**Prerequisite**: Run these AFTER tests 3.1-3.5 when multiple jobs exist in various states.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 3.12 | Status filter: completed | `mc_jobs` status=completed | Only completed jobs shown |
| 3.13 | Status filter: failed | `mc_jobs` status=failed | Only failed jobs shown (may be empty) |
| 3.14 | Status filter: all | `mc_jobs` status=all | All jobs shown regardless of state |

**Note**: `status=stopped` is NOT a valid API filter value. Stopped jobs appear when using `status=all`.

---

## Phase 4 — Git Workflow (Sync & Merge)

This phase tests the git integration tools on a job with real commits.

**CRITICAL**: Save SHAs before any merges. NEVER use `HEAD~N`.

### Setup

| # | Action | Expected |
|---|--------|----------|
| 4.1 | Record `$PHASE4_SHA` = `git rev-parse HEAD` | SHA saved |
| 4.2 | `mc_launch` name=tmc-git, prompt="Create a file called mc-test.txt with 'hello'" | Job launched |
| 4.3 | **Wait 3-5 seconds** | — |
| 4.4 | `mc_capture` name=tmc-git | Agent is working or has finished |

### Simulate a Commit in the Worktree (if agent didn't make one)

| # | Action | Expected |
|---|--------|----------|
| 4.5 | Get worktree path from `mc_status` name=tmc-git | Path retrieved |
| 4.6 | Create commit in worktree via bash: `echo 'test' > <worktree>/mc-test-file.txt && git -C <worktree> add . && git -C <worktree> commit -m "test commit"` | Commit created |
| 4.7 | `mc_diff` name=tmc-git | Shows mc-test-file.txt added |
| 4.8 | `mc_diff` name=tmc-git, stat=true | Shows 1 file changed |

### Sync

| # | Action | Expected |
|---|--------|----------|
| 4.9 | `mc_sync` name=tmc-git, strategy=rebase | Success (or "already up to date") |
| 4.10 | `mc_sync` name=tmc-git, strategy=merge | Success (tests both strategies) |

### Merge

| # | Action | Expected |
|---|--------|----------|
| 4.11 | Kill job first: `mc_kill` name=tmc-git | Stopped |
| 4.12 | `mc_merge` name=tmc-git | Changes merged into main |
| 4.13 | Verify file exists: `cat mc-test-file.txt` | Contains 'test' |

### Cleanup (CRITICAL — revert merge, restore main)

| # | Action | Expected |
|---|--------|----------|
| 4.14 | `git reset --hard $PHASE4_SHA` (saved in step 4.1) | Merge reverted, back to pre-phase state |
| 4.15 | `mc_cleanup` name=tmc-git, deleteBranch=true | Worktree and branch cleaned |
| 4.16 | `git status` — verify clean tree | Clean |
| 4.17 | Verify HEAD matches `$PHASE4_SHA`: `git rev-parse HEAD` | SHA matches |
| 4.18 | `mc_jobs` — verify empty | "No jobs found." |

---

## Phase 5 — Plan Orchestration

### 5A: Simple Plan (Autopilot)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.1 | Create 2-job plan | `mc_plan` name=tmc-plan-simple, mode=autopilot, jobs=[{name: "tmc-p1", prompt: "echo plan1 > p1.txt"}, {name: "tmc-p2", prompt: "echo plan2 > p2.txt"}] | Plan created, both jobs launch |
| 5.2 | **Wait 3-5 seconds** | — | — |
| 5.3 | Plan status | `mc_plan_status` | Shows plan `running`, both jobs and their states |
| 5.4 | Jobs visible in mc_jobs | `mc_jobs` | tmc-p1 and tmc-p2 shown |

### 5B: Plan with Dependencies

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.5 | Cancel current plan first | `mc_plan_cancel` | Plan cancelled, jobs killed |
| 5.6 | Cleanup cancelled jobs | `mc_cleanup` all=true, deleteBranch=true | All cleaned |
| 5.7 | Create dependent plan | `mc_plan` name=tmc-plan-deps, mode=autopilot, jobs=[{name: "tmc-d1", prompt: "echo dep1 > d1.txt"}, {name: "tmc-d2", prompt: "echo dep2 > d2.txt", dependsOn: ["tmc-d1"]}] | tmc-d1 starts, tmc-d2 waits |
| 5.8 | **Wait 3-5 seconds** | — | — |
| 5.9 | Verify dependency wait | `mc_plan_status` | tmc-d1=`running`, tmc-d2=`waiting_deps` or `queued` |

### 5C: Plan Validation Errors

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.10 | Cancel current plan | `mc_plan_cancel` | Cancelled |
| 5.11 | Cleanup | `mc_cleanup` all=true, deleteBranch=true | Cleaned |
| 5.12 | Circular dependency | `mc_plan` name=tmc-plan-circ, mode=autopilot, jobs=[{name: "tmc-a", prompt: "a", dependsOn: ["tmc-b"]}, {name: "tmc-b", prompt: "b", dependsOn: ["tmc-a"]}] | Error: circular dependency |
| 5.13 | Duplicate names | `mc_plan` name=tmc-plan-dup, mode=autopilot, jobs=[{name: "tmc-dup", prompt: "a"}, {name: "tmc-dup", prompt: "b"}] | Error: duplicate names |
| 5.14 | Unknown dependency | `mc_plan` name=tmc-plan-unk, mode=autopilot, jobs=[{name: "tmc-x", prompt: "x", dependsOn: ["nonexistent"]}] | Error: unknown dependency |

### 5D: Plan Cancel

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.15 | Launch plan then cancel | `mc_plan` name=tmc-plan-cancel, mode=autopilot, jobs=[{name: "tmc-c1", prompt: "echo c1"}, {name: "tmc-c2", prompt: "echo c2"}], **wait 3-5s**, then `mc_plan_cancel` | All jobs killed, plan marked `canceled` |
| 5.16 | Cleanup | `mc_cleanup` all=true, deleteBranch=true | Cleaned |
| 5.17 | Cancel with no plan | `mc_plan_cancel` (when no plan active) | "No plan to cancel" or similar |

### 5E: Plan Approve (Copilot)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.18 | Cleanup from prior tests | `mc_cleanup` all=true, deleteBranch=true | Clean |
| 5.19 | Create copilot plan | `mc_plan` name=tmc-plan-copilot, mode=copilot, jobs=[{name: "tmc-cp1", prompt: "echo copilot > cp1.txt"}] | Plan created in `pending` state |
| 5.20 | Plan status shows pending | `mc_plan_status` | Shows plan `pending`, awaiting approval |
| 5.21 | Approve plan | `mc_plan_approve` | Plan starts executing, status -> `running` |
| 5.22 | **Wait 3-5 seconds** | — | — |
| 5.23 | Verify job launched | `mc_jobs` | tmc-cp1 shown as `running` |
| 5.24 | Approve with nothing pending | `mc_plan_approve` (after already approved) | "Nothing to approve" or error |

### 5F: Supervisor Mode (Checkpoint)

> **Timing Caveat**: The supervisor `pre_merge` checkpoint only triggers when all jobs complete and the merge train starts. With simple prompts, jobs complete in 10-20 seconds — the plan may auto-advance before you observe the `paused` state. Use a 3-job plan with a long-running first job, or verify synthetically by checking `plan.json` for `status: "paused"`.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.25 | Cancel copilot plan | `mc_plan_cancel` | Cancelled |
| 5.26 | Cleanup | `mc_cleanup` all=true, deleteBranch=true | Cleaned |
| 5.27 | Create supervisor plan | `mc_plan` name=tmc-plan-super, mode=supervisor, jobs=[{name: "tmc-sv1", prompt: "echo super > sv1.txt"}] | Plan created |
| 5.28 | **Wait 3-5 seconds** | — | — |
| 5.29 | Check for checkpoint pauses | `mc_plan_status` | May show `paused` at checkpoint or `running` |
| 5.30 | Approve checkpoint (if paused) | `mc_plan_approve` checkpoint=pre_merge | Execution continues |

### Phase 5 Cleanup

| # | Action | Verify |
|---|--------|--------|
| 5.31 | `mc_plan_cancel` (if still active) | Plan cancelled |
| 5.32 | `mc_cleanup` all=true, deleteBranch=true | All plan artifacts cleaned |
| 5.33 | `mc_jobs` — verify empty | "No jobs found." |
| 5.34 | `mc_plan_status` — verify no plan | "No active plan" |

---

## Phase 6 — Realistic Multi-Job Scenario (Overlap & Conflicts)

> **Timing Note**: Simple prompts complete in 10-25 seconds. Check `running` state within 5-10 seconds of launch, or use a longer prompt.

This phase tests a realistic workflow where 3 agents work on related tasks simultaneously.
We manually simulate the agents' commits to control timing and test merge ordering.

### Background: What Do Spawned Agents Know?

The `.opencode/` directory is **automatically symlinked** into every worktree via
`BUILTIN_SYMLINKS` in `worktree-setup.ts`. Both `mc_launch` and the orchestrator's
`launchJob` call `resolvePostCreateHook()`, which always includes `.opencode` in the
symlink list. This means spawned agents **DO** have access to Mission Control tools.

**What each agent CAN see:**
- Its own prompt (passed via `opencode --prompt '...'`)
- The full repo codebase (checked out at the worktree's branch)
- Standard OpenCode tools (read, write, bash, grep, etc.)
- ALL `mc_*` tools (plugin loaded via `.opencode` symlink)
- `/mc-*` slash commands
- Other jobs via `mc_jobs` (they can see sibling jobs)
- `mc_report` tool for reporting status back to the orchestrator

**What each agent CANNOT see:**
- Whether it's part of an orchestrated plan (plan context not exposed to agents)
- Other agents' terminal output (no cross-session capture)
- The merge train or integration branch internals
- The dependency graph (agents don't know what depends on them)

### 6A: Setup — Create Overlapping File Structure

| # | Action | Expected |
|---|--------|----------|
| 6.1 | Record `$PHASE6_BASE_SHA` = `git rev-parse HEAD` | SHA saved |
| 6.2 | Create shared target file: `echo -e 'line1: original\nline2: original\nline3: original\nline4: original\nline5: original' > shared-config.txt && git add shared-config.txt && git commit -m "add shared-config.txt for conflict testing"` | File committed on main |

### 6B: Launch 3 Realistic Jobs

| # | Test | Action | Expected |
|---|------|--------|----------|
| 6.3 | Launch docs job | `mc_launch` name=tmc-docs, prompt="Update the README.md with a new section about troubleshooting" | Success, branch `mc/tmc-docs` |
| 6.4 | **Wait 3-5 seconds** | — | — |
| 6.5 | Launch bugfix job | `mc_launch` name=tmc-bugfix, prompt="Fix the config loading bug by updating shared-config.txt line2" | Success, branch `mc/tmc-bugfix` |
| 6.6 | **Wait 3-5 seconds** | — | — |
| 6.7 | Launch feature job | `mc_launch` name=tmc-feature, prompt="Add caching feature by updating shared-config.txt line4" | Success, branch `mc/tmc-feature` |
| 6.8 | **Wait 3-5 seconds** | — | — |
| 6.9 | All 3 running | `mc_jobs` | All 3 shown as `running` |

### 6C: Simulate Agent Work (Manual Commits)

We kill the agents quickly and create controlled commits to test merge behavior.
The bugfix and feature jobs both modify `shared-config.txt` but on **different lines**
(non-conflicting overlap).

| # | Action | Expected |
|---|--------|----------|
| 6.10 | Kill all 3 agents: `mc_kill` tmc-docs, tmc-bugfix, tmc-feature | All `stopped` |
| 6.11 | **Docs commit**: In tmc-docs worktree, append a troubleshooting section to README.md and commit | Clean commit, no overlap |
| 6.12 | **Bugfix commit**: In tmc-bugfix worktree, change `line2` of `shared-config.txt` from "original" to "bugfix-applied" and commit | Commit touches line2 |
| 6.13 | **Feature commit**: In tmc-feature worktree, change `line4` of `shared-config.txt` from "original" to "cache-enabled" and commit | Commit touches line4 |

### 6D: Test Merge Ordering (Non-Conflicting Overlap)

The bugfix and feature both touch `shared-config.txt` but on different lines.
Merging should succeed in any order since the changes don't overlap.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 6.14 | Merge docs first (safe) | `mc_merge` name=tmc-docs | Clean merge — README change only |
| 6.15 | Merge bugfix second | `mc_merge` name=tmc-bugfix | Clean merge — line2 change in shared-config.txt |
| 6.16 | Merge feature third | `mc_merge` name=tmc-feature | Clean merge — line4 change (different line, no conflict) |
| 6.17 | Verify merged state | `cat shared-config.txt` | line2=bugfix-applied, line4=cache-enabled, others=original |
| 6.18 | Verify README updated | `grep -q 'troubleshooting' README.md` (or whatever the docs job added) | Section present |

### 6E: Cleanup Non-Conflicting Test

| # | Action | Expected |
|---|--------|----------|
| 6.19 | `git reset --hard $PHASE6_BASE_SHA` (saved in step 6.1 — undoes merges AND shared-config.txt commit) | Back to pre-phase baseline |
| 6.20 | `mc_cleanup` all=true, deleteBranch=true | All worktrees and branches gone |
| 6.21 | `mc_jobs` — verify clean | Empty |

### 6F: Provoke a Merge Conflict

Now we test what happens when two jobs modify the **same line** of the same file.

| # | Action | Expected |
|---|--------|----------|
| 6.22 | Re-create shared-config.txt: same as step 6.2 | File committed on main |
| 6.23 | Record `$PHASE6_CONFLICT_SHA` = `git rev-parse HEAD` | SHA saved |
| 6.24 | `mc_launch` name=tmc-conflict-a, prompt="change line2 of shared-config.txt" | Success |
| 6.25 | **Wait 3-5 seconds** | — |
| 6.26 | `mc_launch` name=tmc-conflict-b, prompt="also change line2 of shared-config.txt" | Success |
| 6.27 | **Wait 3-5 seconds** | — |
| 6.28 | Kill both agents immediately | Stopped |
| 6.29 | **Conflict-A commit**: In worktree, change `line2` to "version-A" and commit | Done |
| 6.30 | **Conflict-B commit**: In worktree, change `line2` to "version-B" and commit | Done |
| 6.31 | Merge conflict-a first: `mc_merge` name=tmc-conflict-a | Clean merge |
| 6.32 | Merge conflict-b second: `mc_merge` name=tmc-conflict-b | **FAILS with merge conflict** on shared-config.txt line2 |
| 6.33 | Verify main is not corrupted: `git status` | Clean (merge was aborted by the tool) |
| 6.34 | Verify shared-config.txt: `cat shared-config.txt` | line2="version-A" (first merge won, second was rejected) |

> **Fixed**: The merge conflict cleanup issue was fixed in commit 9fe2fa4. `mc_merge` now properly aborts on conflict and leaves the working tree clean.

### 6G: Cleanup Conflict Test

| # | Action | Expected |
|---|--------|----------|
| 6.35 | `git reset --hard $PHASE6_CONFLICT_SHA` | Back to pre-conflict state (with shared-config.txt) |
| 6.36 | `git reset --hard $PHASE6_BASE_SHA` | Back to pre-phase baseline (no shared-config.txt) |
| 6.37 | `mc_cleanup` all=true, deleteBranch=true | Cleaned |
| 6.38 | `mc_jobs` — verify clean | Empty |

### 6H: Plan-Based Orchestration with Overlap

Test the full orchestrator with a plan that has dependency ordering.

| # | Action | Expected |
|---|--------|----------|
| 6.39 | Re-create shared-config.txt and commit (same as 6.2) | Committed |
| 6.40 | Record `$PHASE6_PLAN_SHA` = `git rev-parse HEAD` | SHA saved |
| 6.41 | `mc_plan` name=tmc-plan-overlap, mode=autopilot, jobs=[{name: "tmc-po-docs", prompt: "update README"}, {name: "tmc-po-bugfix", prompt: "fix line2 of shared-config.txt", dependsOn: ["tmc-po-docs"]}, {name: "tmc-po-feature", prompt: "update line4 of shared-config.txt", dependsOn: ["tmc-po-bugfix"]}] | Plan started, docs launches first |
| 6.42 | **Wait 3-5 seconds** | — |
| 6.43 | `mc_plan_status` | Shows dependency chain: docs -> bugfix -> feature |
| 6.44 | Verify dependency wait | tmc-po-bugfix should be `waiting_deps` | Status confirmed |
| 6.45 | **Cancel plan immediately** (prevent `creating_pr`): `mc_plan_cancel` | All jobs killed, plan `canceled` |
| 6.46 | `mc_cleanup` all=true, deleteBranch=true | All artifacts cleaned |

### 6I: Final Cleanup — Remove shared-config.txt from repo

| # | Action | Expected |
|---|--------|----------|
| 6.47 | `git reset --hard $PHASE6_BASE_SHA` (undo shared-config.txt commit) | File removed from tree |
| 6.48 | Verify `shared-config.txt` is gone: `ls shared-config.txt` | File not found |
| 6.49 | `mc_jobs` — final verify | Empty |

---

## Phase 7 — Model Verification

This phase verifies that the launcher script correctly passes model configuration to spawned agents.

> **Timing Caveat**: `.mc-launch.sh` is auto-deleted after 5 seconds. You must read it IMMEDIATELY after launch. If you miss the window, re-launch and try again — it's not a test failure, just a timing issue.

### 7A: Identify Current Model

| # | Test | Action | Expected |
|---|------|--------|----------|
| 7.1 | Identify session model | Note the model you're currently using (check startup banner or ask "what model are you?") | Record as `$CURRENT_MODEL` (e.g., `anthropic/claude-sonnet-4-20250514`) |

### 7B: Verify Launcher Script (`.mc-launch.sh`)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 7.2 | Launch job | `mc_launch` name=tmc-model, prompt="echo hello" | Success — note the worktree path from the response |
| 7.3 | **IMMEDIATELY** read launcher script | Read `<worktree>/.mc-launch.sh` — must read within 5 seconds | File exists |
| 7.4 | Verify model flag | Check file contents for `-m` flag | Contains `-m "$CURRENT_MODEL"` or the model string from your session |
| 7.5 | Verify prompt file reference | Check file contents for `.mc-prompt.txt` | Contains `--prompt "$(cat '.mc-prompt.txt')"` or similar |
| 7.6 | Verify script is executable | `ls -la <worktree>/.mc-launch.sh` | `-rwxr-xr-x` permissions |

### 7C: Verify Terminal Output

| # | Test | Action | Expected |
|---|------|--------|----------|
| 7.7 | Wait for agent startup | Wait 5-10 seconds after launch | Agent should be running |
| 7.8 | Check terminal for model | `mc_capture` name=tmc-model, lines=30 | Terminal output shows model identifier (e.g., in opencode startup banner or model selection line) |
| 7.9 | Verify model matches | Compare captured model to `$CURRENT_MODEL` | Model in tmux matches the model from step 7.1 |

### 7D: Cleanup

| # | Action | Verify |
|---|--------|--------|
| 7.10 | `mc_kill` name=tmc-model | Stopped |
| 7.11 | `mc_cleanup` name=tmc-model, deleteBranch=true | Cleaned |
| 7.12 | `mc_jobs` | Empty |

---

## Phase 8 — mc_report Flow

`mc_report` is called by spawned agents to report their status back to Mission Control.
Agents have access to `mc_report` because `.opencode` is automatically symlinked into
every worktree. The `MC_REPORT_SUFFIX` appended to every agent prompt instructs agents
to call `mc_report` at key milestones. We verify reports via **filesystem inspection**
of report JSON files, and also check that `mc_status` and `mc_overview` surface report data.

### 8A: Launch a Reporting Job

| # | Test | Action | Expected |
|---|------|--------|----------|
| 8.1 | Launch job with substantive prompt | `mc_launch` name=tmc-reporter, prompt="Create a file called report-test.txt with 'hello world'. When done, commit your changes." | Job launched |
| 8.2 | **Wait 3-5 seconds** | — | — |
| 8.3 | Verify job running | `mc_capture` name=tmc-reporter | Agent is working |

### 8B: Verify Report Files (Non-Deterministic)

**Note**: Agents have `mc_report` available and are instructed to use it via `MC_REPORT_SUFFIX`.
Reports should appear reliably, but agent behavior is non-deterministic. If no report appears
after 15 seconds, investigate — the plugin is wired correctly, so absence likely indicates
the agent ignored the prompt suffix or hasn't reached a reporting milestone yet.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 8.4 | Wait for agent to potentially report | Wait 10-15 seconds | — |
| 8.5 | Check reports directory | `ls ~/.local/share/opencode-mission-control/$(basename $(git rev-parse --show-toplevel))/reports/` | May contain `*.json` files |
| 8.6 | If report exists, verify schema | Read any `*.json` file found | Schema: `{jobId: string, jobName: string, status: ReportStatus, message: string, progress?: number, timestamp: string}` |
| 8.7 | Verify ReportStatus enum | Check `status` field value | One of: `working`, `blocked`, `needs_review`, `completed`, `progress` |
| 8.8 | Verify jobName matches | Check `jobName` field | Should be `tmc-reporter` |

### 8C: Cleanup Reporter

| # | Action | Verify |
|---|--------|--------|
| 8.9 | `mc_kill` name=tmc-reporter | Stopped |
| 8.10 | `mc_cleanup` name=tmc-reporter, deleteBranch=true | Cleaned |
| 8.11 | Clean report files | `rm -f ~/.local/share/opencode-mission-control/$(basename $(git rev-parse --show-toplevel))/reports/*.json` | Reports cleaned |

### 8D: Deterministic Report Injection Tests (Improvement #1)

These tests use **synthetic report injection** to deterministically verify the full report pipeline.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 8.12 | Launch job for injection tests | `mc_launch` name=tmc-inject, prompt="echo 'injection test'" | Job launched |
| 8.13 | **Wait 3-5 seconds** | — | — |
| 8.14 | Get Job ID | `mc_status` name=tmc-inject | Extract the UUID from the output |
| 8.15 | Set STATE_DIR | `STATE_DIR=~/.local/share/opencode-mission-control/$(basename $(git rev-parse --show-toplevel))` | — |
| 8.16 | Inject `working` report | Write JSON to `$STATE_DIR/reports/<UUID>.json` | Report file created |
| 8.17 | **Wait 15 seconds** | — | Monitor polls every 10s |
| 8.18 | Verify status shows progress | `mc_status` name=tmc-inject | Shows progress info from report |
| 8.19 | Inject `blocked` report | Overwrite `$STATE_DIR/reports/<UUID>.json` | Report file updated |
| 8.20 | **Wait 15 seconds** | — | Monitor polls |
| 8.21 | Verify overview shows blocked alert | `mc_overview` | Alerts shows: `tmc-inject [blocked]: ...` |
| 8.22 | Verify suggested action | `mc_overview` | Suggested Actions includes: `blocked - run mc_attach` |
| 8.23 | Inject `needs_review` report | Overwrite `$STATE_DIR/reports/<UUID>.json` | Report file updated |
| 8.24 | **Wait 15 seconds** | — | Monitor polls |
| 8.25 | Verify job completed | `mc_status` name=tmc-inject | Status should be `completed` |
| 8.26 | Verify overview shows review alert | `mc_overview` | Alerts shows: `tmc-inject [needs_review]: ...` |
| 8.27 | Cleanup injection job | `mc_kill` name=tmc-inject; `mc_cleanup` name=tmc-inject, deleteBranch=true | Cleaned |
| 8.28 | Clean report files | `rm -f $STATE_DIR/reports/*.json` | Reports cleaned |

**Why synthetic**: Agents complete simple prompts in 10-20 seconds and rarely hit `blocked` state naturally. Synthetic injection tests the exact same code paths deterministically.

### 8E: Synthetic Blocked Pipeline Test

These tests use **synthetic report injection** to deterministically verify the monitor → notification → overview pipeline. We launch a real job to get a valid Job ID, then manually write a report JSON file.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 8.33 | Launch job for synthetic blocked test | `mc_launch` name=tmc-blocked, prompt="echo 'blocked test'" | Job launched |
| 8.34 | **Wait 3-5 seconds** | — | — |
| 8.35 | Get Job ID | `mc_status` name=tmc-blocked | Extract the UUID from the output |
| 8.36 | Set STATE_DIR | `STATE_DIR=~/.local/share/opencode-mission-control/$(basename $(git rev-parse --show-toplevel))` | — |
| 8.37 | Inject blocked report | Write JSON to `$STATE_DIR/reports/<UUID>.json`: `{"jobId": "<UUID>", "jobName": "tmc-blocked", "status": "blocked", "message": "Synthetic blocked test", "timestamp": "<now ISO>"}` | Report file created |
| 8.38 | **Wait 15 seconds** | — | Monitor polls every 10s |
| 8.39 | Verify Overview Alert | `mc_overview` | Alerts section shows: `- tmc-blocked [blocked]: Synthetic blocked test` |
| 8.40 | Verify Suggested Action | `mc_overview` | Suggested Actions shows: `1 job(s) blocked - run mc_attach for tmc-blocked` |
| 8.41 | Verify mc_attach | `mc_attach` name=tmc-blocked | Returns tmux attach command |
| 8.42 | **Manual Check** | Check your active session for a notification | Should see: `⚠️ Job 'tmc-blocked' is blocked...` |

### 8F: Synthetic Needs Review Pipeline Test

Similar to 8E, but with `needs_review`. This status triggers the monitor to mark the job as `completed` while also surfacing an alert.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 8.43 | Cleanup blocked job | `mc_kill` name=tmc-blocked; `mc_cleanup` name=tmc-blocked, deleteBranch=true | Cleaned |
| 8.44 | Clean report files | `rm -f $STATE_DIR/reports/*.json` | Reports cleaned |
| 8.45 | Launch job for synthetic review test | `mc_launch` name=tmc-review, prompt="echo 'review test'" | Job launched |
| 8.46 | **Wait 3-5 seconds** | — | — |
| 8.47 | Get Job ID | `mc_status` name=tmc-review | Extract the UUID |
| 8.48 | Inject review report | Write JSON to `$STATE_DIR/reports/<UUID>.json`: `{"jobId": "<UUID>", "jobName": "tmc-review", "status": "needs_review", "message": "Synthetic review test", "timestamp": "<now ISO>"}` | Report file created |
| 8.49 | **Wait 15 seconds** | — | Monitor polls |
| 8.50 | Verify Job Completed | `mc_status` name=tmc-review | Status should be `completed` (needs_review triggers completion) |
| 8.51 | Verify Overview Alert | `mc_overview` | Alerts section shows: `- tmc-review [needs_review]: Synthetic review test` |
| 8.52 | Verify Suggested Action | `mc_overview` | Suggested Actions shows: `1 job(s) need review - run mc_diff on completed work` |
| 8.53 | Verify mc_diff | `mc_diff` name=tmc-review | Shows diff (even if empty) |
| 8.54 | **Manual Check** | Check your active session for a notification | Should see: `👀 Job 'tmc-review' needs review...` |

### 8G: Cleanup

| # | Action | Verify |
|---|--------|--------|
| 8.55 | `mc_kill` name=tmc-reporter | Stopped (if still running) |
| 8.56 | `mc_cleanup` all=true, deleteBranch=true | All test jobs cleaned |
| 8.57 | Clean report files | `rm -f ~/.local/share/opencode-mission-control/$(basename $(git rev-parse --show-toplevel))/reports/*.json` | Reports cleaned |
| 8.58 | `mc_jobs` | Empty |

---

## Phase 9 — mc_overview Dashboard

### 9A: Empty State

| # | Test | Action | Expected |
|---|------|--------|----------|
| 9.1 | Overview with no jobs | `mc_overview` | Shows empty dashboard, no jobs, no plan |

### 9B: Dashboard with Active Jobs

| # | Test | Action | Expected |
|---|------|--------|----------|
| 9.2 | Launch 2 jobs | `mc_launch` name=tmc-dash-1, prompt="echo dash1 > d1.txt"; **wait 3-5s**; `mc_launch` name=tmc-dash-2, prompt="echo dash2 > d2.txt" | Both launched |
| 9.3 | **Wait 3-5 seconds** | — | — |
| 9.4 | Overview with running jobs | `mc_overview` | Shows 2 running jobs, their names, branches, status |
| 9.5 | Kill one job | `mc_kill` name=tmc-dash-1 | Stopped |
| 9.6 | Overview with mixed states | `mc_overview` | Shows dash-1=`stopped`, dash-2=`running` |
| 9.7 | Kill second job | `mc_kill` name=tmc-dash-2 | Stopped |
| 9.8 | Overview with all stopped | `mc_overview` | Shows both `stopped` |

### 9C: Dashboard with Active Plan

| # | Test | Action | Expected |
|---|------|--------|----------|
| 9.9 | Cleanup prior jobs | `mc_cleanup` all=true, deleteBranch=true | Cleaned |
| 9.10 | Create plan | `mc_plan` name=tmc-plan-dash, mode=autopilot, jobs=[{name: "tmc-pd1", prompt: "echo pd1"}, {name: "tmc-pd2", prompt: "echo pd2"}] | Plan started |
| 9.11 | **Wait 3-5 seconds** | — | — |
| 9.12 | Overview with plan | `mc_overview` | Shows plan info + job statuses |
| 9.13 | Cancel plan | `mc_plan_cancel` | Cancelled |
| 9.14 | Overview after cancel | `mc_overview` | Shows cancelled plan or no plan |

### 9D: Cleanup

| # | Action | Verify |
|---|--------|--------|
| 9.15 | `mc_cleanup` all=true, deleteBranch=true | All artifacts cleaned |
| 9.16 | `mc_jobs` | Empty |

---

## Phase 10 — OMO Plan Mode

Test the `plan` execution mode which loads a Sisyphus plan into the spawned agent.

### 10A: Setup Test Plan File

| # | Action | Expected |
|---|--------|----------|
| 10.1 | Create minimal plan file: `mkdir -p .sisyphus/plans && echo '# Test Plan\n\n## Tasks\n\n- [ ] Create test-output.txt with hello world' > .sisyphus/plans/tmc-test-plan.md` | File created |

### 10B: Launch with Plan Mode

| # | Test | Action | Expected |
|---|------|--------|----------|
| 10.2 | Launch with plan mode | `mc_launch` name=tmc-plan-mode, prompt="Execute the plan", mode=plan, planFile=".sisyphus/plans/tmc-test-plan.md" | Job launched with plan mode |
| 10.3 | **Wait 3-5 seconds** | — | — |
| 10.4 | Verify job launched | `mc_status` name=tmc-plan-mode | Shows mode=plan, running |
| 10.5 | Capture output | `mc_capture` name=tmc-plan-mode, lines=20 | Agent output visible |

### 10C: Cleanup

| # | Action | Verify |
|---|--------|--------|
| 10.6 | `mc_kill` name=tmc-plan-mode | Stopped |
| 10.7 | `mc_cleanup` name=tmc-plan-mode, deleteBranch=true | Cleaned |
| 10.8 | Remove test plan file: `rm -rf .sisyphus/plans/tmc-test-plan.md` | File removed |
| 10.9 | Remove `.sisyphus/plans/` if empty: `rmdir .sisyphus/plans 2>/dev/null; rmdir .sisyphus 2>/dev/null` | Directories removed if empty |
| 10.10 | `mc_jobs` | Empty |

---

## Phase 11 — Hooks (Observational)

These cannot be directly invoked but can be observed during testing.

| # | Test | How to Observe | Expected |
|---|------|----------------|----------|
| 11.1 | Auto-status on idle | During Phases 1-10, watch for toast notifications when idle | Toast with job status summary appears (rate-limited to once per 5 minutes) |
| 11.2 | Monitor detects completion | When a job's agent finishes, check if status auto-updates | Job transitions to `completed` without manual action |
| 11.3 | Monitor detects crash | Kill a tmux pane directly: `tmux kill-pane -t mc-tmc-xxx` (during an active job in earlier phases) | Job transitions to `failed` |
| 11.4 | Compaction context injection | When OpenCode compacts context during testing | Current job state injected into memory |
| 11.5 | Pane-died hook fires | When a tmux pane exits normally | Exit code captured, job status updated |

---

## Phase 12 — Final Verification & Nuclear Cleanup

This ensures we leave the repo in **exactly** the same state we found it.

### 12.1 — Run Nuclear Cleanup

Run the full Nuclear Cleanup script from the top of this document.

### 12.2 — Kill any remaining test tmux sessions

```bash
for s in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^mc-tmc-'); do
  tmux kill-session -t "$s" 2>/dev/null || true
done
```

### 12.3 — Remove any remaining test worktrees

```bash
for wt in $(git worktree list --porcelain 2>/dev/null | grep '^worktree ' | awk '{print $2}' | grep 'tmc-'); do
  git worktree remove --force "$wt" 2>/dev/null || true
done
git worktree prune
```

### 12.4 — Delete any remaining test branches

```bash
for br in $(git branch --list 'mc/tmc-*' 2>/dev/null); do
  git branch -D "$br" 2>/dev/null || true
done
```

### 12.5 — Clean integration branches and worktrees

```bash
# Remove integration worktrees (from plan tests)
for wt in $(git worktree list --porcelain 2>/dev/null | grep '^worktree ' | awk '{print $2}' | grep 'mc-integration'); do
  git worktree remove --force "$wt" 2>/dev/null || true
done

# Remove mc/integration-* branches (flat pattern)
for br in $(git branch --list 'mc/integration-*' 2>/dev/null); do
  git branch -D "$br" 2>/dev/null || true
done

# Remove mc/integration/* branches (nested pattern)
for br in $(git branch --list 'mc/integration/*' 2>/dev/null); do
  git branch -D "$br" 2>/dev/null || true
done
```

### 12.6 — Clean state files

```bash
PROJECT_NAME=$(basename $(git rev-parse --show-toplevel))
STATE_DIR=~/.local/share/opencode-mission-control/$PROJECT_NAME

# Clean report files
rm -f "$STATE_DIR/reports/"*.json 2>/dev/null || true
rm -f "$STATE_DIR/reports/"*.json.tmp 2>/dev/null || true

# Clean plan state
rm -f "$STATE_DIR/state/plan.json" 2>/dev/null || true

# Clean jobs state
rm -f "$STATE_DIR/state/jobs.json" 2>/dev/null || true
```

### 12.7 — Verify against pre-test snapshot

| Artifact | Command | Must Match Baseline |
|----------|---------|---------------------|
| tmux sessions | `tmux list-sessions` | Only `main` (no `mc-tmc-*`) |
| git branches (mc/*) | `git branch --list 'mc/*'` | Empty |
| git worktrees | `git worktree list` | Only main worktree |
| working tree | `git status` | clean (except this test plan file if modified) |
| HEAD SHA | `git rev-parse HEAD` | Matches `$INITIAL_SHA` (from Phase 0) |
| jobs.json | `cat ~/.local/share/opencode-mission-control/$(basename $(git rev-parse --show-toplevel))/state/jobs.json` | Empty jobs array or absent |

### 12.8 — mc_overview confirms clean

| # | Test | Action | Expected |
|---|------|--------|----------|
| 12.8 | Final overview | `mc_overview` | No jobs, no plan, clean state |

---

## Results Tracking

| Phase | Description | Total Tests | Pass | Fail | Blocked | Notes |
|-------|-------------|-------------|------|------|---------|-------|
| 0 | Pre-test state snapshot & cleanup | 6 | | | | |
| 1 | Single job lifecycle | 22 | | | | |
| 2 | Error handling & edge cases | 28 | | | | +4 window placement, +11 post-create hooks |
| 3 | Multiple jobs | 14 | | | | +3 status filter tests |
| 4 | Git workflow (sync & merge) | 18 | | | | |
| 5 | Plan orchestration | 34 | | | | |
| 6 | Realistic multi-job (overlap/conflict) | 49 | | | | |
| 7 | Model verification | 12 | | | | +3 model ID, prompt file, model match |
| 8 | mc_report flow | 54 | | | | +17 deterministic injection (replaced 21 non-deterministic) |
| 9 | mc_overview dashboard | 16 | | | | |
| 10 | OMO plan mode | 10 | | | | |
| 11 | Hooks (observational) | 5 | | | | |
| 12 | Final verification & nuclear cleanup | 8 | | | | |
| **Total** | | **276** | | | | |

---

## Key Risks

1. **Dogfooding paradox**: We're testing Mission Control from within a Mission Control-managed session. Launching jobs will create worktrees of this repo, and those agents will also have MC loaded (via `.opencode/plugins/mission-control.ts` -> `../../dist/index.js`). Our simple prompts and quick kills mitigate recursive chaos.
2. **Merge pollution (Phases 4 & 6)**: The merge tests temporarily bring test commits into main. We immediately `git reset --hard $SAVED_SHA` to undo. If anything goes wrong, these are the highest-risk steps. **NEVER use `HEAD~N`** — always use saved SHAs.
3. **State file corruption**: If we crash mid-test, `jobs.json` and `plan.json` may have orphaned entries. The Nuclear Cleanup script (top of document) handles this.
4. **tmux session leak**: If `mc_kill` fails, tmux sessions persist. Phase 12 force-kills all `mc-tmc-*` sessions.
5. **Integration branch leak**: Plan tests create `mc/integration-*` AND `mc/integration/*` branches and worktrees. Both patterns are cleaned in the Nuclear Cleanup script and Phase 12.
6. **Agent unawareness of plan**: Spawned agents have full MC tools (`.opencode` is symlinked) and can see sibling jobs via `mc_jobs`, but they don't know they're part of an orchestrated plan — plan context is not exposed to agents. They also have access to dangerous tools (`mc_kill`, `mc_plan_cancel`, `mc_merge`) with no guardrails.
7. **Plan auto-push**: If all jobs in a plan reach `merged` state, the plan automatically pushes the integration branch to remote and enters `creating_pr` state. **ALWAYS cancel plans before all jobs complete** to prevent unwanted pushes.
8. **Report reliability**: Agents have `mc_report` available (plugin loaded via `.opencode` symlink) and are instructed to call it via `MC_REPORT_SUFFIX` prompt injection. Report files should appear reliably, but agent behavior is ultimately non-deterministic — a missing report after 15 seconds warrants investigation but is not necessarily a plugin failure.
9. **Launcher script timing**: `.mc-launch.sh` is deleted after 5 seconds. Phase 7 must read it immediately after launch. If you miss the window, the test is inconclusive, not failed.
10. **Worktree initialization race**: Some operations may fail if attempted before the worktree is fully initialized. The 3-5 second wait after every `mc_launch` mitigates this.

---

## Agent Capabilities Reference

### Current State: Spawned Agents Have MC Tools

The `.opencode/` directory is **automatically symlinked** into every worktree. This is
implemented via `BUILTIN_SYMLINKS = ['.opencode']` in `src/lib/worktree-setup.ts`, which
is included in every `resolvePostCreateHook()` call from both `mc_launch` and the
orchestrator's `launchJob`. Plugin updates propagate automatically since it's a symlink.

| Capability | Available? | Why |
|------------|------------|-----|
| `mc_*` tools | **YES** | Plugin loaded via `.opencode` symlink |
| `/mc-*` slash commands | **YES** | Plugin loaded via `.opencode` symlink |
| `mc_report` | **YES** | Agents can report status back to orchestrator |
| `mc_jobs` | **YES** | Agents can see sibling jobs |
| Worktree awareness | **YES** | `getWorktreeContext()` runs in agent session |
| Standard OpenCode tools | **YES** | Read, write, bash, grep, etc. all work |
| Git operations | **YES** | Full git access within the worktree |
| Plan awareness | **NO** | Plan context not exposed to agent prompts |
| Cross-agent visibility | **PARTIAL** | Can list jobs via `mc_jobs` but cannot capture other agents' output |
| Orchestrator control | **UNSAFE** | Agents COULD call `mc_kill`, `mc_plan_cancel`, `mc_merge` — no guardrails prevent this |

### Safety Consideration: Dangerous Tools in Agent Hands

Since agents have full access to ALL `mc_*` tools, they could theoretically:
- Kill other jobs (`mc_kill`)
- Cancel the orchestrating plan (`mc_plan_cancel`)
- Merge branches prematurely (`mc_merge`)
- Launch new jobs (`mc_launch`)

This is mitigated by:
1. Simple test prompts that don't trigger complex tool use
2. Quick kills — agents are stopped before they can cause harm
3. The MC_REPORT_SUFFIX prompt only instructs agents to call `mc_report`, not other tools

### Monitor Mechanisms

| Mechanism | How It Detects | Resulting State |
|-----------|---------------|-----------------|
| Polling (10s interval) | Checks if tmux pane is alive | `running` -> `completed` or `failed` |
| Pane-died hook | tmux fires when pane closes | Immediate state update with exit code |
| Idle detection (5min) | Output hash unchanged + idle prompt visible | `running` -> `completed` |
| Exit code 0 | Normal pane death | `completed` |
| Exit code non-zero | Error pane death | `failed` |

---

## State Transition Maps

### Job State Transitions

```
queued ──────> waiting_deps ──> running ──> completed ──> ready_to_merge ──> merging ──> merged
  │               │               │                                            │
  │               │               ├──> failed                                  ├──> conflict ──> ready_to_merge
  │               │               │                                            │
  │               │               ├──> stopped                                 └──> (canceled/stopped)
  │               │               │
  │               │               └──> canceled
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
