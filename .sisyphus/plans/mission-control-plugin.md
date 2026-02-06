# Mission Control Plugin for OpenCode

## TL;DR

> **Quick Summary**: Build a standalone OpenCode plugin (`opencode-mission-control`) that enables parallel AI coding sessions in isolated git worktrees, managed via tmux. Uses the `@opencode-ai/plugin` SDK with Zod-based tool definitions and OpenCode event hooks. Works with vanilla OpenCode; unlocks enhanced modes when Oh-My-OpenCode (OMO) is detected. Published to npm under the `opencode-mission-control` package name.
> 
> **Deliverables**:
> - Complete OpenCode plugin at `~/development/opencode-mission-control/`
> - GitHub repo at `nigel-dev/opencode-mission-control` (public)
> - 11 plugin tools registered via `tool()` helper from `@opencode-ai/plugin`
> - Plugin hooks using OpenCode event system (`session.idle`, `experimental.session.compacting`, etc.)
> - tmux integration with session/window placement options
> - OMO integration for plan-based execution modes
> - npm-ready package with proper publishing configuration
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 7 waves
> **Critical Path**: Task 0 (scaffold + GitHub repo) → Tasks 1-4 (foundation) → Tasks 5-11 (core tools) → Task 24 (plugin entry)

---

## Context

### Original Request
Build a "Mission Control" plugin for OpenCode that allows running multiple AI coding sessions in parallel, each in its own git worktree, managed through tmux.

### Interview Summary
**Key Discussions**:
- **Platform support**: Mac/Linux only (Windows users can use WSL; tmux doesn't run natively on Windows)
- **Job model**: Strict 1:1:1 (one job = one worktree = one tmux session/window)
- **Job completion detection**: Hybrid approach - tmux `pane-died` hooks for instant detection + polling fallback
- **OMO detection**: Via `opencode.json` config parsing (check plugin array for "oh-my-opencode")
- **tmux placement**: User's choice - `session` (default, safe) or `window` (integrated tabs)
- **Plan handling**: Copy entire `.sisyphus/plans/` directory to worktree (not state.json or boulder.json)

**Research Findings**:
- tmux supports `pane-died` and `session-closed` hooks for completion detection
- Worktrees provide perfect isolation for parallel work
- **OpenCode plugins use `@opencode-ai/plugin` SDK** (NOT `@modelcontextprotocol/sdk`):
  - Plugin is an async function of type `Plugin` that returns a `Hooks` object
  - Tools registered via `tool()` helper with Zod schemas (not MCP `inputSchema`)
  - Hooks: `event`, `tool.execute.before/after`, `shell.env`, `experimental.session.compacting`
  - Events: `session.idle`, `session.created`, `session.compacted`, `session.error`, etc.
  - Plugin receives: `{ project, client, $, directory, worktree }` context
  - Ref docs: https://opencode.ai/docs/plugins/
- **Existing plugin examples on machine** (for patterns):
  - `~/development/OpenAgents/.opencode/plugin/agent-validator.ts` — complex plugin with tools + state
  - `~/development/OpenAgents/.opencode/plugin/telegram-notify.ts` — event-driven notifications
- **npm naming convention**: `opencode-{feature}` → `opencode-mission-control`
- **Git concurrent operations risk**: All worktrees share `.git` dir — concurrent git ops can corrupt. Need serialization.
- **tmux `pane-died` fragility**: Hook doesn't fire on signal kills (SSH disconnect, terminal crash). Polling must be primary, not fallback.

### Competitive Analysis (Ecosystem Gap Validation)
**Conclusion: Mission Control fills a real gap.** No existing plugin does the full lifecycle of parallel write-capable AI sessions with git workflow integration.

| Plugin | Stars | What it does | Gap Mission Control fills |
|--------|-------|--------------|--------------------------|
| opencode-worktree | 118 | Worktree create/delete + terminal spawn (2 tools) | Job state, monitoring, capture, git tools (PR/diff/sync/merge), OMO, completion detection |
| opencode-background-agents | 60 | Read-only async delegation + persistence | **Write-capable** parallel sessions, worktree isolation, git workflow |
| opencode-devcontainers | 64 | Docker-based branch isolation | tmux-native, lighter weight, AI-focused lifecycle |
| subtask2 | 66 | Intra-session command chaining/looping | **Inter-session** parallelism, separate worktrees (complementary, not competitive) |
| opencode-workspace | 90 | Bundle of above plugins | Not a product; a bundle of existing tools |

**Key differentiator**: opencode-background-agents is **read-only only** (researcher/explore agents). Mission Control spawns **full write-capable** OpenCode instances. opencode-worktree is bare-bones (2 tools). Mission Control is the complete lifecycle.

**Architecture decision**: Build our own thin worktree layer (use opencode-worktree as reference code only, not a dependency). Focus engineering on unique value: job lifecycle, git tools, OMO integration, observability. tmux-only is defensible since our unique features (pane lifecycle detection, output capture, completion signals) are tmux-native.

### Metis Review
**Identified Gaps** (addressed):
- Cross-platform tmux detection: Added explicit Mac/Linux only scope
- OMO version compatibility: Use config parsing not filesystem checks
- Race conditions in job state: Use atomic file writes with temp files
- **CRITICAL: Wrong SDK** — Plan originally used MCP server pattern; corrected to `@opencode-ai/plugin`
- **CRITICAL: Git concurrent corruption** — Added git operation serializer/mutex to worktree manager
- **HIGH: tmux hook fragility** — Made polling the primary detection mechanism, hooks supplement
- **MEDIUM: `gh repo create` idempotency** — Added existence check before creation
- **MEDIUM: Missing npm publish config** — Added proper package.json fields for npm distribution
- **LOW: Missing LICENSE file** — Added MIT license to scaffold

---

## Work Objectives

### Core Objective
Enable OpenCode users to spawn and manage parallel AI coding sessions, each running in its own isolated git worktree with tmux-based terminal management.

### Concrete Deliverables
- `~/development/opencode-mission-control/` - Complete plugin repository
- GitHub repo: `nigel-dev/opencode-mission-control` (public)
- `src/tools/` - 11 tool implementations using `tool()` helper from `@opencode-ai/plugin`
- `src/hooks/` - Event hooks using OpenCode's event system
- `src/lib/` - Core utilities (tmux, worktree, job state, git mutex, OMO detector)
- `README.md` - Installation and usage documentation
- npm-ready package.json with proper `main`, `types`, `files`, `exports` fields

### Definition of Done
- [ ] `bun test` passes with >80% coverage
- [ ] Plugin installs in OpenCode without errors
- [ ] Can launch, monitor, and cleanup jobs end-to-end
- [ ] OMO modes work when OMO is detected
- [ ] Documentation is complete and accurate

### Must Have
- All 11 tools functional via `tool()` from `@opencode-ai/plugin`
- Event-based hooks using OpenCode's event system (`session.idle`, `experimental.session.compacting`)
- Worktree awareness via event hooks
- OMO detection and plan copying
- Git operation serializer (mutex) for concurrent worktree safety
- GitHub repo created at `nigel-dev/opencode-mission-control`
- npm-publishable package configuration

### Must NOT Have (Guardrails)
- **NO Windows native support** - Mac/Linux only, WSL is fine
- **NO job templates** - Out of scope for V1
- **NO job history search** - Out of scope
- **NO job dependencies** - No "run B after A" chains
- **NO output streaming** - Use capture for snapshots
- **NO resource monitoring** - No CPU/RAM tracking
- **NO remote execution** - No SSH support
- **NO over-engineering** - Keep it simple, ship fast

---

## Verification Strategy

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> ALL tasks in this plan MUST be verifiable WITHOUT any human action.

### Test Decision
- **Infrastructure exists**: NO (new project)
- **Automated tests**: YES (Tests-after)
- **Framework**: vitest (following opencode-plugin-template convention; vitest is in devDependencies)
- **Build tool**: `bun build` (tsconfig uses `noEmit: true`)

### Agent-Executed QA Scenarios (MANDATORY)

Every task includes QA scenarios using:
- **Bash**: bun test, TypeScript compilation, file existence checks
- **interactive_bash (tmux)**: Manual tmux session verification where needed

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation - Start Immediately):
├── Task 0: Project scaffold
└── [blocked by 0] Tasks 1-4 run in parallel after scaffold

Wave 2 (Foundation continued):
├── Task 1: Job state manager
├── Task 2: tmux utilities  
├── Task 3: Worktree manager
└── Task 4: Plugin configuration

Wave 3 (Core Tools - After Wave 2):
├── Task 5: mc_launch
├── Task 6: mc_jobs
├── Task 7: mc_status
├── Task 8: mc_attach
├── Task 9: mc_capture
├── Task 10: mc_kill
└── Task 11: mc_cleanup

Wave 4 (Git Tools - After Wave 3):
├── Task 12: mc_pr
├── Task 13: mc_diff
├── Task 14: mc_sync
└── Task 15: mc_merge

Wave 5 (OMO Integration - After Wave 2):
├── Task 16: OMO detector
├── Task 17: Plan copier
└── Task 18: OMO modes in launch

Wave 6 (Session Hooks - After Waves 3-5):
├── Task 19: Job monitor (polling + tmux hooks)
├── Task 20: Toast notifications
├── Task 21: Auto-status on idle hook
├── Task 22: Worktree awareness hook
└── Task 23: Compaction context hook

Wave 7 (Polish - Final):
├── Task 24: Plugin entry point
├── Task 25: Integration tests
├── Task 26: Documentation
└── Task 27: Copy plan to new project
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|------------|--------|------|
| 0 | None | 1-4 | 1 |
| 1 | 0 | 5-11, 19-23 | 2 |
| 2 | 0 | 5, 9, 19 | 2 |
| 3 | 0 | 5, 14, 15 | 2 |
| 4 | 0 | 5, 16 | 2 |
| 5 | 1, 2, 3, 4 | 6-11 | 3 |
| 6-11 | 5 | 12-15 | 3 |
| 12-15 | 6-11 | 24 | 4 |
| 16 | 4 | 17, 18 | 5 |
| 17, 18 | 16 | 21 | 5 |
| 19-23 | 1, 5 | 24 | 6 |
| 24 | All tools, hooks | 25 | 7 |
| 25-27 | 24 | None | 7 |

---

## TODOs

> ### ⚠️ GLOBAL NOTES FOR ALL TASKS (executor MUST read)
>
> **SDK**: All tool definitions use the `tool()` helper from `@opencode-ai/plugin` with `tool.schema.*()` Zod schemas.
> The MCP-style `inputSchema: { type: "object", properties: {...} }` shown in some tasks below is for **logical reference only** —
> the executor MUST translate these to Zod schemas using `tool.schema.string()`, `tool.schema.boolean()`, `tool.schema.number()`, etc.
> See Task 0 references for the exact pattern.
>
> **Testing**: Use `vitest` (not `bun test`). All `bun test` references below should be run as `bunx vitest run` or via `bun run test` script.
>
> **Hooks**: Tasks 19-23 describe hooks conceptually. The actual implementation uses OpenCode's event system:
> - "Auto-status on idle" → `event` hook listening for `session.idle`
> - "Compaction context" → `experimental.session.compacting` hook
> - "Worktree awareness" → `event` hook listening for `session.created`
> - "Notifications" → `event` hook listening for custom monitor events
> See Task 24 for how hooks are wired into the plugin entry point.
>
> **Build**: Use `bun build` (NOT `tsc`). tsconfig has `noEmit: true`.
>
> **Config**: Task 4 describes a `.mission-control/config.json` approach. Consider also using the
> undocumented `config` hook from `@opencode-ai/plugin` to register config within opencode.json itself
> (see plugin template reference in Task 0).

### Wave 1: Project Scaffold

- [ ] 0. Create project scaffold + GitHub repo at ~/development/opencode-mission-control

  **What to do**:
  - Create directory structure:
    ```
    ~/development/opencode-mission-control/
    ├── src/
    │   ├── tools/           # Tool implementations via tool() helper
    │   ├── hooks/           # OpenCode event hooks
    │   ├── lib/             # Core utilities
    │   │   └── providers/   # WorktreeProvider + TerminalProvider interfaces
    │   └── index.ts         # Plugin entry point (exports Plugin function)
    ├── tests/               # Test files
    ├── package.json         # Dependencies + npm publishing config
    ├── tsconfig.json        # TypeScript config
    ├── .gitignore
    ├── LICENSE              # MIT license
    └── README.md            # Documentation stub
    ```
  - Initialize git repository
  - **Create GitHub repo**: `gh repo view nigel-dev/opencode-mission-control 2>/dev/null || gh repo create nigel-dev/opencode-mission-control --public --description "OpenCode plugin for parallel AI coding sessions in isolated git worktrees" --source=. --remote=origin --push`
  - Set up package.json with:
    - **name**: `"opencode-mission-control"`
    - **dependencies**: `@opencode-ai/plugin` (plugin SDK + tool helper), `zod` (validation)
    - **devDependencies**: `@types/bun`, `typescript`
    - **npm publishing fields**: `main`, `types`, `files`, `exports`, `bin`
    - **scripts**: `build`, `test`, `prepublishOnly`
    - **license**: `"MIT"`
    - **repository**: `{ "type": "git", "url": "https://github.com/nigel-dev/opencode-mission-control" }`
  - Configure TypeScript for strict mode
  - Add MIT LICENSE file

  **Must NOT do**:
  - Do not add unnecessary dependencies
  - Do not create complex build pipelines
  - Do not use `@anthropic-ai/sdk` or `@modelcontextprotocol/sdk` — use `@opencode-ai/plugin`

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `['git-master']`
    - `git-master`: Git init, remote setup, initial commit + push

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (must complete first)
  - **Blocks**: Tasks 1, 2, 3, 4
  - **Blocked By**: None

  **References**:

  **Pattern References** (existing plugin implementations to follow):
  - `~/development/OpenAgents/.opencode/plugin/agent-validator.ts` — Complex plugin with tools, state, hooks
  - `~/development/OpenAgents/.opencode/plugin/telegram-notify.ts` — Event-driven plugin pattern
  - `~/.cache/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` — Plugin type definitions
  - `~/.cache/opencode/node_modules/@opencode-ai/plugin/dist/tool.d.ts` — tool() helper types

  **CRITICAL SCAFFOLD REFERENCE — opencode-plugin-template** (archived but invaluable):
  > Source: https://github.com/zenobi-us/opencode-plugin-template/tree/main/template
  > This is the PROVEN scaffold pattern. Follow it closely.

  - **package.json** must include:
    ```json
    {
      "type": "module",
      "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
      "publishConfig": { "access": "public", "provenance": true },
      "files": ["dist"]
    }
    ```
  - **tsconfig.json** must use:
    ```json
    {
      "compilerOptions": {
        "lib": ["ESNext", "DOM"],
        "target": "ESNext",
        "module": "ESNext",
        "moduleResolution": "bundler",
        "strict": true,
        "noEmit": true,
        "skipLibCheck": true,
        "allowImportingTsExtensions": true,
        "types": ["bun-types"]
      }
    }
    ```
    Note: `noEmit: true` — use `bun build` for compilation, not `tsc`
  - **Entry point pattern**:
    ```typescript
    import type { Plugin } from '@opencode-ai/plugin';
    import { tool } from '@opencode-ai/plugin';
    export const MissionControl: Plugin = async ({ project, client, $, directory, worktree }) => {
      return {
        tool: {
          mc_launch: tool({
            description: 'Launch a parallel AI coding session',
            args: { name: tool.schema.string().describe('Job name') },
            async execute(args, context) { /* ... */ }
          })
        },
        event: async ({ event }) => { /* ... */ },
        "experimental.session.compacting": async (input, output) => { /* ... */ },
        async config(config) { /* modify opencode config at runtime */ }
      }
    }
    ```
  - **Undocumented `config` hook**: The template reveals a `config` hook that can modify OpenCode configuration at runtime. We can use this to register slash commands or inject config.

  **External References**:
  - Official plugin docs: https://opencode.ai/docs/plugins/
  - Reference implementation (worktree patterns): https://github.com/kdcokenny/opencode-worktree

  **Acceptance Criteria**:
  - [ ] Directory exists: `~/development/opencode-mission-control/`
  - [ ] `git status` shows clean initialized repo
  - [ ] `gh repo view nigel-dev/opencode-mission-control` shows the public repo
  - [ ] `git remote -v` shows origin pointing to `github.com/nigel-dev/opencode-mission-control`
  - [ ] `bun install` completes without errors
  - [ ] `bun run build` completes without errors (uses `bun build`, NOT `tsc` — tsconfig has `noEmit: true`)
  - [ ] `cat package.json | jq .name` → `"opencode-mission-control"`
  - [ ] `cat package.json | jq .dependencies` includes `@opencode-ai/plugin`
  - [ ] LICENSE file exists with MIT text
  - [ ] Initial commit pushed to GitHub

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Project structure is correct
    Tool: Bash
    Steps:
      1. ls -la ~/development/opencode-mission-control/
      2. Assert: src/, tests/, package.json, tsconfig.json, LICENSE exist
      3. cat package.json | jq '.name'
      4. Assert: name is "opencode-mission-control"
      5. cat package.json | jq '.dependencies["@opencode-ai/plugin"]'
      6. Assert: dependency exists (not null)
    Expected Result: All files and directories present with correct deps

  Scenario: GitHub repo exists and is connected
    Tool: Bash
    Steps:
      1. gh repo view nigel-dev/opencode-mission-control --json name,visibility
      2. Assert: name is "opencode-mission-control", visibility is "PUBLIC"
      3. git remote -v
      4. Assert: origin contains "nigel-dev/opencode-mission-control"
      5. git log --oneline -1
      6. Assert: Initial commit exists
    Expected Result: GitHub repo created and connected

  Scenario: Build succeeds
    Tool: Bash
    Steps:
      1. bun run build
      2. Assert: No TypeScript errors
      3. ls dist/
      4. Assert: dist/ contains compiled output
    Expected Result: TypeScript compilation works
  ```

  **Commit**: YES
  - Message: `feat: initial project scaffold with GitHub repo`
  - Files: All created files
  - Post-commit: `git push -u origin main`

---

### Wave 2: Foundation

- [ ] 1. Implement job state manager

  **What to do**:
  - Create `src/lib/job-state.ts`
  - Job state structure:
    ```typescript
    interface Job {
      id: string;              // UUID
      name: string;            // User-friendly name
      worktreePath: string;    // Absolute path to worktree
      branch: string;          // Git branch name
      tmuxTarget: string;      // "mc-{name}" for session, "{session}:mc:{name}" for window
      placement: 'session' | 'window';
      status: 'running' | 'completed' | 'failed' | 'stopped';
      prompt: string;          // Original task prompt
      mode: 'vanilla' | 'plan' | 'ralph' | 'ulw';  // Execution mode
      planFile?: string;       // Path to plan file if mode != vanilla
      createdAt: string;       // ISO timestamp
      completedAt?: string;    // ISO timestamp
      exitCode?: number;       // Process exit code
    }
    
    interface JobState {
      version: 1;
      jobs: Job[];
      updatedAt: string;
    }
    ```
  - Implement functions:
    - `loadJobState(): Promise<JobState>`
    - `saveJobState(state: JobState): Promise<void>` (atomic write)
    - `addJob(job: Job): Promise<void>`
    - `updateJob(id: string, updates: Partial<Job>): Promise<void>`
    - `removeJob(id: string): Promise<void>`
    - `getJob(id: string): Promise<Job | undefined>`
    - `getJobByName(name: string): Promise<Job | undefined>`
    - `getRunningJobs(): Promise<Job[]>`
  - State file location: `.mission-control/jobs.json` (in main worktree)
  - Use atomic writes (write to temp, rename)

  **Must NOT do**:
  - Do not use a database
  - Do not add caching complexity

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`
    - Reason: Straightforward file I/O with JSON

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 3, 4)
  - **Blocks**: Tasks 5-11, 19-23
  - **Blocked By**: Task 0

  **References**:
  - Atomic JSON file write pattern: write to temp file, then `rename()` for atomicity

  **Acceptance Criteria**:
  - [ ] `src/lib/job-state.ts` exists
  - [ ] All functions exported and typed
  - [ ] Atomic write prevents corruption
  - [ ] `bun test tests/lib/job-state.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Job state CRUD operations
    Tool: Bash
    Steps:
      1. Create test file that exercises all functions
      2. bun test tests/lib/job-state.test.ts
      3. Assert: All tests pass
    Expected Result: 100% of job state tests pass
  ```

  **Commit**: YES
  - Message: `feat(lib): add job state manager`
  - Files: `src/lib/job-state.ts`, `tests/lib/job-state.test.ts`

---

- [ ] 2. Implement tmux utilities

  **What to do**:
  - Create `src/lib/tmux.ts`
  - Implement functions:
    ```typescript
    // Check if tmux is available
    function isTmuxAvailable(): Promise<boolean>
    
    // Check if currently inside a tmux session
    function isInsideTmux(): boolean  // Check $TMUX env var
    
    // Get current tmux session name (if inside tmux)
    function getCurrentSession(): string | undefined
    
    // Create new tmux session
    function createSession(opts: {
      name: string;
      workdir: string;
      command?: string;
    }): Promise<void>
    
    // Create new window in existing session
    function createWindow(opts: {
      session: string;
      name: string;
      workdir: string;
      command?: string;
    }): Promise<void>
    
    // Check if session/window exists
    function sessionExists(name: string): Promise<boolean>
    function windowExists(session: string, window: string): Promise<boolean>
    
    // Kill session or window
    function killSession(name: string): Promise<void>
    function killWindow(session: string, window: string): Promise<void>
    
    // Capture pane content
    function capturePane(target: string, lines?: number): Promise<string>
    
    // Send keys to pane
    function sendKeys(target: string, keys: string): Promise<void>
    
    // Set up pane-died hook
    function setPaneDiedHook(target: string, callback: string): Promise<void>
    
    // Get pane PID
    function getPanePid(target: string): Promise<number | undefined>
    
    // Check if pane is still running
    function isPaneRunning(target: string): Promise<boolean>
    ```
  - All functions should handle errors gracefully
  - Use `Bun.spawn` for executing tmux commands

  **Must NOT do**:
  - Do not create complex abstractions
  - Do not handle Windows

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`
    - Reason: Shell command wrappers

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 1, 3, 4)
  - **Blocks**: Tasks 5, 9, 19
  - **Blocked By**: Task 0

  **References**:
  - tmux man page: `man tmux`
  - tmux command reference: `man tmux` — focus on `new-session`, `new-window`, `send-keys`, `capture-pane`, hook commands

  **Acceptance Criteria**:
  - [ ] `src/lib/tmux.ts` exists with all functions
  - [ ] Functions handle missing tmux gracefully
  - [ ] `bun test tests/lib/tmux.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: tmux utilities work
    Tool: Bash
    Steps:
      1. bun test tests/lib/tmux.test.ts
      2. Assert: All tests pass
    Expected Result: tmux utilities functional
  ```

  **Commit**: YES
  - Message: `feat(lib): add tmux utilities`
  - Files: `src/lib/tmux.ts`, `tests/lib/tmux.test.ts`

---

- [ ] 3. Implement worktree manager with git mutex and post-create hooks

  **What to do**:
  - Create `src/lib/providers/worktree-provider.ts` — interface definition:
    ```typescript
    // Provider interface for future extensibility (e.g., devcontainer support)
    interface WorktreeProvider {
      create(opts: { branch: string; basePath?: string }): Promise<string>
      remove(path: string, force?: boolean): Promise<void>
      list(): Promise<WorktreeInfo[]>
      sync(path: string, strategy: 'rebase' | 'merge'): Promise<SyncResult>
    }
    ```
  - Create `src/lib/git-mutex.ts` — git operation serializer:
    ```typescript
    // CRITICAL: All worktrees share the same .git directory.
    // Concurrent git operations (commit, add, etc.) across worktrees WILL corrupt .git/
    // This mutex serializes all git operations across the plugin.
    class GitMutex {
      acquire(): Promise<() => void>  // Returns release function
      withLock<T>(fn: () => Promise<T>): Promise<T>
    }
    // Implementation: Use a lock file at .mission-control/.git-lock
    // with Bun.file() + atomic rename pattern
    ```
  - Create `src/lib/worktree.ts` — GitWorktreeProvider implementation:
    ```typescript
    interface WorktreeInfo {
      path: string;
      branch: string;
      head: string;  // commit SHA
      isMain: boolean;
    }

    interface SyncResult {
      success: boolean;
      conflicts?: string[];
    }

    interface PostCreateHook {
      copyFiles?: string[];   // e.g., [".env", ".env.local"]
      symlinkDirs?: string[]; // e.g., ["node_modules"]
      commands?: string[];    // e.g., ["bun install"]
    }

    // Get main worktree path
    function getMainWorktree(): Promise<string>

    // List all worktrees
    function listWorktrees(): Promise<WorktreeInfo[]>

    // Create worktree for a job (ALL git ops go through GitMutex)
    function createWorktree(opts: {
      branch: string;
      basePath?: string;  // defaults to XDG path
      postCreate?: PostCreateHook;
    }): Promise<string>  // returns worktree path

    // Remove worktree (checks for dirty state first)
    function removeWorktree(path: string, force?: boolean): Promise<void>

    // Check if path is inside a managed worktree
    function isInManagedWorktree(path: string): Promise<{
      isManaged: boolean;
      worktreePath?: string;
      jobName?: string;
    }>

    // Get worktree for a branch
    function getWorktreeForBranch(branch: string): Promise<WorktreeInfo | undefined>

    // Sync worktree with base branch (rebase or merge)
    function syncWorktree(path: string, strategy: 'rebase' | 'merge'): Promise<SyncResult>
    ```
  - **Worktree path convention** (XDG-style, configurable):
    - Default: `~/.local/share/opencode-mission-control/<project-id>/<branch>/`
    - Configurable via `config.worktreeBasePath`
    - Why XDG: Keeps repos clean, avoids accidental commits, stable across projects
  - **Post-create hooks**: After creating worktree, optionally:
    1. Copy files (`.env*`) from main worktree
    2. Symlink directories (`node_modules`) when safe
    3. Run commands (`bun install`, `docker compose up -d`)
  - Use `git worktree` commands, ALL wrapped in GitMutex

  **Must NOT do**:
  - Do not reinvent git operations
  - Do not handle complex merge scenarios (just report conflicts)
  - Do not run concurrent git operations (MUST use GitMutex)
  - Do not skip dirty state check before removal

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `['git-master']`
    - `git-master`: Git worktree operations, mutex patterns

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 1, 2, 4)
  - **Blocks**: Tasks 5, 14, 15
  - **Blocked By**: Task 0

  **References**:

  **Pattern References**:
  - `https://github.com/kdcokenny/opencode-worktree` — Reference implementation for worktree + terminal spawning + file sync patterns. Study their worktree.jsonc config, file sync approach, and terminal detection.

  **External References**:
  - git worktree docs: `git worktree --help`
  - Git concurrent access risk: "Git client is meant to be run by a single process" — all worktrees share `.git/`, concurrent ops corrupt

  **Acceptance Criteria**:
  - [ ] `src/lib/providers/worktree-provider.ts` — interface exists
  - [ ] `src/lib/git-mutex.ts` — mutex implementation exists
  - [ ] `src/lib/worktree.ts` — GitWorktreeProvider exists with all functions
  - [ ] Creates worktrees at XDG path by default
  - [ ] All git operations serialized through GitMutex
  - [ ] Post-create hooks (copyFiles, symlinkDirs, commands) functional
  - [ ] Refuses to remove dirty worktrees without force flag
  - [ ] `bun test tests/lib/worktree.test.ts` passes
  - [ ] `bun test tests/lib/git-mutex.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Worktree CRUD operations
    Tool: Bash
    Steps:
      1. bun test tests/lib/worktree.test.ts
      2. Assert: All tests pass
    Expected Result: Worktree manager functional

  Scenario: Git mutex prevents concurrent corruption
    Tool: Bash
    Steps:
      1. bun test tests/lib/git-mutex.test.ts
      2. Assert: Concurrent operations are serialized
    Expected Result: Mutex serializes git operations
  ```

  **Commit**: YES
  - Message: `feat(lib): add worktree manager with git mutex and post-create hooks`
  - Files: `src/lib/providers/worktree-provider.ts`, `src/lib/git-mutex.ts`, `src/lib/worktree.ts`, `tests/lib/worktree.test.ts`, `tests/lib/git-mutex.test.ts`

---

- [ ] 4. Implement plugin configuration

  **What to do**:
  - Create `src/lib/config.ts`
  - Configuration structure:
    ```typescript
    interface MCConfig {
      // tmux placement preference
      defaultPlacement: 'session' | 'window';
      
      // Polling interval for job status (ms)
      pollInterval: number;  // default: 10000
      
      // Auto-status idle threshold (ms)
      idleThreshold: number;  // default: 300000 (5 min)
      
      // Worktree base path
      worktreeBasePath: string;  // default: "../.mc-worktrees"
      
      // OMO integration
      omo: {
        enabled: boolean;  // auto-detected
        defaultMode: 'vanilla' | 'plan' | 'ralph' | 'ulw';
      };
    }
    ```
  - Config file location: `.mission-control/config.json`
  - Implement:
    - `loadConfig(): Promise<MCConfig>` (with defaults)
    - `saveConfig(config: MCConfig): Promise<void>`
    - `getConfigPath(): string`

  **Must NOT do**:
  - Do not add complex validation
  - Do not add schema migration

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 1, 2, 3)
  - **Blocks**: Tasks 5, 16
  - **Blocked By**: Task 0

  **References**:
  - JSON config with defaults pattern: load file if exists, merge with defaults, save atomically

  **Acceptance Criteria**:
  - [ ] `src/lib/config.ts` exists
  - [ ] Defaults work when no config file exists
  - [ ] `bun test tests/lib/config.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Config loads with defaults
    Tool: Bash
    Steps:
      1. bun test tests/lib/config.test.ts
      2. Assert: All tests pass
    Expected Result: Config works with and without file
  ```

  **Commit**: YES
  - Message: `feat(lib): add plugin configuration`
  - Files: `src/lib/config.ts`, `tests/lib/config.test.ts`

---

### Wave 3: Core Tools

- [ ] 5. Implement mc_launch tool

  **What to do**:
  - Create `src/tools/launch.ts`
  - Tool schema:
    ```typescript
    {
      name: "mc_launch",
      description: "Launch a new parallel AI coding session in an isolated worktree",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Job name (used for branch and tmux)" },
          prompt: { type: "string", description: "Task prompt for the AI agent" },
          branch: { type: "string", description: "Branch name (defaults to mc/{name})" },
          placement: { 
            type: "string", 
            enum: ["session", "window"],
            description: "tmux placement: session (default) or window" 
          },
          mode: {
            type: "string",
            enum: ["vanilla", "plan", "ralph", "ulw"],
            description: "Execution mode (OMO modes require OMO)"
          },
          planFile: { type: "string", description: "Plan file to use (for plan mode)" }
        },
        required: ["name", "prompt"]
      }
    }
    ```
  - Implementation:
    1. Validate name is unique
    2. Create branch if not exists
    3. Create worktree
    4. Copy `.sisyphus/plans/` if exists (for OMO)
    5. Create tmux session or window based on placement
    6. Send initial command: `opencode` or `/start-work` etc based on mode
    7. Set up pane-died hook for completion detection
    8. Add job to state
    9. Return job info

  **Must NOT do**:
  - Do not wait for job completion
  - Do not stream output

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `['git-master']`
    - `git-master`: Branch and worktree creation

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (core tool, others depend on it)
  - **Blocks**: Tasks 6-11
  - **Blocked By**: Tasks 1, 2, 3, 4

  **References**:
  - Job state: `src/lib/job-state.ts` - State management
  - tmux: `src/lib/tmux.ts` - Session/window creation
  - worktree: `src/lib/worktree.ts` - Worktree creation

  **Acceptance Criteria**:
  - [ ] `src/tools/launch.ts` exists
  - [ ] Creates worktree and tmux session/window
  - [ ] Sets up pane-died hook
  - [ ] Adds job to state
  - [ ] `bun test tests/tools/launch.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Launch creates job correctly
    Tool: Bash
    Steps:
      1. bun test tests/tools/launch.test.ts
      2. Assert: All tests pass
    Expected Result: Launch tool functional
  ```

  **Commit**: YES
  - Message: `feat(tools): add mc_launch tool`
  - Files: `src/tools/launch.ts`, `tests/tools/launch.test.ts`

---

- [ ] 6. Implement mc_jobs tool

  **What to do**:
  - Create `src/tools/jobs.ts`
  - Tool schema:
    ```typescript
    {
      name: "mc_jobs",
      description: "List all Mission Control jobs with status",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["all", "running", "completed", "failed"],
            description: "Filter by status (default: all)"
          }
        }
      }
    }
    ```
  - Output format:
    ```
    Mission Control Jobs
    ====================
    
    Running (2):
    • feature-auth [running] - "Add OAuth support"
      Branch: mc/feature-auth | Mode: plan | Started: 2h ago
      
    • fix-bug-123 [running] - "Fix login redirect"
      Branch: mc/fix-bug-123 | Mode: vanilla | Started: 30m ago
    
    Completed (1):
    • refactor-api [completed] ✓ - "Refactor API endpoints"
      Branch: mc/refactor-api | Mode: ralph | Completed: 1h ago
    ```

  **Must NOT do**:
  - Do not include full prompts (truncate to ~50 chars)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 7-11)
  - **Blocks**: Tasks 12-15
  - **Blocked By**: Task 5

  **References**:
  - Job state: `src/lib/job-state.ts`

  **Acceptance Criteria**:
  - [ ] `src/tools/jobs.ts` exists
  - [ ] Formats output nicely
  - [ ] Filters by status work
  - [ ] `bun test tests/tools/jobs.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Jobs lists correctly
    Tool: Bash
    Steps:
      1. bun test tests/tools/jobs.test.ts
      2. Assert: All tests pass
    Expected Result: Jobs tool functional
  ```

  **Commit**: YES
  - Message: `feat(tools): add mc_jobs tool`
  - Files: `src/tools/jobs.ts`, `tests/tools/jobs.test.ts`

---

- [ ] 7. Implement mc_status tool

  **What to do**:
  - Create `src/tools/status.ts`
  - Tool schema:
    ```typescript
    {
      name: "mc_status",
      description: "Get detailed status of a specific job",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Job name" }
        },
        required: ["name"]
      }
    }
    ```
  - Output includes:
    - Job metadata (name, branch, status, mode)
    - Worktree path
    - tmux target
    - Git status (files changed, ahead/behind)
    - Last 10 lines of output (via capture)
    - Duration running

  **Must NOT do**:
  - Do not include full terminal history

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `['git-master']`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 6, 8-11)
  - **Blocks**: Tasks 12-15
  - **Blocked By**: Task 5

  **References**:
  - Job state: `src/lib/job-state.ts`
  - tmux: `src/lib/tmux.ts` - Capture pane

  **Acceptance Criteria**:
  - [ ] `src/tools/status.ts` exists
  - [ ] Shows comprehensive job info
  - [ ] Includes recent output
  - [ ] `bun test tests/tools/status.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Status shows job details
    Tool: Bash
    Steps:
      1. bun test tests/tools/status.test.ts
      2. Assert: All tests pass
    Expected Result: Status tool functional
  ```

  **Commit**: YES
  - Message: `feat(tools): add mc_status tool`
  - Files: `src/tools/status.ts`, `tests/tools/status.test.ts`

---

- [ ] 8. Implement mc_attach tool

  **What to do**:
  - Create `src/tools/attach.ts`
  - Tool schema:
    ```typescript
    {
      name: "mc_attach",
      description: "Get instructions for attaching to a job's terminal",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Job name" }
        },
        required: ["name"]
      }
    }
    ```
  - Output:
    ```
    To attach to job "feature-auth":
    
    # If session mode:
    tmux attach -t mc-feature-auth
    
    # If window mode (and you're in the same tmux session):
    tmux select-window -t mc:feature-auth
    
    # To detach: Ctrl+B, D
    ```

  **Must NOT do**:
  - Do not actually attach (can't control user's terminal)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 6, 7, 9-11)
  - **Blocks**: Tasks 12-15
  - **Blocked By**: Task 5

  **References**:
  - Job state: `src/lib/job-state.ts`

  **Acceptance Criteria**:
  - [ ] `src/tools/attach.ts` exists
  - [ ] Provides correct tmux commands
  - [ ] `bun test tests/tools/attach.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Attach provides instructions
    Tool: Bash
    Steps:
      1. bun test tests/tools/attach.test.ts
      2. Assert: All tests pass
    Expected Result: Attach tool functional
  ```

  **Commit**: YES
  - Message: `feat(tools): add mc_attach tool`
  - Files: `src/tools/attach.ts`, `tests/tools/attach.test.ts`

---

- [ ] 9. Implement mc_capture tool

  **What to do**:
  - Create `src/tools/capture.ts`
  - Tool schema:
    ```typescript
    {
      name: "mc_capture",
      description: "Capture current terminal output from a job",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Job name" },
          lines: { type: "number", description: "Number of lines (default: 100)" }
        },
        required: ["name"]
      }
    }
    ```
  - Uses tmux capture-pane
  - Returns captured text

  **Must NOT do**:
  - Do not save to file (just return)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 6-8, 10-11)
  - **Blocks**: Tasks 12-15
  - **Blocked By**: Task 5

  **References**:
  - tmux: `src/lib/tmux.ts` - capturePane function

  **Acceptance Criteria**:
  - [ ] `src/tools/capture.ts` exists
  - [ ] Captures correct number of lines
  - [ ] `bun test tests/tools/capture.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Capture returns terminal content
    Tool: Bash
    Steps:
      1. bun test tests/tools/capture.test.ts
      2. Assert: All tests pass
    Expected Result: Capture tool functional
  ```

  **Commit**: YES
  - Message: `feat(tools): add mc_capture tool`
  - Files: `src/tools/capture.ts`, `tests/tools/capture.test.ts`

---

- [ ] 10. Implement mc_kill tool

  **What to do**:
  - Create `src/tools/kill.ts`
  - Tool schema:
    ```typescript
    {
      name: "mc_kill",
      description: "Stop a running job",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Job name" },
          force: { type: "boolean", description: "Force kill (SIGKILL)" }
        },
        required: ["name"]
      }
    }
    ```
  - Implementation:
    1. Find job by name
    2. Kill tmux session/window
    3. Update job status to "stopped"
    4. Do NOT remove worktree (that's cleanup's job)

  **Must NOT do**:
  - Do not remove worktree
  - Do not remove job from state

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 6-9, 11)
  - **Blocks**: Tasks 12-15
  - **Blocked By**: Task 5

  **References**:
  - tmux: `src/lib/tmux.ts` - killSession, killWindow
  - Job state: `src/lib/job-state.ts`

  **Acceptance Criteria**:
  - [ ] `src/tools/kill.ts` exists
  - [ ] Kills tmux correctly
  - [ ] Updates job status
  - [ ] `bun test tests/tools/kill.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Kill stops job
    Tool: Bash
    Steps:
      1. bun test tests/tools/kill.test.ts
      2. Assert: All tests pass
    Expected Result: Kill tool functional
  ```

  **Commit**: YES
  - Message: `feat(tools): add mc_kill tool`
  - Files: `src/tools/kill.ts`, `tests/tools/kill.test.ts`

---

- [ ] 11. Implement mc_cleanup tool

  **What to do**:
  - Create `src/tools/cleanup.ts`
  - Tool schema:
    ```typescript
    {
      name: "mc_cleanup",
      description: "Remove completed/stopped jobs and their worktrees",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Specific job to cleanup (optional)" },
          all: { type: "boolean", description: "Cleanup all non-running jobs" },
          deleteBranch: { type: "boolean", description: "Also delete the git branch" }
        }
      }
    }
    ```
  - Implementation:
    1. Find job(s) to cleanup
    2. Verify not running
    3. Remove worktree
    4. Optionally delete branch
    5. Remove from job state

  **Must NOT do**:
  - Do not cleanup running jobs
  - Do not force delete without confirmation

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `['git-master']`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 6-10)
  - **Blocks**: Tasks 12-15
  - **Blocked By**: Task 5

  **References**:
  - worktree: `src/lib/worktree.ts` - removeWorktree
  - Job state: `src/lib/job-state.ts`

  **Acceptance Criteria**:
  - [ ] `src/tools/cleanup.ts` exists
  - [ ] Removes worktree and state
  - [ ] Refuses to cleanup running jobs
  - [ ] `bun test tests/tools/cleanup.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Cleanup removes completed jobs
    Tool: Bash
    Steps:
      1. bun test tests/tools/cleanup.test.ts
      2. Assert: All tests pass
    Expected Result: Cleanup tool functional
  ```

  **Commit**: YES
  - Message: `feat(tools): add mc_cleanup tool`
  - Files: `src/tools/cleanup.ts`, `tests/tools/cleanup.test.ts`

---

### Wave 4: Git Tools

- [ ] 12. Implement mc_pr tool

  **What to do**:
  - Create `src/tools/pr.ts`
  - Tool schema:
    ```typescript
    {
      name: "mc_pr",
      description: "Create a pull request from a job's branch",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Job name" },
          title: { type: "string", description: "PR title (defaults to job prompt)" },
          body: { type: "string", description: "PR body" },
          draft: { type: "boolean", description: "Create as draft PR" }
        },
        required: ["name"]
      }
    }
    ```
  - Uses `gh pr create` CLI
  - Returns PR URL

  **Must NOT do**:
  - Do not implement GitHub API directly (use gh CLI)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `['git-master']`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 13-15)
  - **Blocks**: Task 24
  - **Blocked By**: Tasks 6-11

  **References**:
  - gh CLI: `gh pr create --help`

  **Acceptance Criteria**:
  - [ ] `src/tools/pr.ts` exists
  - [ ] Uses gh CLI
  - [ ] Returns PR URL
  - [ ] `bun test tests/tools/pr.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: PR creates pull request
    Tool: Bash
    Steps:
      1. bun test tests/tools/pr.test.ts
      2. Assert: All tests pass (mocked gh)
    Expected Result: PR tool functional
  ```

  **Commit**: YES
  - Message: `feat(tools): add mc_pr tool`
  - Files: `src/tools/pr.ts`, `tests/tools/pr.test.ts`

---

- [ ] 13. Implement mc_diff tool

  **What to do**:
  - Create `src/tools/diff.ts`
  - Tool schema:
    ```typescript
    {
      name: "mc_diff",
      description: "Show changes in a job's branch compared to base",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Job name" },
          stat: { type: "boolean", description: "Show diffstat only" }
        },
        required: ["name"]
      }
    }
    ```
  - Uses `git diff` against base branch
  - Returns diff output

  **Must NOT do**:
  - Do not truncate diff (let caller handle)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `['git-master']`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 12, 14-15)
  - **Blocks**: Task 24
  - **Blocked By**: Tasks 6-11

  **References**:
  - git diff: `git diff --help`

  **Acceptance Criteria**:
  - [ ] `src/tools/diff.ts` exists
  - [ ] Shows correct diff
  - [ ] Stat mode works
  - [ ] `bun test tests/tools/diff.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Diff shows changes
    Tool: Bash
    Steps:
      1. bun test tests/tools/diff.test.ts
      2. Assert: All tests pass
    Expected Result: Diff tool functional
  ```

  **Commit**: YES
  - Message: `feat(tools): add mc_diff tool`
  - Files: `src/tools/diff.ts`, `tests/tools/diff.test.ts`

---

- [ ] 14. Implement mc_sync tool

  **What to do**:
  - Create `src/tools/sync.ts`
  - Tool schema:
    ```typescript
    {
      name: "mc_sync",
      description: "Sync a job's branch with the base branch",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Job name" },
          strategy: { 
            type: "string", 
            enum: ["rebase", "merge"],
            description: "Sync strategy (default: rebase)" 
          }
        },
        required: ["name"]
      }
    }
    ```
  - Returns success/conflict status
  - Does NOT auto-resolve conflicts

  **Must NOT do**:
  - Do not auto-resolve conflicts
  - Do not force push

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `['git-master']`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 12-13, 15)
  - **Blocks**: Task 24
  - **Blocked By**: Tasks 6-11

  **References**:
  - worktree: `src/lib/worktree.ts` - syncWorktree

  **Acceptance Criteria**:
  - [ ] `src/tools/sync.ts` exists
  - [ ] Rebase and merge work
  - [ ] Reports conflicts
  - [ ] `bun test tests/tools/sync.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Sync updates branch
    Tool: Bash
    Steps:
      1. bun test tests/tools/sync.test.ts
      2. Assert: All tests pass
    Expected Result: Sync tool functional
  ```

  **Commit**: YES
  - Message: `feat(tools): add mc_sync tool`
  - Files: `src/tools/sync.ts`, `tests/tools/sync.test.ts`

---

- [ ] 15. Implement mc_merge tool

  **What to do**:
  - Create `src/tools/merge.ts`
  - Tool schema:
    ```typescript
    {
      name: "mc_merge",
      description: "Merge a job's branch back to main (for non-PR workflows)",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Job name" },
          squash: { type: "boolean", description: "Squash commits" },
          message: { type: "string", description: "Merge commit message" }
        },
        required: ["name"]
      }
    }
    ```
  - Merges job branch into main (or base branch)
  - For teams not using PRs

  **Must NOT do**:
  - Do not push automatically
  - Do not delete branch after merge

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `['git-master']`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 12-14)
  - **Blocks**: Task 24
  - **Blocked By**: Tasks 6-11

  **References**:
  - git merge: `git merge --help`

  **Acceptance Criteria**:
  - [ ] `src/tools/merge.ts` exists
  - [ ] Squash option works
  - [ ] Does not auto-push
  - [ ] `bun test tests/tools/merge.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Merge integrates changes
    Tool: Bash
    Steps:
      1. bun test tests/tools/merge.test.ts
      2. Assert: All tests pass
    Expected Result: Merge tool functional
  ```

  **Commit**: YES
  - Message: `feat(tools): add mc_merge tool`
  - Files: `src/tools/merge.ts`, `tests/tools/merge.test.ts`

---

### Wave 5: OMO Integration

- [ ] 16. Implement OMO detector

  **What to do**:
  - Create `src/lib/omo.ts`
  - Implement:
    ```typescript
    interface OMOStatus {
      detected: boolean;
      configSource: 'local' | 'global' | null;
      sisyphusPath: string | null;  // .sisyphus/ path if exists
    }
    
    // Check if OMO is installed by looking at opencode.json
    function detectOMO(): Promise<OMOStatus>
    
    // Check locations:
    // 1. ./opencode.json (local)
    // 2. ~/.config/opencode/opencode.json (global)
    // Look for "oh-my-opencode" in plugin array
    ```

  **Must NOT do**:
  - Do not check .sisyphus/ existence (unreliable)
  - Do not check npm packages

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with Tasks 17-18)
  - **Blocks**: Tasks 17, 18
  - **Blocked By**: Task 4

  **References**:
  - OpenCode config structure

  **Acceptance Criteria**:
  - [ ] `src/lib/omo.ts` exists
  - [ ] Detects OMO from config
  - [ ] `bun test tests/lib/omo.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: OMO detection works
    Tool: Bash
    Steps:
      1. bun test tests/lib/omo.test.ts
      2. Assert: All tests pass
    Expected Result: OMO detector functional
  ```

  **Commit**: YES
  - Message: `feat(lib): add OMO detector`
  - Files: `src/lib/omo.ts`, `tests/lib/omo.test.ts`

---

- [ ] 17. Implement plan copier

  **What to do**:
  - Create `src/lib/plan-copier.ts`
  - Implement:
    ```typescript
    // Copy .sisyphus/plans/ directory to worktree
    function copyPlansToWorktree(
      sourcePath: string,  // Main worktree .sisyphus/plans/
      targetPath: string   // Job worktree .sisyphus/plans/
    ): Promise<{
      copied: string[];  // List of copied plan files
    }>
    
    // Do NOT copy:
    // - .sisyphus/state.json
    // - .sisyphus/boulder.json
    // - Anything outside plans/
    ```

  **Must NOT do**:
  - Do not copy state.json or boulder.json
  - Do not modify copied plans

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with Tasks 16, 18)
  - **Blocks**: Task 18
  - **Blocked By**: Task 16

  **References**:
  - File system operations

  **Acceptance Criteria**:
  - [ ] `src/lib/plan-copier.ts` exists
  - [ ] Copies only plans directory
  - [ ] `bun test tests/lib/plan-copier.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Plan copier works
    Tool: Bash
    Steps:
      1. bun test tests/lib/plan-copier.test.ts
      2. Assert: All tests pass
    Expected Result: Plan copier functional
  ```

  **Commit**: YES
  - Message: `feat(lib): add plan copier for OMO integration`
  - Files: `src/lib/plan-copier.ts`, `tests/lib/plan-copier.test.ts`

---

- [ ] 18. Add OMO modes to launch

  **What to do**:
  - Update `src/tools/launch.ts`
  - Add mode handling:
    ```typescript
    // After creating tmux session/window, send appropriate command:
    switch (mode) {
      case 'vanilla':
        sendKeys(target, 'opencode\n');
        break;
      case 'plan':
        // Copy plans first
        await copyPlansToWorktree(...);
        sendKeys(target, 'opencode\n');
        // Wait for opencode to start
        await sleep(2000);
        sendKeys(target, '/start-work\n');
        break;
      case 'ralph':
        await copyPlansToWorktree(...);
        sendKeys(target, 'opencode\n');
        await sleep(2000);
        sendKeys(target, '/ralph-loop\n');
        break;
      case 'ulw':
        await copyPlansToWorktree(...);
        sendKeys(target, 'opencode\n');
        await sleep(2000);
        sendKeys(target, '/ulw-loop\n');
        break;
    }
    ```
  - Validate OMO is detected for non-vanilla modes

  **Must NOT do**:
  - Do not allow OMO modes without OMO detected

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (depends on 16, 17)
  - **Blocks**: Task 21
  - **Blocked By**: Tasks 16, 17

  **References**:
  - OMO detector: `src/lib/omo.ts`
  - Plan copier: `src/lib/plan-copier.ts`
  - Launch tool: `src/tools/launch.ts`

  **Acceptance Criteria**:
  - [ ] Launch supports all modes
  - [ ] OMO modes validate OMO presence
  - [ ] Plans copied for OMO modes
  - [ ] `bun test tests/tools/launch.test.ts` passes (updated)

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: OMO modes work in launch
    Tool: Bash
    Steps:
      1. bun test tests/tools/launch.test.ts
      2. Assert: All tests pass including OMO modes
    Expected Result: OMO modes functional
  ```

  **Commit**: YES
  - Message: `feat(tools): add OMO modes to launch`
  - Files: `src/tools/launch.ts`, `tests/tools/launch.test.ts`

---

### Wave 6: Session Hooks

- [ ] 19. Implement job monitor

  **What to do**:
  - Create `src/lib/monitor.ts`
  - Implement hybrid monitoring:
    ```typescript
    class JobMonitor {
      // Start monitoring all running jobs
      start(): void
      
      // Stop monitoring
      stop(): void
      
      // Event emitter for job completion
      on(event: 'complete' | 'failed', handler: (job: Job) => void): void
    }
    ```
  - Monitoring approaches:
    1. **tmux hooks**: Set `pane-died` hook on launch to write completion marker
    2. **Polling fallback**: Every 10s check if tmux session/window still exists
  - Update job state when completion detected

  **Must NOT do**:
  - Do not poll too frequently (10s minimum)
  - Do not block main thread

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (with Tasks 20-23)
  - **Blocks**: Task 20
  - **Blocked By**: Tasks 1, 2, 5

  **References**:
  - tmux: `src/lib/tmux.ts` - hooks
  - Job state: `src/lib/job-state.ts`

  **Acceptance Criteria**:
  - [ ] `src/lib/monitor.ts` exists
  - [ ] Detects job completion
  - [ ] Updates job state
  - [ ] `bun test tests/lib/monitor.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Monitor detects completion
    Tool: Bash
    Steps:
      1. bun test tests/lib/monitor.test.ts
      2. Assert: All tests pass
    Expected Result: Monitor functional
  ```

  **Commit**: YES
  - Message: `feat(lib): add job monitor`
  - Files: `src/lib/monitor.ts`, `tests/lib/monitor.test.ts`

---

- [ ] 20. Implement toast notifications

  **What to do**:
  - Create `src/hooks/notifications.ts`
  - Hook into monitor events:
    ```typescript
    // On job complete:
    // - Show toast "Job 'feature-auth' completed successfully"
    
    // On job failed:
    // - Show toast "Job 'feature-auth' failed (exit code 1)"
    ```
  - Use OpenCode's notification system (if available) or console output

  **Must NOT do**:
  - Do not use system notifications (stay in terminal)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (with Tasks 19, 21-23)
  - **Blocks**: Task 24
  - **Blocked By**: Task 19

  **References**:
  - Monitor: `src/lib/monitor.ts`

  **Acceptance Criteria**:
  - [ ] `src/hooks/notifications.ts` exists
  - [ ] Shows notifications on job events
  - [ ] `bun test tests/hooks/notifications.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Notifications fire
    Tool: Bash
    Steps:
      1. bun test tests/hooks/notifications.test.ts
      2. Assert: All tests pass
    Expected Result: Notifications functional
  ```

  **Commit**: YES
  - Message: `feat(hooks): add toast notifications`
  - Files: `src/hooks/notifications.ts`, `tests/hooks/notifications.test.ts`

---

- [ ] 21. Implement auto-status on idle hook

  **What to do**:
  - Create `src/hooks/auto-status.ts`
  - Hook that fires when OpenCode goes idle:
    ```typescript
    // Guard conditions (ALL must be true):
    // 1. isCommandCenter(cwd) - not inside a job's worktree
    // 2. .mission-control/jobs.json exists - MC has been used
    // 3. Running jobs > 0 - has something to report
    // 4. 5+ minutes since last status - rate limiting
    
    function shouldShowAutoStatus(): boolean
    
    function getAutoStatusMessage(): string
    // Returns summary of running jobs
    ```

  **Must NOT do**:
  - Do not show status too frequently
  - Do not show if no running jobs

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (with Tasks 19-20, 22-23)
  - **Blocks**: Task 24
  - **Blocked By**: Tasks 1, 5, 18

  **References**:
  - Job state: `src/lib/job-state.ts`
  - worktree: `src/lib/worktree.ts` - isInManagedWorktree

  **Acceptance Criteria**:
  - [ ] `src/hooks/auto-status.ts` exists
  - [ ] All guard conditions implemented
  - [ ] Rate limiting works
  - [ ] `bun test tests/hooks/auto-status.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Auto-status guards work
    Tool: Bash
    Steps:
      1. bun test tests/hooks/auto-status.test.ts
      2. Assert: All tests pass
    Expected Result: Auto-status functional
  ```

  **Commit**: YES
  - Message: `feat(hooks): add auto-status on idle`
  - Files: `src/hooks/auto-status.ts`, `tests/hooks/auto-status.test.ts`

---

- [ ] 22. Implement worktree awareness hook

  **What to do**:
  - Create `src/hooks/awareness.ts`
  - Detects when running inside a managed worktree:
    ```typescript
    // On OpenCode start in a managed worktree:
    // - Log: "Mission Control: Working in job 'feature-auth'"
    // - Provide context about the job
    
    function getWorktreeContext(): {
      isInJob: boolean;
      jobName?: string;
      jobPrompt?: string;
      mode?: string;
    }
    ```

  **Must NOT do**:
  - Do not modify behavior, just provide context

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (with Tasks 19-21, 23)
  - **Blocks**: Task 24
  - **Blocked By**: Tasks 1, 3

  **References**:
  - worktree: `src/lib/worktree.ts`
  - Job state: `src/lib/job-state.ts`

  **Acceptance Criteria**:
  - [ ] `src/hooks/awareness.ts` exists
  - [ ] Detects job context
  - [ ] `bun test tests/hooks/awareness.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Awareness detects job
    Tool: Bash
    Steps:
      1. bun test tests/hooks/awareness.test.ts
      2. Assert: All tests pass
    Expected Result: Awareness functional
  ```

  **Commit**: YES
  - Message: `feat(hooks): add worktree awareness`
  - Files: `src/hooks/awareness.ts`, `tests/hooks/awareness.test.ts`

---

- [ ] 23. Implement compaction context hook

  **What to do**:
  - Create `src/hooks/compaction.ts`
  - Preserves job state through session compaction:
    ```typescript
    // When OpenCode compacts session, include:
    // - Number of running jobs
    // - Job names and statuses
    // - Current worktree context (if in a job)
    
    function getCompactionContext(): string
    ```

  **Must NOT do**:
  - Do not include full job details (just summary)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (with Tasks 19-22)
  - **Blocks**: Task 24
  - **Blocked By**: Task 1

  **References**:
  - Job state: `src/lib/job-state.ts`

  **Acceptance Criteria**:
  - [ ] `src/hooks/compaction.ts` exists
  - [ ] Returns useful context
  - [ ] `bun test tests/hooks/compaction.test.ts` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Compaction context works
    Tool: Bash
    Steps:
      1. bun test tests/hooks/compaction.test.ts
      2. Assert: All tests pass
    Expected Result: Compaction functional
  ```

  **Commit**: YES
  - Message: `feat(hooks): add compaction context`
  - Files: `src/hooks/compaction.ts`, `tests/hooks/compaction.test.ts`

---

### Wave 7: Polish

- [ ] 24. Create plugin entry point using @opencode-ai/plugin SDK

  **What to do**:
  - Update `src/index.ts`
  - Export plugin function using the `Plugin` type from `@opencode-ai/plugin`:
    ```typescript
    import type { Plugin } from "@opencode-ai/plugin"
    import { tool } from "@opencode-ai/plugin"

    // Import all tool implementations
    import { launchTool } from "./tools/launch"
    import { jobsTool } from "./tools/jobs"
    import { statusTool } from "./tools/status"
    import { attachTool } from "./tools/attach"
    import { captureTool } from "./tools/capture"
    import { killTool } from "./tools/kill"
    import { cleanupTool } from "./tools/cleanup"
    import { prTool } from "./tools/pr"
    import { diffTool } from "./tools/diff"
    import { syncTool } from "./tools/sync"
    import { mergeTool } from "./tools/merge"

    // Import hook implementations
    import { createMonitor } from "./lib/monitor"
    import { createAutoStatus } from "./hooks/auto-status"
    import { createAwareness } from "./hooks/awareness"

    export const MissionControl: Plugin = async ({ project, client, $, directory, worktree }) => {
      // Initialize job monitor
      const monitor = createMonitor(...)
      monitor.start()

      return {
        // Register all 11 tools via tool() helper
        tool: {
          mc_launch: launchTool(/* pass context */),
          mc_jobs: jobsTool(/* ... */),
          mc_status: statusTool(/* ... */),
          mc_attach: attachTool(/* ... */),
          mc_capture: captureTool(/* ... */),
          mc_kill: killTool(/* ... */),
          mc_cleanup: cleanupTool(/* ... */),
          mc_pr: prTool(/* ... */),
          mc_diff: diffTool(/* ... */),
          mc_sync: syncTool(/* ... */),
          mc_merge: mergeTool(/* ... */),
        },

        // Event hook — handles session.idle (auto-status), session.created (awareness)
        event: async ({ event }) => {
          if (event.type === "session.idle") {
            // Auto-status: show running job summary if conditions met
          }
        },

        // Compaction hook — preserve job context through compaction
        "experimental.session.compacting": async (input, output) => {
          output.context.push(getCompactionContext())
        },
      }
    }

    export default MissionControl
    ```
  - Ensure package.json `main` points to built entry point
  - Ensure `exports` field is correct for npm consumption

  **Must NOT do**:
  - Do not use `@modelcontextprotocol/sdk` — use `@opencode-ai/plugin`
  - Do not use MCP Server pattern — use Plugin function pattern
  - Do not add unnecessary exports

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (integrates everything)
  - **Blocks**: Tasks 25-27
  - **Blocked By**: All previous tasks

  **References**:

  **Pattern References** (existing plugin implementations):
  - `~/development/OpenAgents/.opencode/plugin/agent-validator.ts` — Full plugin with tools + event hooks + state
  - `~/development/OpenAgents/.opencode/plugin/telegram-notify.ts` — Event-driven plugin
  - `~/.cache/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` — Plugin type + Hooks type definitions

  **API/Type References**:
  - `@opencode-ai/plugin`: `Plugin` type = `(input: PluginInput) => Promise<Hooks>`
  - `PluginInput`: `{ client, project, directory, worktree, serverUrl, $ }`
  - `tool()` helper: Creates tools with Zod arg schemas
  - Available hooks: `event`, `tool.execute.before`, `tool.execute.after`, `shell.env`, `experimental.session.compacting`
  - Available events: `session.idle`, `session.created`, `session.compacted`, `session.error`, `session.updated`, `message.updated`, etc.

  **External References**:
  - Official plugin docs: https://opencode.ai/docs/plugins/
  - All tools: `src/tools/*.ts`
  - All hooks: `src/hooks/*.ts`

  **Acceptance Criteria**:
  - [ ] `src/index.ts` exports `MissionControl` as `Plugin` type
  - [ ] All 11 tools registered via `tool()` helper
  - [ ] `event` hook handles `session.idle` for auto-status
  - [ ] `experimental.session.compacting` hook provides job context
  - [ ] `bun run build` succeeds with no errors
  - [ ] `bun test` — all tests pass
  - [ ] Plugin can be referenced in opencode.json: `"plugin": ["opencode-mission-control"]`

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Plugin builds and exports correctly
    Tool: Bash
    Steps:
      1. bun run build
      2. Assert: No TypeScript errors
      3. node -e "const p = require('./dist/index.js'); console.log(typeof p.MissionControl)"
      4. Assert: Output is "function"
    Expected Result: Plugin exports async function

  Scenario: Plugin registers in opencode config
    Tool: Bash
    Steps:
      1. Verify package.json has correct main/exports fields
      2. cat package.json | jq '.main'
      3. Assert: Points to dist/index.js or similar
      4. cat package.json | jq '.exports'
      5. Assert: Exports configured for both CJS and ESM
    Expected Result: npm package structure correct
  ```

  **Commit**: YES
  - Message: `feat: create plugin entry point with @opencode-ai/plugin SDK`
  - Files: `src/index.ts`, `package.json`

---

- [ ] 25. Write integration tests

  **What to do**:
  - Create `tests/integration/`
  - Test full workflows:
    1. Launch → Status → Capture → Kill → Cleanup
    2. Launch with OMO mode → Verify plans copied
    3. Launch → PR → Cleanup
    4. Multiple jobs in parallel
  - Use mock tmux where possible

  **Must NOT do**:
  - Do not require real tmux for CI

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 7 (with Tasks 26-27)
  - **Blocks**: None
  - **Blocked By**: Task 24

  **References**:
  - All tools and libs

  **Acceptance Criteria**:
  - [ ] Integration tests exist
  - [ ] Cover main workflows
  - [ ] `bun test tests/integration/` passes

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Integration tests pass
    Tool: Bash
    Steps:
      1. bun test tests/integration/
      2. Assert: All tests pass
    Expected Result: Integration tests complete
  ```

  **Commit**: YES
  - Message: `test: add integration tests`
  - Files: `tests/integration/*.test.ts`

---

- [ ] 26. Write documentation

  **What to do**:
  - Update `README.md` with:
    - Installation instructions
    - Quick start guide
    - All tools with examples
    - Configuration options
    - OMO integration guide
    - Troubleshooting

  **Must NOT do**:
  - Do not over-document (keep concise)

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 7 (with Tasks 25, 27)
  - **Blocks**: None
  - **Blocked By**: Task 24

  **References**:
  - All tools for examples

  **Acceptance Criteria**:
  - [ ] README.md complete
  - [ ] All tools documented
  - [ ] Examples work

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Docs are complete
    Tool: Bash
    Steps:
      1. cat README.md | grep -c "mc_"
      2. Assert: All 11 tools mentioned
    Expected Result: Documentation complete
  ```

  **Commit**: YES
  - Message: `docs: add comprehensive README`
  - Files: `README.md`

---

- [ ] 27. Copy plan to new project

  **What to do**:
  - Copy this plan file to the new project:
    - From: `.sisyphus/plans/mission-control-plugin.md`
    - To: `~/development/opencode-mission-control/.sisyphus/plans/mission-control-plugin.md`
  - This preserves the plan for reference in the new project

  **Must NOT do**:
  - Do not modify the plan

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 7 (final)
  - **Blocks**: None
  - **Blocked By**: Task 24

  **References**:
  - This plan file

  **Acceptance Criteria**:
  - [ ] Plan exists in new project
  - [ ] Content matches original

  **Agent-Executed QA Scenarios**:
  ```
  Scenario: Plan copied
    Tool: Bash
    Steps:
      1. diff .sisyphus/plans/mission-control-plugin.md ~/development/opencode-mission-control/.sisyphus/plans/mission-control-plugin.md
      2. Assert: Files identical
    Expected Result: Plan preserved in new project
  ```

  **Commit**: YES
  - Message: `docs: add original work plan`
  - Files: `.sisyphus/plans/mission-control-plugin.md`

---

## Commit Strategy

| Wave | Tasks | Commit Pattern |
|------|-------|----------------|
| 1 | 0 | Single commit for scaffold |
| 2 | 1-4 | One commit per lib file |
| 3 | 5-11 | One commit per tool |
| 4 | 12-15 | One commit per tool |
| 5 | 16-18 | One commit per feature |
| 6 | 19-23 | One commit per hook |
| 7 | 24-27 | One commit per task |

---

## Success Criteria

### Verification Commands
```bash
# Build succeeds
bun run build  # Expected: No errors

# All tests pass
bun run test  # Expected: All vitest tests pass

# Plugin exports correctly
node -e "const p = require('./dist/index.js'); console.log(typeof p.MissionControl)"  # Expected: "function"

# GitHub repo accessible
gh repo view nigel-dev/opencode-mission-control --json name  # Expected: shows repo name
```

### Final Checklist
- [ ] All 11 tools implemented and tested
- [ ] All 5 hooks implemented and tested
- [ ] OMO detection and integration working
- [ ] Documentation complete
- [ ] Plugin installable in OpenCode
- [ ] End-to-end workflow functions correctly
