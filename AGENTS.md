# AGENTS.md

Guide for coding agents working on `opencode-mission-control` in ULW mode.

> NOTE! Never replace the string opencode with claude or claude code unless explicitly asked to.

## Mission

- Keep changes small, safe, and shippable.
- Match existing repository patterns (TypeScript + Bun + one-tool-per-file design).
- Prefer deterministic behavior over clever behavior.

## Fast Project Map

- `src/index.ts` - server part entry point, registers tools/hooks/commands.
- `src/tui.tsx` - TUI part (loaded by the same plugin entry; pure logic in `src/tui/*.ts`, views in `src/tui/views.tsx`); `src/rpc.ts` - RPC contract between the two parts.
- `src/tools/` - one file per MCP tool (`launch`, `merge`, `plan`, etc.).
- `src/lib/` - shared core logic (worktrees, monitor, orchestrator, merge train).
  - `src/lib/orchestrator-singleton.ts` - the one live orchestrator per project (`replaceSharedOrchestrator`); never construct an `Orchestrator` in a tool.
  - `src/lib/job-runtime.ts` - jobs as native OpenCode sessions (create, prompt, stop, remove, read).
  - `src/lib/job-launcher.ts` - `launchJob`, the single launch path for `mc_launch` and plans.
  - `src/lib/project-context.ts` - per-project async context (`runInProject`, `bindToProject`, `bindToDirectory`).
- `src/hooks/` - OpenCode lifecycle hooks.
- `tests/` - Bun test suite.

## ULW Working Rules

1. Implement exactly what was requested; do not add extra features.
2. For bug fixes: make minimal edits, avoid broad refactors.
3. Never use `as any`, `@ts-ignore`, or silent catch blocks.
4. Keep file ownership boundaries intact (tool logic in `src/tools`, shared logic in `src/lib`).
5. Do not commit unless explicitly asked.
6. Code runs in a shared server process: never rely on `process.cwd()`. Use the project context (`getProjectDirectory()`), and bind every callback handed to the host (tools, commands, hooks) with `bindToProject` / `bindToDirectory`.
7. Never use dynamic `import()` in `src/` — it drops the project context in the OpenCode runtime.
8. Each location (the project, every job worktree) loads its own copy of the plugin's modules: module state is never shared between the command center and a job's instance. A plugin context also reaches only its own location, so act on a job's permission requests from the job worktree's instance (see `src/lib/job-permissions.ts`), and pass anything else between instances through files.

## Build and Verify

Run these before marking work complete:

```bash
bun run typecheck
bun run build
bun run test
```

If tests fail, identify whether failures are pre-existing vs introduced by your change.

## Manual Test Plan

- The operational manual E2E flow is in `MANUAL_TEST_PLAN.md`.
- For fast validation after changes, run the **Quick Smoke Test** section first.
- Use the **Nuclear Cleanup** sequence before and after manual testing to avoid leftover job sessions, worktrees, branches, and state files.
- Follow plan safety rules exactly: `tmc-` test naming, no remote push flows during testing (`mc_pr` is structural only), and explicit SHA-based resets.

## CI & GitHub Workflows

- **CI** (`.github/workflows/ci.yml`) — Pins Bun 1.3.14, installs with `bun install --frozen-lockfile`, then runs `bun run build`, `bun run typecheck` and `bun test` once per test file (`tests/**/*.test.ts`) on PRs and pushes to `main`.
- **Conventional Commits** (`.github/workflows/conventional-commits.yml`) — Validates PR titles follow the convention.
- **CodeQL** (`.github/workflows/codeql.yml`) — Static analysis for TypeScript; runs on PRs, pushes to `main`, and weekly.
- **Publish** (`.github/workflows/publish.yml`) — On pushes to `main` (or manually, with an optional dry run): build, per-file tests, then semantic-release to npm.
- **Renovate** (`renovate.json`) — Automated dependency updates via the Renovate GitHub App. Groups non-major npm updates, creates separate PRs for majors, and auto-merges minor/patch. Uses `chore(deps):` and `ci(deps):` commit prefixes.

## Branch & Merge Rules

- Direct pushes to `main` are blocked; all changes go through PRs.
- Merge commits are disabled — only **squash** and **rebase** merges are allowed.
- PRs require 1 approving review, passing `build-and-test` and `conventional-commits` checks, and all conversations resolved.
- A PR template (`.github/pull_request_template.md`) is provided — fill it out when opening PRs.

## Release Notes for Agents

- The npm package ships `src/` (`package.json -> files`); OpenCode loads the server part, the TUI part and the RPC contract from there (`package.json -> exports`). `bun run build` only checks that the server part (`src/index.ts`) and the RPC contract (`src/rpc.ts`) bundle; it does not bundle the TUI part.
- Automated release path is semantic-release via `.github/workflows/publish.yml` on `main`.
- npm publishing uses OIDC trusted publishing with provenance (`id-token: write` in `publish.yml`, `publishConfig.provenance` in `package.json`); no `NPM_TOKEN` secret is used.
- Use Conventional Commits (`feat:`, `fix:`, `perf:`, `chore:`) so semantic versioning can compute releases. A breaking change is `!` after the type (`feat!:`) or a `BREAKING CHANGE:` footer; both produce a major release (`.releaserc.json` uses the `conventionalcommits` preset, checked by `tests/release-config.test.ts`).

## Collaboration Norms

- Explain what changed and where with exact file paths.
- Call out risks or assumptions explicitly.
- Keep docs updated when behavior or workflows change.

If in doubt: choose the simplest implementation that preserves existing behavior.
