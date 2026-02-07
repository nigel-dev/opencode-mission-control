import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { spawn } from 'bun';
import { getJobByName } from '../lib/job-state';

/**
 * Execute a git command in a specific directory
 */
async function executeGitCommand(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

/**
 * Get the base branch (main or master)
 */
async function getBaseBranch(cwd: string): Promise<string> {
  // Try main first
  const mainCheck = await executeGitCommand(cwd, ['rev-parse', '--verify', 'main']);
  if (mainCheck.exitCode === 0) {
    return 'main';
  }

  // Fall back to master
  const masterCheck = await executeGitCommand(cwd, ['rev-parse', '--verify', 'master']);
  if (masterCheck.exitCode === 0) {
    return 'master';
  }

  throw new Error('Could not find main or master branch');
}

export const mc_merge: ToolDefinition = tool({
  description: 'Merge a job\'s branch back to main (for non-PR workflows)',
  args: {
    name: tool.schema.string().describe('Job name'),
    squash: tool.schema.boolean().optional().describe('Squash commits'),
    message: tool.schema.string().optional().describe('Merge commit message'),
  },
  async execute(args) {
    // 1. Get job by name
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    // 2. Get the base branch (main or master)
    const baseBranch = await getBaseBranch(job.worktreePath);

    // 3. Determine merge message
    const mergeMessage = args.message || `Merge branch '${job.branch}' into ${baseBranch}`;

    // 4. Build merge command
    const mergeArgs: string[] = ['merge', job.branch];

    if (args.squash) {
      mergeArgs.push('--squash');
    }

    mergeArgs.push('-m', mergeMessage);

    // 5. Checkout base branch
    const checkoutResult = await executeGitCommand(job.worktreePath, [
      'checkout',
      baseBranch,
    ]);

    if (checkoutResult.exitCode !== 0) {
      throw new Error(
        `Failed to checkout ${baseBranch}: ${checkoutResult.stderr || checkoutResult.stdout}`,
      );
    }

    // 6. Execute merge
    const mergeResult = await executeGitCommand(job.worktreePath, mergeArgs);

    if (mergeResult.exitCode !== 0) {
      throw new Error(
        `Merge failed: ${mergeResult.stderr || mergeResult.stdout}`,
      );
    }

    // 7. Return success message
    const lines: string[] = [
      `Successfully merged '${job.branch}' into '${baseBranch}'`,
      '',
      'Merge details:',
      `  Branch: ${job.branch}`,
      `  Base: ${baseBranch}`,
      `  Squash: ${args.squash ? 'yes' : 'no'}`,
      `  Message: ${mergeMessage}`,
      '',
      'Note: Branch was not deleted. Use mc_cleanup to remove the worktree if needed.',
    ];

    return lines.join('\n');
  },
});
