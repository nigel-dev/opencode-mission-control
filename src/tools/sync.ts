import { z } from 'zod';
import { getJobByName } from '../lib/job-state';
import { syncWorktree } from '../lib/worktree';

export const mc_sync = {
  name: 'mc_sync',
  description: 'Sync a job\'s branch with the base branch',
  input: z.object({
    name: z.string().describe('Job name'),
    strategy: z.enum(['rebase', 'merge']).optional().describe('Sync strategy (default: rebase)'),
    source: z.enum(['local', 'origin']).optional().describe('Sync source: local base branch (default) or origin'),
  }).strict(),
  async execute(args: { name: string; strategy?: 'rebase' | 'merge'; source?: 'local' | 'origin' }) {
    // 1. Find job by name
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    // 2. Determine strategy (default: rebase)
    const syncStrategy = args.strategy || 'rebase';

    // 3. Sync the worktree
    const result = await syncWorktree(
      job.worktreePath,
      syncStrategy,
      job.baseBranch,
      args.source,
    );

    // 4. Format output
    if (result.success) {
      return { content: `Successfully synced job "${job.name}" using ${syncStrategy} strategy.` };
    }

    // Sync failed with conflicts
    const conflictList = result.conflicts
      ? result.conflicts.map((f) => `  - ${f}`).join('\n')
      : '  (no conflict details available)';

    return { content: `Sync failed for job "${job.name}" using ${syncStrategy} strategy.\n\nConflicts:\n${conflictList}\n\nResolve conflicts manually and try again.` };
  },
};
