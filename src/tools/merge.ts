import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName } from '../lib/job-state';
import { gitCommand } from '../lib/git';
import { loadPlan } from '../lib/plan-state';
import { getMainWorktree } from '../lib/worktree';
import { loadConfig } from '../lib/config';

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

async function assertCleanWorktree(cwd: string): Promise<void> {
  const status = await gitCommand(['status', '--porcelain'], { cwd });
  if (status.exitCode !== 0) {
    throw new Error(
      `Failed to check main worktree status: ${status.stderr || status.stdout}`,
    );
  }

  if (status.stdout.trim() !== '') {
    throw new Error(
      'Main worktree has uncommitted changes. Refusing merge because automatic rollback may discard local changes. Commit, stash, or clean the worktree and retry.',
    );
  }
}

export const mc_merge: ToolDefinition = tool({
  description: 'Merge a job\'s branch back to main (for non-PR workflows)',
  args: {
    name: tool.schema.string().describe('Job name'),
    squash: tool.schema.boolean().optional().describe('Squash commits (deprecated: use strategy instead)'),
    strategy: tool.schema.enum(['squash', 'ff-only', 'merge']).optional().describe('Merge strategy (default: from config, usually squash)'),
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
    const baseBranch = job.baseBranch ?? await getBaseBranch(mainWorktreePath);

    // 4. Load config and resolve merge strategy
    const config = await loadConfig();
    const mergeStrategy: 'squash' | 'ff-only' | 'merge' = 
      args.strategy ?? (args.squash ? 'squash' : config.mergeStrategy ?? 'squash');

    // 5. Determine merge message
    const mergeMessage = args.message || `Merge branch '${job.branch}' into ${baseBranch}`;

    // 6. Verify main worktree is on the base branch
    const currentBranch = await gitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: mainWorktreePath,
    });

    if (currentBranch.exitCode !== 0 || currentBranch.stdout !== baseBranch) {
      throw new Error(
        `Main worktree is not on ${baseBranch} (currently on '${currentBranch.stdout}'). ` +
        `Please ensure the main worktree is on ${baseBranch} before merging.`,
      );
    }

    await assertCleanWorktree(mainWorktreePath);

    if (mergeStrategy === 'squash') {
      // Squash: merge --squash then commit
      const squashResult = await gitCommand(['merge', '--squash', job.branch], {
        cwd: mainWorktreePath,
      });

      if (squashResult.exitCode !== 0) {
        await gitCommand(['reset', '--hard', 'HEAD'], {
          cwd: mainWorktreePath,
        }).catch(() => {});
        await gitCommand(['clean', '-fd'], {
          cwd: mainWorktreePath,
        }).catch(() => {});
        throw new Error(
          `Squash merge failed: ${squashResult.stderr || squashResult.stdout}`,
        );
      }

      // Now commit the squashed changes
      const commitResult = await gitCommand(['commit', '-m', mergeMessage], {
        cwd: mainWorktreePath,
      });

      if (commitResult.exitCode !== 0) {
        await gitCommand(['reset', '--hard', 'HEAD'], {
          cwd: mainWorktreePath,
        }).catch(() => {});
        await gitCommand(['clean', '-fd'], {
          cwd: mainWorktreePath,
        }).catch(() => {});
        throw new Error(
          `Commit after squash failed: ${commitResult.stderr || commitResult.stdout}`,
        );
      }
    } else if (mergeStrategy === 'ff-only') {
      // FF-only: rebase job branch onto base, then ff-only merge
      if (!job.worktreePath) {
        throw new Error(`Job "${args.name}" has no worktree path`);
      }

      // Rebase the job's branch onto the base branch
      const rebaseResult = await gitCommand(
        ['-C', job.worktreePath, 'rebase', baseBranch],
      );

      if (rebaseResult.exitCode !== 0) {
        // Abort the rebase in the job's worktree
        await gitCommand(['-C', job.worktreePath, 'rebase', '--abort']).catch(() => {});
        throw new Error(
          `Rebase of job branch onto ${baseBranch} failed. ` +
          `Conflicts detected. Try running mc_sync --strategy rebase first to resolve conflicts. ` +
          `Details: ${rebaseResult.stderr || rebaseResult.stdout}`,
        );
      }

      // Now do ff-only merge from main worktree
      const ffMergeResult = await gitCommand(['merge', '--ff-only', job.branch], {
        cwd: mainWorktreePath,
      });

      if (ffMergeResult.exitCode !== 0) {
        throw new Error(
          `Fast-forward merge failed: ${ffMergeResult.stderr || ffMergeResult.stdout}. ` +
          `The branch is not a fast-forward of ${baseBranch}.`,
        );
      }
    } else {
      // Merge: standard merge with --no-ff to create merge commit
      const mergeResult = await gitCommand(
        ['merge', '--no-ff', '-m', mergeMessage, job.branch],
        {
          cwd: mainWorktreePath,
        },
      );

      if (mergeResult.exitCode !== 0) {
        await gitCommand(['merge', '--abort'], {
          cwd: mainWorktreePath,
        }).catch(() => {});
        throw new Error(
          `Merge failed: ${mergeResult.stderr || mergeResult.stdout}`,
        );
      }
    }

    let planWarning = '';
    if (job.planId) {
      const activePlan = await loadPlan();
      if (activePlan && activePlan.id === job.planId) {
        planWarning =
          '⚠️  This job is part of an active plan. Use mc_plan_status to check progress.\n\n';
      }
    }

    const lines: string[] = [
      `${planWarning}Successfully merged '${job.branch}' into '${baseBranch}'`,
      '',
      'Merge details:',
      `  Branch: ${job.branch}`,
      `  Base: ${baseBranch}`,
      `  Strategy: ${mergeStrategy}`,
      `  Message: ${mergeMessage}`,
      '',
      'Note: Branch was not deleted. Use mc_cleanup to remove the worktree if needed.',
    ];

    return lines.join('\n');
  },
});
