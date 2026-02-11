import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName, type Job } from '../lib/job-state';
import { capturePane } from '../lib/tmux';
import { isInManagedWorktree } from '../lib/worktree';
import { gitCommand } from '../lib/git';
import { readReport } from '../lib/reports';
import { formatDurationMs } from '../lib/utils';

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

    // 4. Check for agent report
    const report = await readReport(job.id);

    // 5. Capture recent output from tmux pane (last 10 lines)
    let recentOutput = '';
    try {
      recentOutput = await capturePane(job.tmuxTarget, 10);
    } catch {
      recentOutput = '(unable to capture pane output)';
    }

    // 6. Calculate duration if running
    let duration = '';
    if (job.status === 'running') {
      const createdTime = new Date(job.createdAt).getTime();
      const now = Date.now();
      const durationMs = now - createdTime;
      duration = formatDurationMs(durationMs);
    } else if (job.completedAt) {
      const createdTime = new Date(job.createdAt).getTime();
      const completedTime = new Date(job.completedAt).getTime();
      const durationMs = completedTime - createdTime;
      duration = formatDurationMs(durationMs);
    }

    // 7. Format output
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
      ...(report
        ? [
            'Agent Report:',
            `  Status: ${report.status}`,
            `  Message: ${report.message}`,
            ...(report.progress !== undefined
              ? [`  Progress: ${report.progress}%`]
              : []),
            `  Reported At: ${report.timestamp}`,
            '',
          ]
        : []),
      'Recent Output (last 10 lines):',
      '---',
      recentOutput || '(no output)',
      '---',
    ];

    return lines.join('\n');
  },
});
