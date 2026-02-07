import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName } from '../lib/job-state';
import { gitCommand } from '../lib/git';
import { loadPlan } from '../lib/plan-state';
import { getMainWorktree } from '../lib/worktree';

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

    // 2. Get the main worktree path (where the base branch is checked out)
    const mainWorktreePath = await getMainWorktree();

    // 3. Get the base branch
    const baseBranch = await getBaseBranch(mainWorktreePath);

    // 4. Determine merge message
    const mergeMessage = args.message || `Merge branch '${job.branch}' into ${baseBranch}`;

    // 5. Build merge command — run from the main worktree where baseBranch is already checked out
    const mergeArgs: string[] = ['merge', job.branch];

    if (args.squash) {
      mergeArgs.push('--squash');
    }

    mergeArgs.push('-m', mergeMessage);

    // Verify main worktree is on the base branch
    const currentBranch = await gitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: mainWorktreePath,
    });

    if (currentBranch.exitCode !== 0 || currentBranch.stdout !== baseBranch) {
      throw new Error(
        `Main worktree is not on ${baseBranch} (currently on '${currentBranch.stdout}'). ` +
        `Please ensure the main worktree is on ${baseBranch} before merging.`,
      );
    }

    // 6. Run merge from the main worktree
    const mergeResult = await gitCommand(mergeArgs, {
      cwd: mainWorktreePath,
    });

    if (mergeResult.exitCode !== 0) {
      await gitCommand(['merge', '--abort'], {
        cwd: mainWorktreePath,
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
