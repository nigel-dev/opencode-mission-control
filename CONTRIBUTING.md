# Contributing to Mission Control

Thank you for your interest in contributing!

## Prerequisites
- [Bun](https://bun.sh)
- [git](https://git-scm.com)
- [OpenCode 2.x](https://opencode.ai/) (to run the plugin locally)

## Development Setup
1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   bun install
   ```
3. Typecheck and build the project:
   ```bash
   bun run typecheck
   bun run build
   ```
4. Run tests:
   ```bash
   bun run test
   ```

## Local Testing
To test your changes locally with OpenCode:
1. Point the `plugins` entry in your `opencode.json` to your local repository path.
2. OpenCode loads the plugin straight from `src/` (see `exports` in `package.json`), so after a change you only reload OpenCode. `bun run build` is a bundling check; nothing loads its output.
3. For end-to-end checks, follow `MANUAL_TEST_PLAN.md` (start with the Quick Smoke Test).

## Architecture Overview

Every job is a native OpenCode session running in its own git worktree, on the same server the plugin runs in. The codebase is organized like this:

```
src/
  index.ts              # Server part entry point — registers tools, hooks, commands
  tui.tsx               # TUI part entry point — footer, sidebar and dashboard (logic in tui/*.ts, views in tui/views.tsx)
  rpc.ts                # RPC contract shared by the server and TUI parts
  commands.ts           # Slash command registration and handler dispatch
  tools/                # One file per tool (mc_launch, mc_merge, etc.)
  hooks/                # OpenCode lifecycle hooks
    notifications.ts    # Job notifications, toasts and session title annotations
    compaction.ts       # Injects job state into the context on compaction
    awareness.ts        # Detects whether a session runs inside a job worktree
    auto-status.ts      # Rate-limited running-jobs summary toast
  lib/                  # Shared internal logic
    project-context.ts  # Per-project async context (runInProject, bindToProject, bindToDirectory)
    job-runtime.ts      # Create, prompt, stop, remove and read job sessions
    job-launcher.ts     # launchJob: worktree + session + job record (mc_launch and plans)
    monitor.ts          # Event-stream subscription + periodic reconcile of running jobs
    question-relay.ts   # Pending questions; relays permission requests to the user and denies unanswered ones
    permission-policy.ts # Decides how job permission requests are answered
    config.ts           # MCConfig, load/save, defaults
    schemas.ts          # Zod schemas for jobs, plans and config
    job-state.ts        # Job persistence (JSON on disk) and state migration
    orchestrator.ts     # Plan execution engine — dependency graph, reconciler loop
    orchestrator-singleton.ts # Per-project monitor and orchestrator instances
    merge-train.ts      # Sequential merge + test pipeline for plans
    integration.ts      # Integration branch management
    worktree.ts         # Git worktree creation/deletion
    worktree-setup.ts   # Post-create hooks (copy files, symlinks, commands)
    git.ts              # Low-level git command runner
    git-mutex.ts        # Serializes concurrent git operations
    plan-state.ts       # Plan persistence and gh auth validation
    plan-types.ts       # TypeScript types for plans and job specs
    paths.ts            # Data directory resolution, cached project id, canonical paths
    job-name.ts         # The job name rule (shared with the TUI part)
    worktree-status.ts  # Uncommitted changes in a job worktree, ignoring setup artifacts
    rpc-handlers.ts     # RPC methods served to the TUI part
    rpc-events.ts       # RPC events emitted to the TUI part
    reports.ts          # Agent status report storage
    model-tracker.ts    # Tracks which model each session is using
    toast.ts            # Toast emitter (server part → TUI part)
    notify.ts           # Shared notification callback
    utils.ts            # Formatting and file helpers
    providers/
      worktree-provider.ts  # Types shared by the worktree functions
```

### Key Design Decisions

- **One tool per file** in `src/tools/` — keeps each tool self-contained and easy to find.
- **Native sessions** (`lib/job-runtime.ts`) — jobs are OpenCode sessions on the plugin's own server; the plugin context is the client used to create, prompt, watch and stop them.
- **One launch path** (`lib/job-launcher.ts`) — `mc_launch` and the plan orchestrator both call `launchJob`.
- **Project context** (`lib/project-context.ts`) — the plugin runs inside a shared OpenCode server whose working directory is not the project, and one server can host several projects. Never rely on `process.cwd()`; use `getProjectDirectory()`, key module-level state by project directory, and wrap every callback handed to the host (tools, commands, hooks) with `bindToProject` / `bindToDirectory`.
- **No dynamic `import()` in `src/`** — it drops the project context in the OpenCode runtime. Use static imports.
- **Git mutex** (`lib/git-mutex.ts`) — all git operations are serialized to prevent concurrent worktree/merge conflicts.
- **Monitor** (`lib/monitor.ts`) — one subscription to the server event stream, routed to jobs by session ID, plus a reconcile pass every 10 seconds that reads each session's outcome and the job's `mc_report` file. A job is finished only by its session going idle; a report never finishes a job on its own.
- **Orchestrator** (`lib/orchestrator.ts`) — runs a 5-second reconciler loop that topologically sorts jobs, launches when deps are satisfied, and feeds completed jobs into the merge train. Any failed job pauses the plan at an `on_error` checkpoint.
- **One live orchestrator per project** (`lib/orchestrator-singleton.ts`) — tools get an orchestrator from `replaceSharedOrchestrator`, which disposes the previous one and waits for its in-flight reconcile pass. Never construct an `Orchestrator` in a tool, and dispose what you replace.
- **Merge train** (`lib/merge-train.ts`) — merges into an integration branch one job at a time, runs tests after each merge, and rolls back on failure.

## Pull Request Process
1. Fork the repo and create a branch from `main`.
2. Implement your changes.
3. Ensure `bun run typecheck`, `bun run build` and `bun run test` pass and code follows the style guide.
4. Submit a PR with a clear description of changes. PR titles follow Conventional Commits.

## Code Style
- Use **TypeScript**.
- Avoid explicit `any` types.
- Prefer **Bun APIs** over Node.js built-ins where applicable.
- Keep functions small and focused.

## Issues and Features
- Use the provided templates for bug reports and feature requests.
- Provide as much context as possible.
