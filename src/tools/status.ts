import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName, type Job } from '../lib/job-state';
import { capturePane } from '../lib/tmux';
import { isInManagedWorktree } from '../lib/worktree';
import { gitCommand } from '../lib/git';

async function getGitStatus(
  worktreePath: string,
): Promise<{
  filesChanged: number;
  ahead: number;
  behind: number;
  branch: string;
}> {
  try {
    const branchResult = await gitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
    });
    const branch = branchResult.exitCode === 0 ? branchResult.stdout : 'unknown';

    const statusResult = await gitCommand(['status', '--porcelain'], {
      cwd: worktreePath,
    });
    const filesChanged =
      statusResult.exitCode === 0
        ? statusResult.stdout.split('\n').filter(Boolean).length
        : 0;

    const aheadBehindResult = await gitCommand(
      ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
      { cwd: worktreePath },
    );

    let ahead = 0;
    let behind = 0;
    if (aheadBehindResult.exitCode === 0) {
      const [behindStr, aheadStr] = aheadBehindResult.stdout.split('\t');
      behind = parseInt(behindStr, 10) || 0;
      ahead = parseInt(aheadStr, 10) || 0;
    }

    return { filesChanged, ahead, behind, branch };
  } catch {
    return { filesChanged: 0, ahead: 0, behind: 0, branch: 'unknown' };
  }
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export const mc_status: ToolDefinition = tool({
  description: 'Get detailed status of a specific job',
  args: {
    name: tool.schema.string().describe('Job name'),
  },
  async execute(args) {
    // 1. Find job by name
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    // 2. Get git status
    const gitStatus = await getGitStatus(job.worktreePath);

    // 3. Check if worktree is managed
    const managedCheck = await isInManagedWorktree(job.worktreePath);

    // 4. Capture recent output from tmux pane (last 10 lines)
    let recentOutput = '';
    try {
      recentOutput = await capturePane(job.tmuxTarget, 10);
    } catch {
      recentOutput = '(unable to capture pane output)';
    }

    // 5. Calculate duration if running
    let duration = '';
    if (job.status === 'running') {
      const createdTime = new Date(job.createdAt).getTime();
      const now = Date.now();
      const durationMs = now - createdTime;
      duration = formatDuration(durationMs);
    } else if (job.completedAt) {
      const createdTime = new Date(job.createdAt).getTime();
      const completedTime = new Date(job.completedAt).getTime();
      const durationMs = completedTime - createdTime;
      duration = formatDuration(durationMs);
    }

    // 6. Format output
    const lines: string[] = [
      `Job: ${job.name}`,
      `Status: ${job.status}`,
      `ID: ${job.id}`,
      '',
      'Metadata:',
      `  Branch: ${job.branch}`,
      `  Mode: ${job.mode}`,
      `  Placement: ${job.placement}`,
      `  Created: ${new Date(job.createdAt).toISOString()}`,
      ...(job.completedAt ? [`  Completed: ${new Date(job.completedAt).toISOString()}`] : []),
      ...(duration ? [`  Duration: ${duration}`] : []),
      ...(job.exitCode !== undefined ? [`  Exit Code: ${job.exitCode}`] : []),
      '',
      'Paths:',
      `  Worktree: ${job.worktreePath}`,
      `  Managed: ${managedCheck.isManaged}`,
      `  tmux Target: ${job.tmuxTarget}`,
      ...(job.planFile ? [`  Plan File: ${job.planFile}`] : []),
      '',
      'Git Status:',
      `  Branch: ${gitStatus.branch}`,
      `  Files Changed: ${gitStatus.filesChanged}`,
      `  Ahead: ${gitStatus.ahead}`,
      `  Behind: ${gitStatus.behind}`,
      '',
      'Recent Output (last 10 lines):',
      '---',
      recentOutput || '(no output)',
      '---',
    ];

    return lines.join('\n');
  },
});
