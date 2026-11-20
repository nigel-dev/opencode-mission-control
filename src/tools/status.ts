import { z } from 'zod';
import { getJobByName } from '../lib/job-state';
import { captureJobSession, getJobUsage, type JobUsage } from '../lib/job-runtime';
import { isInManagedWorktree } from '../lib/worktree';
import { gitCommand } from '../lib/git';
import { readReport } from '../lib/reports';
import { formatDurationMs, formatTimeAgo } from '../lib/utils';
import { getSharedMonitor } from '../lib/orchestrator-singleton';

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
    // The worktree is gone (git cannot even start there): status still renders.
    return { filesChanged: 0, ahead: 0, behind: 0, branch: 'unknown' };
  }
}



export const mc_status = {
  name: 'mc_status',
  description: 'Get detailed status of a specific job',
  input: z.object({
    name: z.string().describe('Job name'),
  }).strict(),
  async execute(args: { name: string }) {
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

    // 5. Capture the tail of the job's transcript (last 10 lines)
    let recentOutput = '';
    if (job.sessionID) {
      try {
        recentOutput = await captureJobSession(job.sessionID, 10);
      } catch {
        // The session may have been deleted; status must still render.
        recentOutput = '(unable to capture session output)';
      }
    } else {
      recentOutput = '(no session)';
    }

    // 5b. Cost and tokens for a running job
    let usage: JobUsage | undefined;
    if (job.status === 'running' && job.sessionID) {
      try {
        usage = await getJobUsage(job.sessionID);
      } catch {
        // Usage is informational: omit it when the session cannot be read.
        usage = undefined;
      }
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

    // 7. Activity the monitor accumulated from the job's session events
    let activity: string[] = [];
    const accumulator = getSharedMonitor().getEventAccumulator(job.id);
    if (accumulator) {
      const activityTime = formatTimeAgo(new Date(accumulator.lastActivityAt).toISOString());
      activity = [
        'Session Activity:',
        `  Session State: ${accumulator.currentTool || 'idle'}`,
        `  Current File: ${accumulator.currentFile || '(none)'}`,
        `  Files Edited: ${accumulator.filesEdited.length}`,
        ...(accumulator.filesEdited.length > 0
          ? accumulator.filesEdited.map((f) => `    - ${f}`)
          : []),
        `  Last Activity: ${activityTime}`,
        `  Events Accumulated: ${accumulator.eventCount}`,
        '',
      ];
    }

    // 8. Format output
    const lines: string[] = [
      `Job: ${job.name}`,
      `Status: ${job.status}`,
      ...(job.status === 'failed' && job.failureReason ? [`Reason: ${job.failureReason}`] : []),
      ...(job.uncommittedChanges && job.uncommittedChanges.length > 0
        ? [
            `Needs review: finished with ${job.uncommittedChanges.length} uncommitted file(s) that are not on its branch:`,
            ...job.uncommittedChanges.slice(0, 20).map((file) => `  - ${file}`),
            ...(job.uncommittedChanges.length > 20 ? [`  - ... and ${job.uncommittedChanges.length - 20} more`] : []),
          ]
        : []),
      `ID: ${job.id}`,
      '',
      'Metadata:',
      `  Branch: ${job.branch}`,
      ...(job.sessionID ? [`  Session: ${job.sessionID}`] : []),
      ...(job.agent ? [`  Agent: ${job.agent}`] : []),
      ...(job.model ? [`  Model: ${job.model}`] : []),
      `  Created: ${new Date(job.createdAt).toISOString()}`,
      ...(job.completedAt ? [`  Completed: ${new Date(job.completedAt).toISOString()}`] : []),
      ...(duration ? [`  Duration: ${duration}`] : []),
      ...(usage
        ? [
            `  Cost: $${usage.cost.toFixed(4)}`,
            `  Tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`,
          ]
        : []),
      '',
      'Paths:',
      `  Worktree: ${job.worktreePath}`,
      `  Managed: ${managedCheck.isManaged}`,
      '',
      'Git Status:',
      `  Branch: ${gitStatus.branch}`,
      `  Files Changed: ${gitStatus.filesChanged}`,
      `  Ahead: ${gitStatus.ahead}`,
      `  Behind: ${gitStatus.behind}`,
      '',
      ...activity,
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

    return { content: lines.join('\n') };
  },
};
