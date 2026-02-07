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
