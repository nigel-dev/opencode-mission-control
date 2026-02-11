# AGENTS.md

Guide for coding agents working on `opencode-mission-control` in ULW mode.

## Mission

- Keep changes small, safe, and shippable.
- Match existing repository patterns (TypeScript + Bun + one-tool-per-file design).
- Prefer deterministic behavior over clever behavior.

## Fast Project Map

- `src/index.ts` - plugin entry point, registers tools/hooks/commands.
- `src/tools/` - one file per MCP tool (`launch`, `merge`, `plan`, etc.).
- `src/lib/` - shared core logic (worktrees, tmux, monitor, orchestrator, merge train).
- `src/hooks/` - OpenCode lifecycle hooks.
- `tests/` - Bun test suite.

## ULW Working Rules

1. Implement exactly what was requested; do not add extra features.
2. For bug fixes: make minimal edits, avoid broad refactors.
3. Never use `as any`, `@ts-ignore`, or silent catch blocks.
4. Keep file ownership boundaries intact (tool logic in `src/tools`, shared logic in `src/lib`).
5. Do not commit unless explicitly asked.

## Build and Verify

Run these before marking work complete:

```bash
bun run build
bun test
```

If tests fail, identify whether failures are pre-existing vs introduced by your change.

## Manual Test Plan

- The operational manual E2E flow is in `MANUAL_TEST_PLAN.md`.
- For fast validation after changes, run the **Quick Smoke Test** section first.
- Use the **Nuclear Cleanup** sequence before and after manual testing to avoid leftover tmux sessions, worktrees, branches, and state files.
- Follow plan safety rules exactly: `tmc-` test naming, no remote push flows during testing (`mc_pr` is structural only), and explicit SHA-based resets.

## Release Notes for Agents

- npm package output is `dist/` only (`package.json -> files`).
- Automated release path is semantic-release via `.github/workflows/publish.yml` on `main`.
- Required secret for release workflow: `NPM_TOKEN`.
- Use Conventional Commits (`feat:`, `fix:`, `perf:`, `chore:`) so semantic versioning can compute releases.

## Collaboration Norms

- Explain what changed and where with exact file paths.
- Call out risks or assumptions explicitly.
- Keep docs updated when behavior or workflows change.

If in doubt: choose the simplest implementation that preserves existing behavior.
