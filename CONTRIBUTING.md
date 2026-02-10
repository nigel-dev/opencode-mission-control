# Contributing to Mission Control

Thank you for your interest in contributing!

## Prerequisites
- [Bun](https://bun.sh)
- [tmux](https://github.com/tmux/tmux)
- [git](https://git-scm.com)

## Development Setup
1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   bun install
   ```
3. Build the project:
   ```bash
   bun run build
   ```
4. Run tests:
   ```bash
   bun run test
   ```

## Local Testing
To test your changes locally with OpenCode:
1. Point your `opencode.json` plugin path to your local repository path.
2. Use `bun run build` to update the `dist/` folder after changes.

## Architecture Overview

The codebase is organized into three main areas:

```
src/
  index.ts              # Plugin entry point — registers tools, hooks, commands
  commands.ts           # Slash command registration and handler dispatch
  tools/                # One file per MCP tool (mc_launch, mc_merge, etc.)
  hooks/                # OpenCode lifecycle hooks
    notifications.ts    # session.idle hook — toast notifications for running jobs
    compaction.ts       # session.compacting hook — injects job state into context
    awareness.ts        # Provides LLM awareness of MC capabilities
    auto-status.ts      # Auto-surfaces job status updates
  lib/                  # Shared internal logic
    config.ts           # MCConfig interface, load/save, defaults
    job-state.ts        # Job metadata persistence (JSON on disk)
    monitor.ts          # Background polling loop — pane health, idle detection
    orchestrator.ts     # Plan execution engine — dependency graph, reconciler loop
    merge-train.ts      # Sequential merge + test pipeline for plans
    integration.ts      # Integration branch management
    worktree.ts         # Git worktree creation/deletion
    worktree-setup.ts   # Post-create hooks (copy files, symlinks, commands)
    tmux.ts             # tmux session/window/pane management
    git.ts              # Low-level git command runner
    git-mutex.ts        # Serializes concurrent git operations
    plan-state.ts       # Plan persistence and gh auth validation
    plan-types.ts       # TypeScript types for plans and job specs
    plan-copier.ts      # Copies Sisyphus plan files to worktrees
    omo.ts              # Oh-My-OpenCode detection and mode handling
    paths.ts            # Data directory resolution
    prompt-file.ts      # Prompt file generation for spawned agents
    reports.ts          # Agent status report storage
    model-tracker.ts    # Tracks which model the parent session is using
    test-runner.ts      # Runs test commands in merge train
    providers/
      worktree-provider.ts  # Worktree resource provider
```

### Key Design Decisions

- **One tool per file** in `src/tools/` — keeps each tool self-contained and easy to find.
- **Git mutex** (`lib/git-mutex.ts`) — all git operations are serialized to prevent concurrent worktree/merge conflicts.
- **Monitor loop** (`lib/monitor.ts`) — polls at a configurable interval; uses tmux output hashing for idle detection.
- **Orchestrator** (`lib/orchestrator.ts`) — runs a 5-second reconciler loop that topologically sorts jobs, launches when deps are satisfied, and feeds completed jobs into the merge train.
- **Merge train** (`lib/merge-train.ts`) — merges into an integration branch one job at a time, runs tests after each merge, and rolls back on failure.

## Pull Request Process
1. Fork the repo and create a branch from `main`.
2. Implement your changes.
3. Ensure tests pass and code follows the style guide.
4. Submit a PR with a clear description of changes.

## Code Style
- Use **TypeScript**.
- Avoid explicit `any` types.
- Prefer **Bun APIs** over Node.js built-ins where applicable.
- Keep functions small and focused.

## Issues and Features
- Use the provided templates for bug reports and feature requests.
- Provide as much context as possible.
