import { existsSync } from 'fs';
import { z } from 'zod';
import { getJobByName, removeJob, loadJobState, type Job } from '../lib/job-state';
import { removeWorktree } from '../lib/worktree';
import { gitCommand } from '../lib/git';
import { removeReport } from '../lib/reports';
import { removeJobSession, stopJobSession, clearBackgroundWork } from '../lib/job-runtime';
import { loadPlan } from '../lib/plan-state';
import type { PlanSpec } from '../lib/plan-types';
import { findUncommittedChanges } from '../lib/worktree-status';

interface SkippedJob {
  job: Job;
  reason: string;
}

const TERMINAL_PLAN_STATUSES: PlanSpec['status'][] = ['completed', 'failed', 'canceled'];

/** The plan whose jobs must not be cleaned up from under it, if there is one. */
async function loadActivePlan(): Promise<PlanSpec | null> {
  let plan: PlanSpec | null;
  try {
    plan = await loadPlan();
  } catch (error) {
    // An unreadable plan file protects nothing; say so and carry on.
    console.warn('[Mission Control] Could not load the plan while cleaning up:', error);
    return null;
  }
  return plan && !TERMINAL_PLAN_STATUSES.includes(plan.status) ? plan : null;
}

function planReason(plan: PlanSpec): string {
  return `it belongs to the active plan "${plan.name}" (${plan.status}); the plan still needs its worktree and branch`;
}

/**
 * Why the job's worktree must not be removed without `force`, or undefined
 * when it holds nothing that would be lost.
 */
async function uncommittedReason(job: Job): Promise<string | undefined> {
  if (!job.worktreePath || !existsSync(job.worktreePath)) {
    return undefined;
  }

  let changes: string[];
  try {
    changes = await findUncommittedChanges(job);
  } catch (error) {
    return `its worktree could not be checked for uncommitted changes (${error instanceof Error ? error.message : String(error)})`;
  }
  if (changes.length === 0) {
    return undefined;
  }
  const listed = changes.slice(0, 10).join(', ');
  return `its worktree has uncommitted changes that would be lost: ${listed}${changes.length > 10 ? `, and ${changes.length - 10} more` : ''}`;
}

async function deleteBranch(branchName: string): Promise<void> {
  const result = await gitCommand(['branch', '-D', branchName]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to delete branch "${branchName}": ${result.stderr}`);
  }
}

function validateCleanupArgs(args: { name?: string; all?: boolean }): void {
  if (!args.name && !args.all) {
    throw new Error('Must specify either "name" or "all" argument');
  }

  if (args.name && args.all) {
    throw new Error('Cannot specify both "name" and "all" arguments');
  }
}

async function determineJobsToClean(args: {
  name?: string;
  all?: boolean;
  force?: boolean;
}): Promise<{ jobs: Job[]; skipped: SkippedJob[] }> {
  const activePlan = await loadActivePlan();

  if (args.name) {
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    if (job.status === 'running') {
      throw new Error(
        `Cannot cleanup running job "${args.name}". Use mc_kill to stop it first.`,
      );
    }

    if (activePlan && job.planId === activePlan.id && !args.force) {
      throw new Error(
        `Cannot cleanup job "${args.name}": ${planReason(activePlan)}. ` +
          'Cancel the plan with mc_plan_cancel, or pass force: true to remove this job anyway.',
      );
    }

    return { jobs: [job], skipped: [] };
  }

  const state = await loadJobState();
  const jobs: Job[] = [];
  const skipped: SkippedJob[] = [];
  for (const job of state.jobs) {
    if (job.status === 'running') {
      continue;
    }
    // "all" never reaches into an active plan, forced or not: name the job to do that.
    if (activePlan && job.planId === activePlan.id) {
      skipped.push({ job, reason: planReason(activePlan) });
      continue;
    }
    jobs.push(job);
  }
  return { jobs, skipped };
}

/**
 * Stop and delete the job's session. A session that no longer exists (already
 * deleted in the TUI, or a server that was reset) must not block the cleanup of
 * the worktree, so failures are logged and tolerated.
 */
async function removeSessionTolerantly(job: Job): Promise<void> {
  if (!job.sessionID) {
    return;
  }

  try {
    await stopJobSession(job.sessionID);
  } catch (error) {
    console.warn(
      `[Mission Control] Could not stop session ${job.sessionID} of job "${job.name}" (it may already be gone):`,
      error,
    );
  }

  try {
    await removeJobSession(job.sessionID);
  } catch (error) {
    console.warn(
      `[Mission Control] Could not remove session ${job.sessionID} of job "${job.name}" (it may already be gone):`,
      error,
    );
  }
}

async function cleanupJobs(
  jobs: Job[],
  options: { deleteBranch?: boolean; force?: boolean; named: boolean },
): Promise<{ results: string[]; errors: string[]; skipped: SkippedJob[] }> {
  const results: string[] = [];
  const errors: string[] = [];
  const skipped: SkippedJob[] = [];

  for (const job of jobs) {
    try {
      if (!options.force) {
        // Checked before anything is removed: a refused cleanup changes nothing.
        const reason = await uncommittedReason(job);
        if (reason) {
          if (options.named) {
            throw new Error(`${reason}. Commit or discard them, or pass force: true to remove the worktree anyway.`);
          }
          skipped.push({ job, reason });
          continue;
        }
      }

      await removeSessionTolerantly(job);

      await removeWorktreeWithFallback(job.worktreePath);
      clearBackgroundWork(job.worktreePath);
      if (options.deleteBranch) {
        await deleteBranchWithFallback(job.branch);
      }
      await removeReport(job.id).catch((error: unknown) => {
        console.warn(`[Mission Control] Could not remove the report of job "${job.name}":`, error);
      });
      await removeJob(job.id);

      results.push(
        `✓ Cleaned up job "${job.name}" (${job.status})${options.deleteBranch ? ' and deleted branch' : ''}`,
      );
    } catch (error) {
      errors.push(
        `✗ Failed to cleanup job "${job.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { results, errors, skipped };
}

async function removeWorktreeWithFallback(worktreePath: string): Promise<void> {
  try {
    await removeWorktree(worktreePath, true);
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not exist')) {
      return;
    }
    if (!existsSync(worktreePath)) {
      // Already removed (for example by mc_plan_cancel): drop git's stale record of it.
      await gitCommand(['worktree', 'prune']);
      return;
    }
    throw error;
  }
}

async function deleteBranchWithFallback(branchName: string): Promise<void> {
  try {
    await deleteBranch(branchName);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('not found')
    ) {
      return;
    }
    throw error;
  }
}

function formatSkipped(skipped: SkippedJob[]): string[] {
  if (skipped.length === 0) {
    return [];
  }
  return [
    'Skipped:',
    ...skipped.map(({ job, reason }) => `- "${job.name}": ${reason}`),
    'Clean up a skipped job by name with force: true to remove it anyway.',
    '',
  ];
}

function formatCleanupOutput(
  results: string[],
  errors: string[],
  skipped: SkippedJob[],
): string {
  const output: string[] = ['Cleanup Results', '===============', ''];

  if (results.length > 0) {
    output.push('Successful:');
    output.push(...results);
    output.push('');
  }

  output.push(...formatSkipped(skipped));

  if (errors.length > 0) {
    output.push('Errors:');
    output.push(...errors);
    output.push('');
  }

  output.push(
    `Summary: ${results.length} cleaned, ${errors.length} failed${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`,
  );

  if (errors.length > 0) {
    throw new Error(output.join('\n'));
  }

  return output.join('\n');
}

export const mc_cleanup = {
  name: 'mc_cleanup',
  description: 'Remove completed/stopped jobs and their worktrees',
  input: z.object({
    name: z.string().optional().describe('Specific job to cleanup (by name)'),
    all: z.boolean().optional().describe('Cleanup all non-running jobs (jobs of an active plan are skipped)'),
    deleteBranch: z.boolean().optional().describe('Also delete the git branch'),
    force: z.boolean().optional().describe('Remove a worktree even if it has uncommitted changes; with "name", also remove a job that belongs to an active plan'),
  }).strict(),
  async execute(args: { name?: string; all?: boolean; deleteBranch?: boolean; force?: boolean }) {
    validateCleanupArgs(args);

    const { jobs, skipped: planSkipped } = await determineJobsToClean(args);
    if (jobs.length === 0) {
      return { content: ['No non-running jobs to cleanup.', '', ...formatSkipped(planSkipped)].join('\n').trimEnd() };
    }

    const { results, errors, skipped } = await cleanupJobs(jobs, {
      deleteBranch: args.deleteBranch,
      force: args.force,
      named: Boolean(args.name),
    });
    return { content: formatCleanupOutput(results, errors, [...planSkipped, ...skipped]) };
  },
};
