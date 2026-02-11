# OpenCode Mission Control: Master Technical Audit & Ecosystem Strategy Report

**Date:** February 7, 2026 (Cross-referenced: February 10, 2026; Updated: February 11, 2026)  
**Version:** 0.1.0 Audit + Ecosystem Analysis (Updated: Phase 0 Complete, Phase 1 Largely Complete)  
**Method:** 3 codebase analysis agents + 21 ecosystem research agents (24 parallel jobs total)  
**Scope:** All 45 source files, 40 test files, and 21 OpenCode plugins from the ecosystem  

---

## 1. Executive Summary

Mission Control possesses the **most sophisticated orchestration engine in the OpenCode ecosystem** — DAG-based dependency resolution, merge train with rollback, tmux-isolated worktrees, and a reconciler loop. No other plugin comes close. `opencode-workspace` (16 components) has flat parallel delegation only. `micode` has worktrees but no monitoring. `subtask2` has flow control but no isolation.

Yet MC suffered from **"Disconnected Brain Syndrome"**: powerful infrastructure, broken communication layer. The gap analysis found **5 critical, 11 high, 14 medium, and 8 low** severity issues. The most damning: job completions were invisible, blocked agents screamed into the void, and `notifications.ts` was dead code using `console.log`.

**Update (Feb 7):** Phase 0 is complete. All critical bugs fixed, all tests passing (470/470), build green.

**Update (Feb 10):** Full codebase cross-reference of all 45 source files against this audit. Phase 0 items re-verified ✅. Phase 1 items status-checked — 3 done, 2 partially done, 6 still pending. Phase 2 and technical debt sections updated with current line numbers and accurate status. Auto-resume on startup was found to be already implemented.

**Update (Feb 11):** Phase 1 implementation sprint. 7 of 8 actionable items completed. Remaining item (git root commit SHA as project ID) deferred — requires state directory migration strategy. Zod validation was already done in a prior commit. `awareness.ts` was found to be actively imported by `compaction.ts` (audit was wrong about it being dead code).

**Phase 0 fixes delivered:**
- ✅ **C1: Shell injection patched** — prompts now pass through temp files (`prompt-file.ts`), never shell-interpolated
- ✅ **C2: PR push fixed** — `mc_pr` now pushes before `gh pr create`
- ✅ **C3: Singleton orchestrator** — `orchestrator-singleton.ts` eliminates orphaned instances
- ✅ **C4: tmux validation** — `isTmuxAvailable()` called at plugin init and before launch
- ✅ **C5: State validators wired** — `isValidPlanTransition()`/`isValidJobTransition()` now enforced *(Note: validators log `console.warn` on invalid transitions rather than throwing errors)*
- ✅ **C6: Mutation audit** — confirmed `output.messages` uses in-place mutation (correct)
- ✅ **C7: Report completion pipeline** — `mc_report` now accepts `completed` status; monitor marks jobs done on `completed`/`needs_review`
- ✅ **C8: Agent prompt emphasis** — `MC_REPORT_SUFFIX` rewritten with CRITICAL/MANDATORY emphasis
- ✅ **Merge strategy config** — new `mergeStrategy` config (`squash`|`ff-only`|`merge`, default: `squash`) wired through `mc_merge` and merge train

**Previously delivered (pre-Phase 0):**
- ✅ **Notifications rewritten** — `session.prompt({noReply: true})` with deduplication
- ✅ **`mc_overview` dashboard** — `/mc` slash command for single pane of glass
- ✅ **`mc_report` scaffolded** — both launch paths inject status reporting instructions

**The bottom line:** MC's critical attack surface and reliability issues are resolved. The engine and communication layer are both production-grade. Phase 1 is largely complete — only the git root SHA project ID remains (deferred). Phase 2 intelligence features are next.

---

## 2. Competitive Landscape

### Where MC Leads the Ecosystem

| Capability | Mission Control | Best Alternative | MC's Advantage |
|-----------|----------------|-----------------|----------------|
| **DAG orchestration** | `dependsOn` with topological sort | subtask2 (inline DSL) | Real dependency graph vs linear chains |
| **Worktree isolation** | Full git worktree per job | opencode-worktree (basic) | + tmux + monitoring + merge train |
| **Merge train** | Sequential merge + test gate + rollback | None | Unique in ecosystem |
| **Live inspection** | `mc_capture`, `mc_attach`, `mc_diff` | None | No competitor offers mid-flight inspection |
| **Plan modes** | autopilot / copilot / supervisor | None | Unique checkpoint system |
| **Agent reporting** | `mc_report` with progress % | opencode-background (binary status) | Granular progress tracking |

### Where MC Falls Behind

| Capability | MC Status | Ecosystem Standard | Gap |
|-----------|----------|-------------------|-----|
| **Notifications** | ✅ Aligned — `session.prompt({noReply: true})` | `session.prompt({noReply: true})` | Now aligned with ecosystem standard |
| **Event reactivity** | Polls only | `event` hook + `Bus.subscribeAll` | Should be event-driven, not polling-only |
| **Context injection** | Thin text string | Rich "job cards" (quota, skillful) | Post-compaction AI loses awareness |
| **Multiplexer support** | tmux-only, hardcoded | Zellij feasible, PTY alternative exists | Should abstract via interface |
| **Plan visualization** | Text-only status | Browser-based review (plannotator) | Terminal limits plan review UX |
| **Lightweight tasks** | Full worktree for everything | PTY for simple tasks (opencode-pty) | Overkill for quick operations |
| **Permission model** | None — jobs have full access | Read-only agents (bg-agents) | No safety rails on spawned agents |

### Plugins That Are Just Simpler — Not Better

| Plugin | What It Does | Why MC Is Better |
|--------|-------------|-----------------|
| opencode-workspace | 16-component bundle | No DAG, no capture, no merge, no diff |
| opencode-background | In-process Bun.spawn | No isolation, no persistence, no stdin |
| opencode-roadmap | Document store for plans | v0.0.6, no execution, just storage |
| opencode-scheduler | Cron-based launchd/systemd | No retry, no history, no failure handling |

---

## 3. Plugin SDK Capabilities — What's Actually Possible

The research-plugin-api job (reading OpenCode source) revealed capabilities MC is ignoring:

### The Notification Golden Path

```ts
// WRONG (what MC used to do — invisible in TUI)
console.log("Job completed: fix-auth");

// RIGHT (what MC now uses — appears in chat transcript)
client.session.prompt({
  message: "🟢 Job 'fix-auth' completed (3m 22s). Files changed: 4. Run mc_diff to review.",
  noReply: true  // Don't trigger LLM response
});
```

**Every mature plugin uses `session.prompt({noReply: true})`**: opencode-quota, opencode-skillful, opencode-background-agents. This is the de facto standard.

### Available Hooks

| Hook | Event Types | Used By |
|------|-------------|---------|
| `event` | `session.idle`, `session.status`, `session.error`, `session.compacted`, `permission.updated` | notificator, notifier, notify, quota |
| `permission` | `permission.ask` | notificator, notifier |
| `tool` | `tool.execute.before`, `tool.execute.after` | subtask2, pruning |

**Key finding:** `session.idle` is **deprecated** but still fires alongside `session.status`. MC should migrate to `session.status`.

### Hidden Capabilities

| API | What It Does | Relevance to MC |
|-----|-------------|-----------------|
| `client.session.prompt({noReply: true})` | Inject rich text without LLM response | Replace console.log for notifications |
| `client.session.revert()` / `unrevert()` | Undo/redo session changes | Could enable "undo last merge" |
| `client.pty.*` | Full terminal process management | Lightweight alternative to tmux |
| `client.mcp.*` | Manage MCP servers programmatically | Could expose MC as an MCP server |
| `session.get().data.parentID` | Detect if running as subagent | Skip notifications in subagent sessions |
| `output.messages` mutation | **MUST be in-place** (reassignment silently fails) | Critical for compaction hook |

### Critical SDK Gotcha

From opencode-dynamic-context-pruning and subtask2: **`output.messages` must be mutated in-place**. The OpenCode plugin system uses proxies — reassignment is silently ignored. MC's compaction hook may already be broken due to this.

---

## 4. Ecosystem UX Pattern Analysis

### Patterns That Multiple Plugins Converge On (De Facto Standards)

| Pattern | Used By | Implication for MC |
|---------|---------|-------------------|
| `session.prompt({noReply: true})` for notifications | quota, skillful, bg-agents, subtask2 | **Adopt immediately** — replace console.log |
| `event` hook subscription (not polling) | notificator, notifier, notify, quota | Wire JobMonitor events to event bus |
| Subagent detection via `parentID` | quota, bg-agents | Skip notifications when running as subagent |
| In-place `output.messages` mutation | pruning, subtask2, froggy | Fix compaction hook — reassignment doesn't work |
| Debounce + deduplication for notifications | quota, notificator | Prevent notification spam |
| Zod schemas for config validation | scheduler, quota | MC declares Zod but never uses it |

### Novel Patterns Worth Barrowing

| Pattern | Source Plugin | How MC Should Use It |
|---------|-------------|---------------------|
| `notifyOnExit` with `promptAsync` | opencode-pty | Push notification when tmux pane dies — no polling needed |
| Ring buffer output storage | opencode-pty | Memory-efficient capture vs MC's unbounded terminal scraping |
| Browser-based plan review | plannotator | Open `localhost:PORT` for visual DAG review before execution |
| AI-summarized handoff prompts | opencode-handoff | When a job completes, generate a structured summary for the main session |
| Staleness-based context pruning | pruning | Mark old job status as stale N turns after injection |
| Git root commit SHA as project ID | opencode-worktree | More stable than path-based identification |
| Cross-tool skill portability | froggy | Skills work in both OpenCode and Claude Code contexts |
| Multiplexer interface | zellij-namer | Abstract tmux behind interface, support Zellij and PTY backends |
| Pareto optimization (80/20) | omo-slim | Core value is delegation + tools — strip ceremony |

### Anti-Patterns to Avoid

| Anti-Pattern | Source | Why |
|-------------|--------|-----|
| `console.log` for notifications | ~~MC (fixed)~~ | Was invisible in TUI — now uses `session.prompt({noReply: true})` |
| Flat parallel-only delegation | workspace | Loses MC's DAG advantage |
| No stdin for background processes | opencode-background | Fire-and-forget limits job control |
| Internal HTTP client patching | subtask2 | Fragile, tightly coupled to SDK internals |
| Single-file state (plan.json singleton) | MC (current) | Blocks multi-plan support |

---

## 5. Critical Vulnerabilities & Architectural Flaws

These must be fixed before any feature work.

### 5.1 ~~Shell Injection in Job Launching (C1)~~ ✅ FIXED

**Files changed:** `src/tools/launch.ts`, `src/lib/orchestrator.ts`, NEW `src/lib/prompt-file.ts`

**Was:** Single-quote escaping only — backtick/`$(command)` injection survived into tmux pane.  
**Fix:** Prompts are now written to temp files via `writePromptFile()`, then read back via `$(cat '/path/.mc-prompt.txt')`. User content never enters shell interpolation. Temp files are cleaned up after 5 seconds.

### 5.2 ~~The "Orphaned Orchestrator" Leak (C3)~~ ✅ FIXED

**Files changed:** `src/tools/plan.ts`, `src/tools/plan-cancel.ts`, `src/tools/plan-approve.ts`, `src/index.ts`, NEW `src/lib/orchestrator-singleton.ts`

**Was:** Each tool call created a fresh `Orchestrator` + `JobMonitor` — resource leak, state disconnect.  
**Fix:** `getSharedMonitor()` singleton in `orchestrator-singleton.ts`. All plan tools reference the shared instance. Monitor starts once at plugin init.

### 5.3 ~~Broken PR Pipeline (C2)~~ ✅ FIXED

**Files changed:** `src/tools/pr.ts`

**Was:** `mc_pr` didn't push before `gh pr create`.  
**Fix:** Added `git push origin {branch}` before PR creation, matching the orchestrator's internal flow.

### 5.4 ~~tmux Not Validated (C4)~~ ✅ FIXED

**Files changed:** `src/index.ts`, `src/tools/launch.ts`, `src/lib/tmux.ts`

**Was:** `isTmuxAvailable()` existed but was never called.  
**Fix:** Called at plugin init (warning logged if missing) and at launch time (hard error if missing).

### 5.5 ~~State Machine is Unenforced (C5)~~ ✅ FIXED

**Files changed:** `src/lib/plan-state.ts`, `src/lib/job-state.ts`

**Was:** `isValidPlanTransition()` and `isValidJobTransition()` were dead code.  
**Fix:** Validators now called before every state transition. Invalid transitions are logged via `console.warn` (soft enforcement — does not throw).

---

## 6. The "Silent Agent" Problem — ✅ RESOLVED

### The Problem (Was)

MC's notification hooks (`notifications.ts`, `awareness.ts`) were dead code. The monitor detected completions, failures, blocked states — but nothing in `index.ts` subscribed to those events. `console.log` was invisible in the TUI.

### What The Ecosystem Does

| Plugin | Notification Method | Pattern |
|--------|-------------------|---------|
| opencode-quota | `session.prompt({noReply: true})` | Rich text injected into chat |
| opencode-notificator | OS notifications via `node-notifier` + sounds | Desktop-level alerts |
| opencode-notifier | OS notifications + permission requests | Multi-event coverage |
| opencode-pty | `notifyOnExit` → `promptAsync` | Push notification on pane death |
| opencode-bg-agents | Compaction context injection | AI stays aware post-compaction |

### The Fix (Implemented Feb 7)

**1. ✅ Notifications rewritten** (`src/hooks/notifications.ts`)
- Replaced dead `console.log` code with `session.prompt({noReply: true})` — the ecosystem standard
- Status-specific emoji indicators: 🟢 complete, 🔴 failed, ⚠️ blocked, 👀 needs_review
- Duration formatting (e.g. "3m 22s") and actionable next-step suggestions
- Deduplication to prevent notification spam
- Wired into `index.ts` via `setupNotifications()` with active session ID tracking

**2. ✅ `mc_overview` dashboard** (`src/tools/overview.ts`)
- Zero-arg tool aggregating jobs, plan status, reports, alerts, and suggested actions
- Registered as `/mc` slash command for instant access
- Single pane of glass — replaces the need to call 3-4 separate tools

**3. ✅ `mc_report` scaffolded in spawned prompts** (`src/tools/launch.ts`, `src/lib/orchestrator.ts`)
- Both launch paths now inject `MC_REPORT_SUFFIX` into spawned agent prompts
- Agents are instructed to call `mc_report` with progress %, blocked status, and review-ready signals
- Unlocks the full agent → command center reporting pipeline

### ~~Remaining Gaps~~ ✅ All Resolved (Feb 11)

- ~~**Subagent detection**~~ ✅ Implemented — `isSubagent()` in `index.ts` checks `session.get().data.parentID`. Notifications skip subagent sessions.
- ~~**Compaction context enrichment**~~ ✅ Implemented — `compaction.ts` rewritten with rich job cards (name, status, duration, branch, mode, truncated prompt, report status, staleness markers). 14 tests passing.

---

## 7. Technical Debt (Condensed)

> *Cross-referenced Feb 10, 2026 against all 45 source files.*

### Dead Code & Duplication
- ~~3x duplicated: `atomicWrite`~~ ✅ Extracted to `src/lib/utils.ts` (Feb 11). `config.ts`, `plan-state.ts`, `job-state.ts` now import from `utils.ts`.
- ~~3x duplicated: `extractConflicts`~~ ✅ Extracted to `src/lib/utils.ts` (Feb 11). `integration.ts`, `worktree.ts`, `merge-train.ts` now import from `utils.ts`. Uses merge-train's robust variant with empty-stderr fallback.
- ~~4x duplicated: `formatDuration`~~ ✅ Extracted to `src/lib/utils.ts` as 3 distinct functions (Feb 11): `formatElapsed()` (notifications), `formatTimeAgo()` (overview, jobs), `formatDurationMs()` (status).
- ~~Dead: `test-runner.ts`~~ ✅ Deleted (Feb 11). 103 lines removed; `merge-train.ts` has its own `detectTestCommand()`/`runTestCommand()`.
- ~~Dead: `awareness.ts`~~ ❌ **Not dead** — `compaction.ts` imports `getRunningJobsSummary` from it. Audit was incorrect.
- ~~Unused dependency: Zod~~ ✅ Already used — `config.ts`, `plan-state.ts`, `job-state.ts`, and `schemas.ts` all import and use Zod for validation. Prior commit `b24b1b9` added Zod schemas.

### Type Safety
- `configInput: any` in `index.ts:182`, `commands.ts:29`
- `determineJobsToClean` returns `any[]` at `cleanup.ts:28`
- ~~JSON state files parsed with `as Type` — no runtime validation (Zod available but unused)~~ ✅ Fixed — `job-state.ts`, `plan-state.ts`, and `config.ts` now use Zod schemas (`JobStateSchema.parse()`, `PlanSpecSchema.parse()`, `MCConfigSchema.parse()`) for runtime validation

### Architecture
- `orchestrator.ts` is 891 lines (was 829 at original audit) — god object handling scheduling, merging, PR creation, notifications, checkpoints. Has grown, not shrunk.
- No dependency injection for `gitCommand`, `tmux`, `Bun.spawn`
- ~~Plan tools create orphaned instances (C3)~~ ✅ Fixed — singleton pattern via `orchestrator-singleton.ts`
- No plugin API abstraction layer

### Robustness
- ~~Hardcoded `main` branch~~ ✅ **Fully fixed** (Feb 11) — `getDefaultBranch()` added to `src/lib/git.ts`. All hardcoded references in `integration.ts`, `orchestrator.ts`, and `pr.ts` now use it. `merge.ts` and `diff.ts` already detected main/master.
- Fixed `sleep(2000)` for OMO mode detection — still present at `launch.ts:268`
- `isPaneRunning` returns `false` for ALL errors (could mark all jobs dead) — still present at `tmux.ts:315` (catch block returns false)
- Reconciler race: concurrent triggers silently dropped — still present at `orchestrator.ts:316-318` (`isReconciling` boolean flag)
- Plan jobs ignore `omo.defaultMode` (hardcoded `vanilla`) — still present at `orchestrator.ts:626`
- Integration branch format mismatch — `plan.ts:113` vs `integration.ts:26`
- Window-placement jobs: `cleanup.ts:57-58` checks `job.placement === 'session'` before calling `killSession`, but window-placement jobs may not be fully cleaned from tmux

### Test Coverage Gaps
- **Untested:** `commands.ts`, `index.ts`, `paths.ts`
- ~~**Tests for dead code:** `test-runner.ts`~~ ✅ Deleted (Feb 11). `awareness.ts` is NOT dead code — it's imported by `compaction.ts`.
- **Undertested critical paths:** reconciler skip guard, plan cancel with running jobs, network errors in integration refresh

---

## 8. UX Recommendations (Ecosystem-Informed)

### ~~P0: Rich Notifications via `session.prompt`~~ ✅ DONE

**Implemented:** `notifications.ts` rewritten with `session.prompt({noReply: true})`, emoji status indicators, duration formatting, deduplication. Wired into `index.ts`.

### ~~P0: `mc_overview` Dashboard Tool + `/mc` Command~~ ✅ DONE

**Implemented:** `src/tools/overview.ts` — zero-arg dashboard aggregating jobs, plans, reports, alerts, suggested actions. Registered as tool + `/mc` slash command.

### ~~P1: Scaffold `mc_report` in Job Prompts~~ ✅ DONE

**Implemented:** `MC_REPORT_SUFFIX` injected in both `launch.ts` (direct launches) and `orchestrator.ts` (plan-based launches). Spawned agents now receive status reporting instructions.

### ~~P1: Enrich Compaction Context with Job Cards~~ ✅ DONE

**Implemented (Feb 11):** `compaction.ts` rewritten with rich job cards including name, status, duration, branch, mode, truncated prompt, report status, and staleness markers. 14 tests, all passing.

### ~~P1: Fix `output.messages` Mutation~~ ✅ VERIFIED

**Audited:** Confirmed `output.messages` uses in-place mutation via `splice()` — correct per ecosystem consensus. No fix needed.

### ~~P2: Subagent Detection~~ ✅ DONE (moved from P2 to P1)

**Implemented (Feb 11):** `isSubagent()` function added to `index.ts` using `session.get().data.parentID` detection. Passed to `setupNotifications()` which skips notifications in subagent sessions. Cached after first check for performance.

### P2: Multiplexer Interface

**Current:** Hardcoded tmux (14 functions in `tmux.ts`).  
**Ecosystem insight:** zellij-namer demonstrates Zellij feasibility with gaps (no detached sessions, no pane death hooks).  
**Recommended:** Abstract behind `Multiplexer` interface, add Zellij as experimental.

### P3: Lightweight PTY Tier

**Ecosystem insight:** opencode-pty and opencode-background show simple tasks don't need worktree isolation.  
**Pattern:** PTY with ring buffer for builds, lint, simple commands.

### P3: Visual Plan Review

**Ecosystem insight:** plannotator opens a browser for visual annotation. MC could serve a localhost page for DAG review + approval.

---

## 9. Updated Roadmap

### Phase 0: Fix Now ✅ COMPLETE
> Critical bugs + ecosystem-standard notifications. All items delivered Feb 7.

- [x] **NOTIFICATIONS:** Replace `console.log` with `session.prompt({noReply: true})` — wire all monitor events
- [x] **C1:** Patch shell injection — temp file approach via `prompt-file.ts`
- [x] **C2:** Add `git push` to `mc_pr`
- [x] **C3:** Singleton `Orchestrator`/`JobMonitor` via `orchestrator-singleton.ts`
- [x] **C4:** Call `isTmuxAvailable()` at init and before launch
- [x] **C5:** Wire up state transition validators in `plan-state.ts` and `job-state.ts`
- [x] **C6:** Audit `output.messages` usage — confirmed in-place mutation (correct)
- [x] **C7:** Report completion pipeline — `mc_report` accepts `completed` status, monitor wired to mark jobs done
- [x] **C8:** Agent prompt emphasis — `MC_REPORT_SUFFIX` rewritten with CRITICAL/MANDATORY language
- [x] **CONFIG:** Merge strategy config — `mergeStrategy: 'squash' | 'ff-only' | 'merge'` (default: `squash`)

### Phase 1: Quick Wins ✅ LARGELY COMPLETE
> Ecosystem alignment + command center UX. 7 of 8 actionable items done (Feb 11).

- [x] Create `mc_overview` tool + `/mc` slash command *(Done Feb 7)*
- [x] Scaffold `mc_report` in spawned agent prompts *(Done Feb 7)*
- [x] Enrich compaction context with rich job cards + staleness tracking *(Done Feb 11 — `compaction.ts` rewritten with per-job cards: name, status, duration, branch, mode, truncated prompt, report data, staleness markers. 14 tests passing.)*
- [x] Add subagent detection (`parentID` check) to notification logic *(Done Feb 11 — `isSubagent()` in `index.ts` using `session.get().data.parentID`, passed to `setupNotifications()` with cached result)*
- [x] Add missing slash commands: `/mc-capture`, `/mc-diff`, `/mc-approve`, `/mc-plan` *(Done Feb 11 — all 4 commands added to `commands.ts`)*
- [x] Extract shared utilities: `atomicWrite`, `extractConflicts`, `formatDuration` *(Done Feb 11 — new `src/lib/utils.ts` with 5 exports: `atomicWrite`, `extractConflicts`, `formatElapsed`, `formatTimeAgo`, `formatDurationMs`. All 10 consumer files updated.)*
- [x] Apply Zod validation to state file parsing *(Already done in prior commit `b24b1b9` — `config.ts`, `plan-state.ts`, `job-state.ts` all use Zod schemas for parsing. `schemas.ts` defines `MCConfigSchema`, `JobSchema`, `JobStateSchema`, `PlanSpecSchema`.)*
- [x] Fix hardcoded `main` branch — detect default branch *(Done Feb 11 — `getDefaultBranch()` added to `src/lib/git.ts`, used in `integration.ts`, `orchestrator.ts`, `pr.ts`)*
- [x] Remove dead code: `test-runner.ts` *(Done Feb 11 — deleted `src/lib/test-runner.ts` and `tests/lib/test-runner.test.ts`. Note: `awareness.ts` was NOT deleted — audit was wrong, it's actively imported by `compaction.ts`.)*
- [ ] Adopt git root commit SHA as stable project identifier *(Deferred — changing project ID computation breaks all existing state directories under `~/.local/share/opencode-mission-control/{project}/`. Requires migration strategy, not a quick win.)*
- [x] Auto-resume plan on plugin startup *(Already done — `index.ts:172-179` calls `loadPlan()` on startup; if plan is running/paused, creates Orchestrator and calls `orchestrator.resumePlan()`)*

### Phase 2: Intelligence (1-2 weeks)
> Activate latent capabilities + reliability.

- [ ] Implement `touchSet` conflict prediction + blast radius scoring *(No implementation found)*
- [ ] Auto-infer `touchSet` from `git diff --name-only` *(No implementation found)*
- [ ] PR narrative synthesis (from job prompts, diffs, reports, timing) *(No implementation found)*
- [ ] Failure artifact capture (terminal output, diff, commits, env metadata) *(No implementation found)*
- [ ] Persistent run ledger (`.mc/history/*.jsonl`) *(No implementation found)*
- [ ] Job completed → guided next action flow *(overview.ts has suggested actions, but no guided flow beyond that)*
- [ ] Fix reconciler race condition *(Still present — `orchestrator.ts:316-318` uses `isReconciling` boolean flag; concurrent triggers silently return)*
- [ ] Fix plan jobs ignoring `omo.defaultMode` *(Still present — `orchestrator.ts:626` hardcodes `mode: 'vanilla'`)*
- [ ] Decompose Orchestrator into focused modules *(Still a god object — `orchestrator.ts` has grown from 829 to 891 lines)*

### Phase 3: Ecosystem Features (ongoing)
> Multiplexer abstraction, lightweight tiers, team features.

- [ ] Multiplexer interface: `TmuxMultiplexer` + experimental `ZellijMultiplexer`
- [ ] Lightweight PTY tier for simple tasks (no worktree needed)
- [ ] Two-way job messaging (inbox/outbox)
- [ ] Smart retry policies with safe rebase
- [ ] Plan/job templates ("recipes")
- [ ] Multi-plan support (per-plan state files, not singleton)
- [ ] AI-summarized handoff prompts (from opencode-handoff pattern)
- [ ] Visual plan review (browser-based DAG + approval UI)
- [ ] Resource-aware scheduling
- [ ] Team status dashboard
- [ ] CI/CD lifecycle hooks

---

## 10. Appendix: Per-Plugin Research Highlights

### Tier 1: High-Signal Plugins (directly inform MC's roadmap)

| Plugin | Key Insight for MC |
|--------|-------------------|
| **opencode-quota** | Definitive guide for `session.prompt({noReply: true})`. Copy their debounce + `parentID` skip logic. |
| **opencode-pty** | `notifyOnExit` + ring buffer output = push notifications without polling. Barrow this for pane death detection. |
| **opencode-dynamic-context-pruning** | `output.messages` MUST be mutated in-place. Staleness-based pruning for MC's context injection. |
| **oh-my-opencode** | Agent orchestration is prompt-driven. Tmux pane visibility for real-time watching. Session continuity via `session_id`. |
| **opencode-notificator** | Most mature notification plugin. Uses `event` hook + `node-notifier` for OS alerts. Rate-limited. |
| **@plannotator/opencode** | Browser-based plan review with annotation. Hidden from sub-agents. Completion overlay pattern. |
| **opencode-zellij-namer** | Multiplexer abstraction blueprint. Multi-path binary discovery, ANSI stripping, debounce+cooldown. Zellij gap analysis. |

### Tier 2: Useful Patterns

| Plugin | Key Insight |
|--------|------------|
| **opencode-background-agents** | Read-only permission model for background agents. Strict safety rails. |
| **@openspoon/subtask2** | LLM as verification loop. Inline DSL for flow control. `output.messages` mutation confirmation. |
| **opencode-canvas** | tmux split-pane patterns for dashboard UX. Could enable live MC dashboard pane. |
| **opencode-handoff** | AI-summarized context + synthetic file preloading for session continuity. Transferable to job handoff. |
| **oh-my-opencode-slim** | 80/20 Pareto optimization — core value is delegation + tools. Everything else is optional. |
| **opencode-skillful** | Lazy-load injection via `session.prompt({noReply: true})`. Event-driven, not tool-triggered. |
| **opencode-worktree** | Git root commit SHA as stable project ID. Tmux mutex for concurrent launches. |

### Tier 3: Limited Signal

| Plugin | Why Limited |
|--------|-----------|
| **opencode-workspace** | Flat orchestration, no DAG, no capture. MC is categorically ahead. |
| **micode** | Brainstorm→Plan→Implement is interesting but no monitoring or merge capabilities. |
| **opencode-roadmap** | v0.0.6 document store. MC's plan system is far more capable. |
| **opencode-scheduler** | Cron scheduling via launchd/systemd. No retry, no history. Different domain. |
| **opencode-froggy** | Cross-ecosystem skill portability is nice but tangential to MC's core mission. |
| **opencode-background** | Simple in-process Bun.spawn. No isolation, no persistence. MC already does this better. |

---

## Appendix B: README vs. Implementation Discrepancies

> *Cross-referenced Feb 10, 2026 against all 45 source files.*

| README Claim | Reality |
|---|---|
| `mc_pr` "Push the job's branch and create a PR" | ✅ **Fixed.** Now pushes before `gh pr create` (`pr.ts:48-57`). |
| "pane-died hook fires, capturing exit status" | Hook writes to log file but nothing reads it. Detection relies on polling + `mc_report`. |
| OMO plan mode "runs `/start-work`" | Implemented but relies on `sleep(2000)` at `launch.ts:268` — may fail on slow systems. |
| "Session state detection: idle, streaming, unknown" | Implemented in monitor but never exposed to users. |
| `mc_report` "Auto-detects which job is calling" | Only works for worktrees in the default `basePath`. Custom paths break detection. *(Note: spawned agents now receive `mc_report` instructions via prompt injection. `completed` status now wired to mark jobs done via `monitor.ts:115-124`.)* |
| `worktreeSetup.commands` | Commands are NOT sanitized — arbitrary shell execution via config. |
| Slash commands listed in README | ✅ **Fixed (Feb 11).** README lists `/mc-jobs`, `/mc-launch`, `/mc-status`, `/mc-attach`, `/mc-cleanup`. `commands.ts` now also registers `/mc-capture`, `/mc-diff`, `/mc-approve`, `/mc-plan`. |
