# OpenCode Mission Control

[![npm version](https://img.shields.io/npm/v/opencode-mission-control.svg)](https://www.npmjs.com/package/opencode-mission-control)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/nigel-dev/opencode-mission-control.svg)](https://github.com/nigel-dev/opencode-mission-control/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/nigel-dev/opencode-mission-control.svg)](https://github.com/nigel-dev/opencode-mission-control/issues)

**Parallelize your AI agents without losing your mind.**

### The Problem
AI coding is fast, but context switching is slow. Running multiple agents in a single directory leads to file conflicts, messy git history, and "who-changed-what" headaches. You end up waiting for one agent to finish before starting the next, wasting the most valuable resource you have: your time.

### How it Works
Mission Control orchestrates isolated environments for your AI agents. When you launch a job, it creates a dedicated git worktree and a tmux session. The agent works in total isolation. You can monitor progress, capture terminal output, or attach to the session at any time. Once the work is done, sync the changes back or create a PR with a single command.

### When to Use
Use Mission Control when you have 3+ independent features or bugs to tackle simultaneously. While `opencode-worktree` provides the foundation, Mission Control provides the *lifecycle*—from launch to PR to cleanup.

### Installation
```bash
npm install opencode-mission-control
```

Add it to your `opencode.json`:
```json
{
  "plugins": [
    "opencode-mission-control"
  ]
}
```

### Tools Reference

#### Job Lifecycle
| Tool | Description |
| :--- | :--- |
| `mc_launch` | Spawn a new agent in an isolated worktree and tmux session. |
| `mc_jobs` | List all active, completed, and failed jobs. |
| `mc_status` | Get a detailed heartbeat of a specific job. |
| `mc_attach` | Get the command to jump directly into a job's terminal. |
| `mc_capture` | Grab the last N lines of terminal output from a running job. |
| `mc_kill` | Stop a runaway agent by terminating its tmux session. |
| `mc_cleanup` | Wipe away worktrees and metadata for finished jobs. |

#### Git Workflow
| Tool | Description |
| :--- | :--- |
| `mc_diff` | Compare a job's progress against your base branch. |
| `mc_pr` | Push changes and open a GitHub PR (requires `gh` CLI). |
| `mc_sync` | Rebase or merge the latest changes from main into a job. |
| `mc_merge` | Bring a job's completed work back into your current branch. |

### Example Interaction
**User**: "I need to fix the login bug and also add the new pricing table. Can you do both at once?"

**AI**: "I'll handle those in parallel. I'm launching two Mission Control jobs now."
*AI calls `mc_launch` for 'fix-login' and 'add-pricing'*

**User**: "How's the login fix coming along?"

**AI**: "It's still running. Here's the latest terminal output from that session."
*AI calls `mc_capture` to show progress*

### Configuration
Mission Control looks for `.mission-control/config.json` in your project root.

```json
{
  "defaultPlacement": "session",
  "pollInterval": 10000,
  "worktreeBasePath": "~/.local/share/opencode-mission-control",
  "omo": {
    "enabled": true,
    "defaultMode": "vanilla"
  }
}
```

### OMO Integration (Optional)
If you use **Oh-My-OpenCode (OMO)**, Mission Control unlocks advanced execution modes. These are entirely optional and only activate if OMO is detected.

- **vanilla**: Standard execution.
- **plan**: Executes a specific Sisyphus plan.
- **ralph**: Starts a self-correcting Ralph Loop.
- **ulw**: High-intensity Ultrawork mode.

### What's Running Under the Hood
Mission Control isn't just a wrapper; it's an active monitor.
- **session.idle**: Automatically reports job status when your main session is quiet.
- **session.compacting**: Injects job context into the AI's memory during compaction.
- **tmux monitor**: A background process that detects when a tmux pane dies and updates job status immediately.

### Prerequisites
- **tmux**: Required for session isolation.
- **git**: Required for worktree management.
- **gh CLI**: Required only if you use `mc_pr`.

### Limitations & Heads Up
- **Local Resources**: Each job is a real process. Launching 20 jobs will tax your CPU and RAM.
- **Worktree Isolation**: Changes in one worktree are not visible to others until committed and synced.
- **v0.1.0**: This is early software. Expect sharp edges.

### FAQ
**Q: Where are the files stored?**
A: By default, in `~/.local/share/opencode-mission-control`. They are real git worktrees.

**Q: Can I use this without tmux?**
A: No. tmux is the backbone of the session isolation and monitoring.

**Q: Does it work with VS Code?**
A: Yes, you can open the worktree directories in VS Code, but the AI agents run in the background tmux sessions.

**Q: What happens if my computer restarts?**
A: Mission Control will detect the dead sessions on the next launch and mark them as failed. You can then use `mc_cleanup`.

**Q: Is this built by the OpenCode team?**
A: No. This is an independent community plugin.

### Disclaimer
This project is **not affiliated with, endorsed by, or built by the OpenCode team**. It is a community-driven extension.

### License
MIT

### Contributing
Found a bug? Have an idea? Check out [CONTRIBUTING.md](CONTRIBUTING.md).

### Development
```bash
bun install
bun run build
bun run test
```
