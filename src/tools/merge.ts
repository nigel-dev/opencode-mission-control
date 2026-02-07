import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName } from '../lib/job-state';
import { gitCommand } from '../lib/git';
import { loadPlan } from '../lib/plan-state';

async function getBaseBranch(cwd: string): Promise<string> {
  const mainCheck = await gitCommand(['rev-parse', '--verify', 'main'], { cwd });
  if (mainCheck.exitCode === 0) {
    return 'main';
  }

  const masterCheck = await gitCommand(['rev-parse', '--verify', 'master'], { cwd });
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

    const checkoutResult = await gitCommand(['checkout', baseBranch], {
      cwd: job.worktreePath,
    });

    if (checkoutResult.exitCode !== 0) {
      throw new Error(
        `Failed to checkout ${baseBranch}: ${checkoutResult.stderr || checkoutResult.stdout}`,
      );
    }

    const mergeResult = await gitCommand(mergeArgs, {
      cwd: job.worktreePath,
    });

    if (mergeResult.exitCode !== 0) {
      await gitCommand(['merge', '--abort'], {
        cwd: job.worktreePath,
      }).catch(() => {});
      throw new Error(
        `Merge failed: ${mergeResult.stderr || mergeResult.stdout}`,
      );
    }

    // 7. Check if job belongs to active plan
    let planWarning = '';
    if (job.planId) {
      const activePlan = await loadPlan();
      if (activePlan && activePlan.id === job.planId) {
        planWarning =
          '⚠️  This job is part of an active plan. Use mc_plan_status to check progress.\n\n';
      }
    }

    // 8. Return success message
    const lines: string[] = [
      `${planWarning}Successfully merged '${job.branch}' into '${baseBranch}'`,
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
