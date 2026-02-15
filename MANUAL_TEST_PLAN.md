# Mission Control — Comprehensive Manual E2E Test Plan

> **Context**: We are dogfooding this plugin from within the plugin's own repo.
> All `mc_*` tool calls are made by the AI agent (us) in this session.
> This plan covers **all 17 MCP tools**, **all 12 job states**, and **all 8 plan states**.
>
> **v1.5 additions**: Phases 13–18 cover serve-mode launch, enhanced `mc_attach`, structured
> observability, session-aware notifications, permission policies, and dynamic orchestration.

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

# 12. Clean port allocation (v1.5 serve mode)
echo "Cleaning port allocation..."
rm -f "$STATE_DIR/port.lock" 2>/dev/null || true

# 13. Kill leaked serve-mode server processes (ports 14100-14199)
echo "Killing leaked serve processes..."
for p in $(lsof -ti:14100-14199 2>/dev/null); do
  kill "$p" 2>/dev/null || true
done

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
12. **Serve mode default (v1.5)**: `useServeMode` defaults to `true`. Jobs launch via `opencode serve` + SDK. To test TUI-mode behavior, temporarily set `"useServeMode": false` in `config.json` and restore afterwards.
13. **Port range (v1.5)**: Serve mode allocates ports from 14100–14199 using `port.lock`. Cleanup releases ports. If stuck, remove `port.lock` manually from the state directory.
14. **Serve mode startup time**: Serve-mode jobs need 5–10 seconds to start (server boot + SDK session creation), compared to 3–5 seconds for TUI mode. Adjust wait times accordingly.

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
| 9 | Phase 5G | 5.76 (retry + relaunch mutual exclusion) | TouchSet param validation |
| 10 | Phase 9 | 9.14 (overview after cleanup) | Dashboard cleanup |
| 11 | Phase 13 | 13.1-13.7 (serve mode launch → status → verify port) | Serve mode basics |
| 12 | Phase 14 | 14.3 (mc_attach opens tmux window for serve job) | Enhanced attach |
| 13 | Phase 15 | 15.5 (mc_capture returns JSON for serve job) | Structured capture |
| 14 | Phase 12 | Nuclear Cleanup | Clean exit |

**Pass criteria**: All 14 steps succeed. If any fail, run the full test plan for that phase.

---

## MCP Tools Coverage Matrix

All 17 tools must be exercised during this plan. Check off as tested:

| Tool | Phase(s) | Notes |
|------|----------|-------|
| `mc_launch` | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13 | Core lifecycle + serve mode |
| `mc_jobs` | 1, 2, 3, 4, 5, 6, 9, 13 | List/filter jobs |
| `mc_status` | 1, 2, 9, 10, 13, 15 | Detailed job info + serve telemetry |
| `mc_capture` | 1, 2, 7, 8, 10, 15 | Terminal output + structured events |
| `mc_attach` | 1, 2, 14 | Tmux attach / serve TUI window |
| `mc_diff` | 1, 2, 4 | Branch comparison |
| `mc_kill` | 1, 2, 3, 4, 6, 7, 8, 13 | Stop running jobs |
| `mc_cleanup` | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13 | Remove artifacts + port release |
| `mc_sync` | 4 | Rebase/merge sync |
| `mc_merge` | 4, 6 | Merge to main |
| `mc_pr` | — | **NOT tested** (pushes to remote). Structural mention only. |
| `mc_plan` | 5, 6, 18 | Create orchestrated plans + dynamic features |
| `mc_plan_status` | 5, 6, 18 | Plan progress |
| `mc_plan_cancel` | 5, 6, 18 | Cancel active plan |
| `mc_plan_approve` | 5, 5G | Approve copilot/supervisor, accept/relaunch/retry touchSet violations |
| `mc_report` | 8 | Agent status reporting (filesystem verification) |
| `mc_overview` | 9, 15 | Dashboard summary + activity indicators |

---

## Job States Reference (12 total)

From `plan-types.ts`:

| State | Description | Observed In |
|-------|-------------|-------------|
| `queued` | Job created but not yet launched | Phase 5 (dependency chains) |
| `waiting_deps` | Waiting for dependencies to merge | Phase 5, 6 |
| `running` | Agent is actively working | Phase 1, 3, 6 |
| `completed` | Agent finished successfully | Phase 1 (if agent completes), 6 |
| `failed` | Agent crashed, exited non-zero, or touchSet violation | Phase 5G, 11 (observational) |
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

### 5G: TouchSet Enforcement

This section tests the touchSet violation detection and the three resolution paths:
**accept**, **relaunch**, and **retry**. These require a plan with `touchSet` configured
and a job that deliberately modifies files outside its allowed patterns.

> **Key Concept**: TouchSet validation runs after a job completes but before it enters the
> merge train. If violations are found, the plan pauses at an `on_error` checkpoint with
> structured `checkpointContext` containing `failureKind`, `jobName`, `touchSetViolations`,
> and `touchSetPatterns`.

#### 5G-1: TouchSet Violation Detection

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.35 | Cleanup from prior tests | `mc_cleanup` all=true, deleteBranch=true | Clean |
| 5.36 | Create plan with touchSet | `mc_plan` name=tmc-plan-touch, mode=supervisor, jobs=[{name: "tmc-ts1", prompt: "Create allowed.txt with 'hello' and also create rogue.txt with 'oops'", touchSet: ["allowed.txt"]}] | Plan created, job launches |
| 5.37 | **Wait 3-5 seconds** | — | — |
| 5.38 | Verify job running | `mc_plan_status` | tmc-ts1=`running` |
| 5.39 | Kill job to simulate completion | `mc_kill` name=tmc-ts1 | Stopped |
| 5.40 | Get worktree path | `mc_status` name=tmc-ts1 | Extract worktree path |
| 5.41 | Create violating files in worktree | In worktree: `echo 'hello' > allowed.txt && echo 'oops' > rogue.txt && git add . && git commit -m "add files"` | Commit with both files |
| 5.42 | **Simulate completion**: Set job status to `completed` via state file edit — update `jobs.json` entry for tmc-ts1 to `status: "completed"` | Job appears completed |
| 5.43 | **Wait 15 seconds** | Orchestrator reconciler detects completion and runs touchSet validation | — |
| 5.44 | Verify plan paused | `mc_plan_status` | Plan `paused`, checkpoint=`on_error` |
| 5.45 | Verify checkpoint context | Read `plan.json` from state dir | `checkpointContext.failureKind` = `"touchset"`, `checkpointContext.jobName` = `"tmc-ts1"`, `checkpointContext.touchSetViolations` includes `"rogue.txt"`, `checkpointContext.touchSetPatterns` = `["allowed.txt"]` |
| 5.46 | Verify job marked failed | `mc_jobs` | tmc-ts1 shows as `failed` |

> **Note**: Steps 5.42-5.43 are synthetic — we manually set the job to `completed` to trigger
> the orchestrator's touchSet validation. In production, the monitor detects agent completion
> and transitions the job state automatically.

#### 5G-2: Accept Path (Clear Checkpoint)

Continue from 5G-1 state (plan paused with touchSet violation).

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.47 | Accept violations | `mc_plan_approve` checkpoint=on_error | Checkpoint cleared, job moves to `ready_to_merge` |
| 5.48 | Verify plan resumed | `mc_plan_status` | Plan `running` (or `merging` if merge train started) |
| 5.49 | Verify job state | `mc_jobs` | tmc-ts1 = `ready_to_merge` or `merging` or `merged` |

> **Cancel immediately after verifying** — do NOT let the plan reach `creating_pr`.

| # | Action | Verify |
|---|--------|--------|
| 5.50 | `mc_plan_cancel` | Plan cancelled |
| 5.51 | `mc_cleanup` all=true, deleteBranch=true | Cleaned |

#### 5G-3: Relaunch Path (Agent Correction)

This tests spawning a new agent in the existing worktree to fix violations.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.52 | Create plan with touchSet | `mc_plan` name=tmc-plan-relaunch, mode=supervisor, jobs=[{name: "tmc-rl1", prompt: "Create allowed.txt with 'hello'", touchSet: ["allowed.txt"]}] | Plan created |
| 5.53 | **Wait 3-5 seconds** | — | — |
| 5.54 | Kill job, create violation, set completed | Same as steps 5.39-5.42 for tmc-rl1 | Job appears completed with rogue.txt |
| 5.55 | **Wait 15 seconds** | Orchestrator detects and validates | — |
| 5.56 | Verify plan paused | `mc_plan_status` | Paused, checkpoint=`on_error` |
| 5.57 | Relaunch agent | `mc_plan_approve` checkpoint=on_error, relaunch=tmc-rl1 | New tmux session created in existing worktree, job back to `running` |
| 5.58 | **Wait 3-5 seconds** | — | — |
| 5.59 | Verify new tmux session | `tmux list-sessions \| grep mc-tmc-rl1` | Session exists |
| 5.60 | Verify job running | `mc_jobs` | tmc-rl1 = `running` |
| 5.61 | Verify correction prompt | `mc_capture` name=tmc-rl1, lines=50 | Agent output visible — correction prompt includes violation details |

> **Cancel immediately** — the relaunched agent may or may not fix the violations.

| # | Action | Verify |
|---|--------|--------|
| 5.62 | `mc_plan_cancel` | Plan cancelled |
| 5.63 | `mc_cleanup` all=true, deleteBranch=true | Cleaned |

#### 5G-4: Retry Path (Manual Fix + Re-validation)

This tests manually fixing the branch and having MC re-validate.

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.64 | Create plan with touchSet | `mc_plan` name=tmc-plan-retry, mode=supervisor, jobs=[{name: "tmc-rt1", prompt: "Create allowed.txt with 'hello'", touchSet: ["allowed.txt"]}] | Plan created |
| 5.65 | **Wait 3-5 seconds** | — | — |
| 5.66 | Kill job, create violation, set completed | Same as steps 5.39-5.42 for tmc-rt1 | Job appears completed with rogue.txt |
| 5.67 | **Wait 15 seconds** | Orchestrator detects and validates | — |
| 5.68 | Verify plan paused | `mc_plan_status` | Paused, checkpoint=`on_error` |
| 5.69 | Retry WITHOUT fixing (should fail) | `mc_plan_approve` checkpoint=on_error, retry=tmc-rt1 | Error: touchSet still violated (rogue.txt still present) |
| 5.70 | Verify plan still paused | `mc_plan_status` | Still paused, checkpoint=`on_error` |
| 5.71 | Fix violation manually | In worktree: `git rm rogue.txt && git commit -m "remove rogue file"` | rogue.txt removed |
| 5.72 | Retry after fix (should succeed) | `mc_plan_approve` checkpoint=on_error, retry=tmc-rt1 | TouchSet re-validated, job moves to `ready_to_merge` |
| 5.73 | Verify plan resumed | `mc_plan_status` | Plan running |

> **Cancel immediately**.

| # | Action | Verify |
|---|--------|--------|
| 5.74 | `mc_plan_cancel` | Plan cancelled |
| 5.75 | `mc_cleanup` all=true, deleteBranch=true | Cleaned |

#### 5G-5: Mutual Exclusion (retry vs relaunch)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.76 | Both retry and relaunch | `mc_plan_approve` checkpoint=on_error, retry=tmc-x, relaunch=tmc-x | Error: cannot specify both retry and relaunch |

#### 5G-6: Relaunch Non-TouchSet Job Rejected

| # | Test | Action | Expected |
|---|------|--------|----------|
| 5.77 | Relaunch on non-touchset failure | (If a plan is paused with a non-touchset failure) `mc_plan_approve` checkpoint=on_error, relaunch=jobname | Error: relaunch only available for touchSet violations |

### Phase 5 Cleanup

| # | Action | Verify |
|---|--------|--------|
| 5.78 | `mc_plan_cancel` (if still active) | Plan cancelled |
| 5.79 | `mc_cleanup` all=true, deleteBranch=true | All plan artifacts cleaned |
| 5.80 | `mc_jobs` — verify empty | "No jobs found." |
| 5.81 | `mc_plan_status` — verify no plan | "No active plan" |

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

> **Run this LAST** — after all feature phases (including Phases 13–18).

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

# Clean port allocation (v1.5)
rm -f "$STATE_DIR/port.lock" 2>/dev/null || true

# Kill leaked serve-mode server processes (v1.5)
for p in $(lsof -ti:14100-14199 2>/dev/null); do
  kill "$p" 2>/dev/null || true
done
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

## Phase 13 — Serve Mode Launch & Port Management (#65)

> **Context**: v1.5 defaults to `useServeMode: true`. Jobs launch via `opencode serve` on an
> allocated port (range 14100–14199), with prompts delivered via the SDK instead of
> `opencode --prompt`. This phase validates the serve-mode launch path, port allocation,
> and port release on cleanup.
>
> **Prerequisites**: `useServeMode` must be `true` in config (this is the default). If you
> previously overrode it, restore: edit `config.json` or remove the `useServeMode` key.
>
> **Timing Note**: Serve-mode jobs need 5–10 seconds to start (server boot + SDK session
> creation). Adjust wait times vs TUI mode (3–5 seconds).

### 13A: Basic Serve Mode Launch

| # | Test | Action | Expected |
|---|------|--------|----------|
| 13.1 | Launch serve mode job | `mc_launch` name=tmc-serve, prompt="Create a file test-serve.txt with 'hello from serve'" | Success message includes Port and Server URL |
| 13.2 | **Wait 5-10 seconds** | Allow server startup + SDK session creation | — |
| 13.3 | Verify port in output | Check launch response | Contains `Port: 14100` (or next available) and `Server: http://127.0.0.1:<port>` |
| 13.4 | Verify status includes serve fields | `mc_status` name=tmc-serve | Shows `Port: <number>` and `Server URL: http://...` under Metadata |
| 13.5 | Verify tmux session exists | `tmux list-sessions \| grep mc-tmc-serve` | Session present (serves `opencode serve`) |
| 13.6 | Verify port lock file | `cat $STATE_DIR/port.lock` | JSON array containing the allocated port number |
| 13.7 | Verify job state persisted | `mc_jobs` | tmc-serve shown as `running` |
| 13.8 | Verify launchSessionID captured | Read `$STATE_DIR/state/jobs.json` | Job entry has `launchSessionID` field matching your current session |

### 13B: Port Allocation Uniqueness

| # | Test | Action | Expected |
|---|------|--------|----------|
| 13.9 | Launch second serve job | `mc_launch` name=tmc-serve-2, prompt="echo hello" | Success, different port |
| 13.10 | **Wait 5-10 seconds** | — | — |
| 13.11 | Verify unique ports | Compare `mc_status` tmc-serve vs `mc_status` tmc-serve-2 | Different port numbers (e.g., 14100 and 14101) |
| 13.12 | Both in port lock | Read port.lock | Contains both allocated ports |

### 13C: Port Release on Cleanup

| # | Test | Action | Expected |
|---|------|--------|----------|
| 13.13 | Kill first job | `mc_kill` name=tmc-serve | Stopped |
| 13.14 | Cleanup first job | `mc_cleanup` name=tmc-serve, deleteBranch=true | Cleaned |
| 13.15 | Verify port released | Read port.lock | First job's port no longer listed |
| 13.16 | Kill and cleanup second | `mc_kill` name=tmc-serve-2; `mc_cleanup` name=tmc-serve-2, deleteBranch=true | Cleaned |
| 13.17 | Verify all ports released | Read port.lock | Empty array `[]` or file absent |
| 13.18 | Verify clean state | `mc_jobs` | "No jobs found." |

### 13D: TUI Mode Fallback

| # | Test | Action | Expected |
|---|------|--------|----------|
| 13.19 | Set useServeMode=false | Edit `$STATE_DIR/config.json`: set `"useServeMode": false` | Config saved |
| 13.20 | Launch TUI mode job | `mc_launch` name=tmc-tui-fallback, prompt="echo hello" | Success — **no** Port or Server URL in output |
| 13.21 | **Wait 3-5 seconds** | — | — |
| 13.22 | Verify no port allocated | `mc_status` name=tmc-tui-fallback | No Port or Server URL fields |
| 13.23 | Cleanup | `mc_kill` name=tmc-tui-fallback; `mc_cleanup` name=tmc-tui-fallback, deleteBranch=true | Cleaned |
| 13.24 | **Restore useServeMode** | Edit `config.json`: set `"useServeMode": true` or remove the key | Config restored to serve-mode default |

**Phase 13 Gate**: All ports must be released and config restored before proceeding.

---

## Phase 14 — Enhanced mc_attach (#65)

> **Context**: In serve mode, `mc_attach` opens an `opencode attach <serverUrl>` TUI in a new
> tmux window (when running inside tmux) instead of returning a `tmux attach -t` command.
> This phase validates both serve-mode and TUI-mode attach behavior.

### 14A: Serve Mode Attach (Inside tmux)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 14.1 | Launch serve mode job | `mc_launch` name=tmc-attach-s, prompt="echo attach test" | Success with port |
| 14.2 | **Wait 5-10 seconds** | — | — |
| 14.3 | Attach opens tmux window | `mc_attach` name=tmc-attach-s | Returns "Opened TUI for job 'tmc-attach-s' in new tmux window" |
| 14.4 | Verify tmux window created | `tmux list-windows` (in current session) | Window named `mc-tmc-attach-s` exists |
| 14.5 | Clean up attach window | Kill the window: `tmux kill-window -t :mc-tmc-attach-s` | Window removed |

### 14B: TUI Mode Attach (Backward Compatibility)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 14.6 | Kill serve job | `mc_kill` name=tmc-attach-s | Stopped |
| 14.7 | Cleanup serve job | `mc_cleanup` name=tmc-attach-s, deleteBranch=true | Cleaned |
| 14.8 | Set useServeMode=false | Edit config | Done |
| 14.9 | Launch TUI job | `mc_launch` name=tmc-attach-t, prompt="echo tui attach" | Success, no port |
| 14.10 | **Wait 3-5 seconds** | — | — |
| 14.11 | Attach returns tmux command | `mc_attach` name=tmc-attach-t | Returns `tmux attach -t mc-tmc-attach-t` (session mode) |
| 14.12 | Cleanup | `mc_kill` name=tmc-attach-t; `mc_cleanup` name=tmc-attach-t, deleteBranch=true | Cleaned |
| 14.13 | Restore useServeMode | Edit config back to `true` or remove key | Done |

---

## Phase 15 — Serve Mode Observability (#66)

> **Context**: v1.5 enriches `mc_status`, `mc_capture`, and `mc_overview` with structured
> telemetry for serve-mode jobs. `mc_capture` returns JSON events (with `filter` parameter)
> instead of raw terminal text. `mc_status` adds a "Serve Mode Telemetry" section.
> `mc_overview` shows per-job activity indicators (current tool, last activity time).

### 15A: Enriched mc_status

| # | Test | Action | Expected |
|---|------|--------|----------|
| 15.1 | Launch serve job | `mc_launch` name=tmc-obs, prompt="Create file observe.txt with 'testing observability'" | Success with port |
| 15.2 | **Wait 10-15 seconds** | Allow SDK events to accumulate | — |
| 15.3 | Status shows telemetry section | `mc_status` name=tmc-obs | Contains "Serve Mode Telemetry:" with fields: Session State, Current File, Files Edited, Last Activity, Events Accumulated |
| 15.4 | Status shows port and server | `mc_status` name=tmc-obs | Metadata section includes `Port: <N>` and `Server URL: http://...` |

### 15B: Structured mc_capture (Serve Mode)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 15.5 | Capture all events | `mc_capture` name=tmc-obs | Returns **JSON** (not raw text) with fields: `job`, `mode: "serve"`, `status`, `filter: "all"`, `summary`, `events` |
| 15.6 | Verify summary structure | Parse JSON from 15.5 | `summary` has: `totalEvents`, `filesEdited`, `currentTool`, `currentFile`, `lastActivityAt` |
| 15.7 | Capture with file.edited filter | `mc_capture` name=tmc-obs, filter="file.edited" | JSON with `filter: "file.edited"`, events only contain `type: "file.edited"` entries |
| 15.8 | Capture with tool filter | `mc_capture` name=tmc-obs, filter="tool" | JSON with `filter: "tool"`, events only contain `type: "tool"` entries |
| 15.9 | Capture with error filter | `mc_capture` name=tmc-obs, filter="error" | JSON with `filter: "error"`, events array (likely empty for successful work) |

### 15C: Enriched mc_overview

| # | Test | Action | Expected |
|---|------|--------|----------|
| 15.10 | Overview with serve job | `mc_overview` | Running Jobs section shows activity indicator format |
| 15.11 | Verify activity format | Check running job line for tmc-obs | Format: `- tmc-obs | <tool-or-idle> | <time ago> | mc/tmc-obs` (NOT `last report: ...` format used for TUI jobs) |

### 15D: TUI Mode Capture Fallback

| # | Test | Action | Expected |
|---|------|--------|----------|
| 15.12 | Kill serve job | `mc_kill` name=tmc-obs | Stopped |
| 15.13 | Cleanup serve job | `mc_cleanup` name=tmc-obs, deleteBranch=true | Cleaned |
| 15.14 | Set useServeMode=false | Edit config | Done |
| 15.15 | Launch TUI job | `mc_launch` name=tmc-obs-tui, prompt="echo tui observe" | Success, no port |
| 15.16 | **Wait 3-5 seconds** | — | — |
| 15.17 | Capture returns raw text | `mc_capture` name=tmc-obs-tui | Returns **plain text** terminal output (NOT JSON) |
| 15.18 | Status has no telemetry section | `mc_status` name=tmc-obs-tui | No "Serve Mode Telemetry" section |
| 15.19 | Overview uses report format | `mc_overview` | Running job line uses `last report: ...` format (NOT activity indicator format) |
| 15.20 | Cleanup | `mc_kill` name=tmc-obs-tui; `mc_cleanup` name=tmc-obs-tui, deleteBranch=true | Cleaned |
| 15.21 | Restore useServeMode | Edit config back to `true` | Done |

---

## Phase 16 — Session-Aware Notifications & Title Annotations (#74, #75)

> **Context**: v1.5 routes notifications to the session that **launched** the job (via
> `launchSessionID` stored on the job record), not just the current active session.
> Session titles are annotated with job status on completion, failure, or awaiting input.
>
> These features are **observational** during manual testing — they happen automatically
> as jobs complete/fail. Title annotations require the OpenCode SDK session API.

### 16A: launchSessionID Capture

| # | Test | Action | Expected |
|---|------|--------|----------|
| 16.1 | Launch a job | `mc_launch` name=tmc-notify, prompt="echo notify test" | Success |
| 16.2 | **Wait 3-5 seconds** | — | — |
| 16.3 | Verify launchSessionID | Read jobs.json from state dir | tmc-notify has `launchSessionID` field starting with `ses` |
| 16.4 | SessionID matches current | Compare with your active session ID | They match |

### 16B: Notification Routing (Observational)

| # | Test | How to Observe | Expected |
|---|------|----------------|----------|
| 16.5 | Completion notification | Wait for tmc-notify to complete (or kill + let monitor detect) | 🟢 completion notification appears in **this** session |
| 16.6 | Failure notification | Kill a running job: `mc_kill` name=tmc-notify | 🔴 failure notification appears in **this** session (after monitor detects pane death) |

### 16C: Session Title Annotations (Observational)

| # | Test | How to Observe | Expected |
|---|------|----------------|----------|
| 16.7 | Title annotated on completion | After a job completes, check your OpenCode session title (if visible in UI) | Title shows `<jobName> done` |
| 16.8 | Title annotated on failure | After a job fails, check session title | Title shows `<jobName> failed` |
| 16.9 | Multiple annotations | If 2+ jobs complete/fail before title resets | Title shows `N jobs need attention` |
| 16.10 | Title reset on re-entry | Start a new conversation or re-enter the session | Title reverts to original |

> **Note**: Title annotations are fire-and-forget — if the SDK session API is unavailable,
> they silently fail without affecting job execution.

### 16D: Cleanup

| # | Action | Verify |
|---|--------|--------|
| 16.11 | Kill tmc-notify (if still running) | Stopped |
| 16.12 | `mc_cleanup` name=tmc-notify, deleteBranch=true | Cleaned |
| 16.13 | `mc_jobs` | Empty |

---

## Phase 17 — Permission Policy Engine (#69)

> **Context**: v1.5 introduces a permission policy engine that evaluates agent permission
> requests (file edits, shell commands, network access, package installs, MCP tools) against
> configurable policies. The default policy auto-approves inside-worktree operations and
> denies or prompts for outside-worktree operations.
>
> Permission policies are enforced by the question relay during serve-mode execution. Manual
> testing verifies the policy configuration loads correctly and that defaults are sane.
> Full evaluation logic is covered by unit tests (`tests/lib/permission-policy.test.ts`,
> `tests/lib/question-relay.test.ts`).

### 17A: Default Policy Verification

| # | Test | Action | Expected |
|---|------|--------|----------|
| 17.1 | Read default config | Load config and inspect `defaultPermissionPolicy` | Policy object exists with `permissions` key |
| 17.2 | fileEdit inside | Check `permissions.fileEdit.insideWorktree` | `"auto-approve"` |
| 17.3 | fileEdit outside | Check `permissions.fileEdit.outsideWorktree` | `"deny"` |
| 17.4 | shellCommand inside | Check `permissions.shellCommand.insideWorktree` | `"auto-approve"` |
| 17.5 | shellCommand outside | Check `permissions.shellCommand.outsideWorktree` | `"ask-user"` |
| 17.6 | networkAccess | Check `permissions.networkAccess` | `"deny"` |
| 17.7 | installPackages | Check `permissions.installPackages` | `"ask-user"` |
| 17.8 | mcpTools | Check `permissions.mcpTools` | `"auto-approve"` |

### 17B: Custom Policy Override

| # | Test | Action | Expected |
|---|------|--------|----------|
| 17.9 | Set permissive policy | Edit config.json to set `"defaultPermissionPolicy"` with all values as `"auto-approve"` | Config saved |
| 17.10 | Verify permissive loads | Re-read config, check all permission values | All `"auto-approve"` |
| 17.11 | Set restrictive policy | Edit config.json to set all values to `"deny"` | Config saved |
| 17.12 | Verify restrictive loads | Re-read config | All `"deny"` |
| 17.13 | Remove override | Delete `defaultPermissionPolicy` key from config.json | Config falls back to defaults |
| 17.14 | Verify defaults restored | Re-read config | Matches defaults from 17A |

### 17C: Schema Support (Structural)

| # | Test | Action | Expected |
|---|------|--------|----------|
| 17.15 | Plan schema has policy | Inspect `PlanSpecSchema` or a plan.json | `permissionPolicy` field exists on PlanSpec |
| 17.16 | Job schema has policy | Inspect `JobSpecSchema` | `permissionPolicy` field exists on JobSpec |
| 17.17 | Valid decision values | Check `PermissionPolicyDecisionSchema` | Allows: `"auto-approve"`, `"deny"`, `"ask-user"` |

---

## Phase 18 — Dynamic Orchestration (#68)

> **Context**: v1.5 adds four dynamic orchestration capabilities to the plan system:
>
> 1. **Dynamic replanning** — Skip, add, or reorder jobs in a running plan (`skipJob`, `addJob`, `reorderJobs`)
> 2. **Inter-job communication** — Jobs with `relayPatterns` receive findings about matching files from sibling jobs
> 3. **Session forking** — New jobs can fork from an existing job's SDK session (serve mode only)
> 4. **Fix-before-rollback** — On merge train test failure, the failing job's agent gets a chance to fix before full rollback
>
> These are deep integration features. Manual testing covers schema/config verification and
> one synthetic plan test. Full behavioral coverage is in unit tests:
> `tests/lib/orchestrator.test.ts`, `tests/lib/merge-train.test.ts`, `tests/lib/job-comms.test.ts`.

### 18A: Schema & Config Verification

| # | Test | Action | Expected |
|---|------|--------|----------|
| 18.1 | Audit log on plan | Inspect `PlanSpecSchema` | `auditLog` field: array of entries with `timestamp`, `action`, `jobName`, `details`, `userApproved` |
| 18.2 | Audit action types | Check `AuditActionSchema` | Includes: `skip_job`, `add_job`, `reorder_jobs`, `fork_session`, `relay_finding`, `fix_prompted` |
| 18.3 | fixBeforeRollbackTimeout default | Check default config | `fixBeforeRollbackTimeout` = `120000` (2 minutes) |
| 18.4 | relayPatterns on JobSpec | Check `JobSpecSchema` | `relayPatterns` field: optional array of strings |
| 18.5 | Custom timeout | Edit config to set `"fixBeforeRollbackTimeout": 60000` | Config loads correctly |
| 18.6 | Restore timeout | Remove `fixBeforeRollbackTimeout` from config | Defaults restored |

### 18B: Inter-Job Communication Schema

| # | Test | Action | Expected |
|---|------|--------|----------|
| 18.7 | relayPatterns accepted in plan | `mc_plan` name=tmc-plan-relay, mode=supervisor, jobs=[{name: "tmc-relay1", prompt: "echo relay", relayPatterns: ["src/**"]}, {name: "tmc-relay2", prompt: "echo relay2", dependsOn: ["tmc-relay1"]}] | Plan created successfully — relayPatterns accepted without error |
| 18.8 | **Wait 3-5 seconds** | — | — |
| 18.9 | Verify plan status | `mc_plan_status` | Shows both jobs, tmc-relay1 running, tmc-relay2 waiting_deps |
| 18.10 | Cancel plan | `mc_plan_cancel` | Cancelled |
| 18.11 | Cleanup | `mc_cleanup` all=true, deleteBranch=true | Cleaned |

### 18C: launchSessionID in Plans

| # | Test | Action | Expected |
|---|------|--------|----------|
| 18.12 | Create plan | `mc_plan` name=tmc-plan-session, mode=autopilot, jobs=[{name: "tmc-ps1", prompt: "echo session test"}] | Plan created |
| 18.13 | **Wait 5-10 seconds** | — | — |
| 18.14 | Verify launchSessionID on plan | Read `$STATE_DIR/state/plan.json` | Plan has `launchSessionID` field |
| 18.15 | Verify launchSessionID on plan job | Read plan.json, inspect tmc-ps1 job | Job has `launchSessionID` field |
| 18.16 | Cancel and cleanup | `mc_plan_cancel`; `mc_cleanup` all=true, deleteBranch=true | Cleaned |

> **Note**: Full dynamic orchestration testing (skipJob, addJob, reorderJobs in live plans,
> inter-job message delivery, session forking, fix-before-rollback prompting) requires
> multi-agent scenarios with serve-mode jobs making real code changes. These are covered
> deterministically by unit tests:
>
> | Feature | Test File |
> |---------|-----------|
> | skipJob, addJob, reorderJobs | `tests/lib/orchestrator.test.ts` |
> | Fix-before-rollback | `tests/lib/merge-train.test.ts` |
> | Inter-job communication | `tests/lib/job-comms.test.ts` |
> | Session forking | `tests/lib/sdk-client.test.ts` |
> | Permission evaluation | `tests/lib/permission-policy.test.ts` |
> | Question relay + auto-approval | `tests/lib/question-relay.test.ts` |

---

## Results Tracking

| Phase | Description | Total Tests | Pass | Fail | Blocked | Notes |
|-------|-------------|-------------|------|------|---------|-------|
| 0 | Pre-test state snapshot & cleanup | 6 | | | | |
| 1 | Single job lifecycle | 22 | | | | |
| 2 | Error handling & edge cases | 28 | | | | +4 window placement, +11 post-create hooks |
| 3 | Multiple jobs | 14 | | | | +3 status filter tests |
| 4 | Git workflow (sync & merge) | 18 | | | | |
| 5 | Plan orchestration | 81 | | | | +47 touchSet enforcement (5G: detect, accept, relaunch, retry, mutual exclusion) |
| 6 | Realistic multi-job (overlap/conflict) | 49 | | | | |
| 7 | Model verification | 12 | | | | +3 model ID, prompt file, model match |
| 8 | mc_report flow | 54 | | | | +17 deterministic injection (replaced 21 non-deterministic) |
| 9 | mc_overview dashboard | 16 | | | | |
| 10 | OMO plan mode | 10 | | | | |
| 11 | Hooks (observational) | 5 | | | | |
| 12 | Final verification & nuclear cleanup | 8 | | | | Run LAST after Phases 13–18 |
| 13 | Serve mode launch & port management | 24 | | | | v1.5: port allocation, serve launch, TUI fallback |
| 14 | Enhanced mc_attach | 13 | | | | v1.5: tmux window for serve, backward compat for TUI |
| 15 | Serve mode observability | 21 | | | | v1.5: structured capture, telemetry status, activity overview |
| 16 | Session-aware notifications & title annotations | 13 | | | | v1.5: launchSessionID routing, title annotations (observational) |
| 17 | Permission policy engine | 17 | | | | v1.5: default policy, custom override, schema support |
| 18 | Dynamic orchestration | 16 | | | | v1.5: audit log, relay patterns, session IDs in plans |
| **Total** | | **427** | | | | +104 v1.5 tests |

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
11. **TouchSet testing on feature branches**: When running Phase 5G on a non-main branch, job worktrees inherit the feature branch's uncommitted changes. TouchSet validation compares the job branch against the integration branch, so feature branch source files show up as spurious violations alongside the actual test violations (e.g., `rogue.txt`). This is a testing artifact — in production, both branches share the same base so only the job's own changes appear.
12. **Port exhaustion (v1.5)**: The default port range is 14100–14199 (100 ports). If cleanup fails to release ports, the `port.lock` file accumulates stale entries. Symptoms: "No available ports" error on launch. Fix: delete `port.lock` from the state directory.
13. **Serve-mode server leak (v1.5)**: If `mc_kill` or `mc_cleanup` fails to terminate the `opencode serve` process, ports stay bound. Symptoms: next launch on the same port fails. Fix: `lsof -ti:14100-14199 | xargs kill` or use the Nuclear Cleanup script.
14. **SDK availability (v1.5)**: Serve-mode tests (Phases 13–15) require `@opencode-ai/sdk` to be installed and the OpenCode serve endpoint to be functional. If the SDK is not available, serve-mode launches will fail at the "waiting for server" step — this is expected, not a plugin bug.
15. **Title annotation timing (v1.5)**: Session title annotations (Phase 16) are fire-and-forget. If the SDK session API is slow or the session has already been compacted, annotations may not appear. A missing annotation is not a test failure — check the decision log in unit tests instead.
16. **Permission policy non-determinism (v1.5)**: Permission evaluation during live agent execution depends on the agent triggering permission prompts (file edits, shell commands). Simple test prompts may not trigger any prompts at all, making live permission testing unreliable. Unit tests are the source of truth for policy evaluation logic.

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
| Permission policy (v1.5) | **PASSIVE** | Policy governs what the question relay auto-approves/denies for the agent, but the agent itself doesn't see or control the policy |
| Inter-job comms (v1.5) | **PASSIVE** | Agents with `relayPatterns` receive relay messages as injected prompts — they don't initiate comms |
| Serve-mode SDK (v1.5) | **INDIRECT** | Agent runs in `opencode serve` — prompts arrive via SDK, not stdin. Agent is unaware of the difference. |

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

| Mechanism | Mode | How It Detects | Resulting State |
|-----------|------|---------------|-----------------|
| Polling (10s interval) | TUI | Checks if tmux pane is alive | `running` -> `completed` or `failed` |
| Pane-died hook | Both | tmux fires when pane closes | Immediate state update with exit code |
| Idle detection (5min) | TUI | Output hash unchanged + idle prompt visible | `running` -> `completed` |
| Exit code 0 | TUI | Normal pane death | `completed` |
| Exit code non-zero | TUI | Error pane death | `failed` |
| SSE event subscription (v1.5) | Serve | SDK subscribes to server-sent events from `opencode serve` | Real-time tool/file tracking via event accumulator |
| Event accumulator (v1.5) | Serve | Tracks `filesEdited`, `currentTool`, `currentFile`, `lastActivityAt`, `eventCount` | Powers enriched `mc_status`, `mc_capture`, `mc_overview` |
| Question relay (v1.5) | Serve | Intercepts permission requests from SSE events | Auto-approves (inside worktree) or relays to launching session |
| Permission policy (v1.5) | Serve | Evaluates permission requests against configured policy | `auto-approve`, `deny`, or `ask-user` per request type |

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
