import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { isInManagedWorktree } from '../lib/worktree';
import { getJobByName, loadJobState } from '../lib/job-state';
import { writeReport, type ReportStatus } from '../lib/reports';

export const mc_report: ToolDefinition = tool({
  description:
    'Report agent status back to Mission Control. Auto-detects which job is calling based on the current worktree.',
  args: {
    status: tool.schema
      .enum(['working', 'blocked', 'needs_review', 'completed', 'progress'])
      .describe(
        'Current status: working (actively coding), blocked (waiting/stuck), needs_review (done but needs human review), completed (work finished successfully), progress (milestone update)',
      ),
    message: tool.schema
      .string()
      .describe('Human-readable status message'),
    progress: tool.schema
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Completion percentage (0-100)'),
  },
  async execute(args) {
    const cwd = process.cwd();
    const managed = await isInManagedWorktree(cwd);

    if (!managed.isManaged || !managed.jobName) {
      throw new Error(
        'mc_report can only be used from within a managed Mission Control worktree.',
      );
    }

    const state = await loadJobState();
    // Match only running jobs to avoid picking up stale entries from previous runs
    // that share the same name/worktree path
    const job = state.jobs.find(
      (j) =>
        j.status === 'running' &&
        (j.worktreePath === managed.worktreePath ||
         j.name === managed.jobName),
    ) ?? state.jobs.find(
      (j) =>
        j.worktreePath === managed.worktreePath ||
        j.name === managed.jobName,
    );

    if (!job) {
      throw new Error(
        `No active job found for worktree "${managed.worktreePath}". The job may have been cleaned up.`,
      );
    }

    await writeReport({
      jobId: job.id,
      jobName: job.name,
      status: args.status as ReportStatus,
      message: args.message,
      progress: args.progress,
      timestamp: new Date().toISOString(),
    });

    const progressSuffix =
      args.progress !== undefined ? ` (${args.progress}%)` : '';
    return `Report submitted: [${args.status}]${progressSuffix} ${args.message}`;
  },
});
