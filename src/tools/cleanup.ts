import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName, removeJob, getRunningJobs, loadJobState } from '../lib/job-state';
import { removeWorktree } from '../lib/worktree';
import { spawn } from 'bun';

async function deleteBranch(branchName: string): Promise<void> {
  const proc = spawn(['git', 'branch', '-D', branchName], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to delete branch "${branchName}": ${stderr}`);
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
}): Promise<any[]> {
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

    return [job];
  }

  const state = await loadJobState();
  return state.jobs.filter((j) => j.status !== 'running');
}

async function cleanupJobs(
  jobs: any[],
  shouldDeleteBranch?: boolean,
): Promise<{ results: string[]; errors: string[] }> {
  const results: string[] = [];
  const errors: string[] = [];

  for (const job of jobs) {
    try {
      await removeWorktreeWithFallback(job.worktreePath);
      if (shouldDeleteBranch) {
        await deleteBranchWithFallback(job.branch);
      }
      await removeJob(job.id);

      results.push(
        `✓ Cleaned up job "${job.name}" (${job.status})${shouldDeleteBranch ? ' and deleted branch' : ''}`,
      );
    } catch (error) {
      errors.push(
        `✗ Failed to cleanup job "${job.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { results, errors };
}

async function removeWorktreeWithFallback(worktreePath: string): Promise<void> {
  try {
    await removeWorktree(worktreePath, true);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('does not exist')
    ) {
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

function formatCleanupOutput(
  results: string[],
  errors: string[],
): string {
  const output: string[] = ['Cleanup Results', '===============', ''];

  if (results.length > 0) {
    output.push('Successful:');
    output.push(...results);
    output.push('');
  }

  if (errors.length > 0) {
    output.push('Errors:');
    output.push(...errors);
    output.push('');
  }

  output.push(
    `Summary: ${results.length} cleaned, ${errors.length} failed`,
  );

  if (errors.length > 0) {
    throw new Error(output.join('\n'));
  }

  return output.join('\n');
}

export const mc_cleanup: ToolDefinition = tool({
  description: 'Remove completed/stopped jobs and their worktrees',
  args: {
    name: tool.schema
      .string()
      .optional()
      .describe('Specific job to cleanup (by name)'),
    all: tool.schema
      .boolean()
      .optional()
      .describe('Cleanup all non-running jobs'),
    deleteBranch: tool.schema
      .boolean()
      .optional()
      .describe('Also delete the git branch'),
  },
  async execute(args) {
    validateCleanupArgs(args);

    const jobsToClean = await determineJobsToClean(args);
    if (jobsToClean.length === 0) {
      return 'No non-running jobs to cleanup.';
    }

    const { results, errors } = await cleanupJobs(jobsToClean, args.deleteBranch);
    return formatCleanupOutput(results, errors);
  },
});
