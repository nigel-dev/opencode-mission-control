import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName } from '../lib/job-state';
import { syncWorktree } from '../lib/worktree';

export const mc_sync: ToolDefinition = tool({
  description: 'Sync a job\'s branch with the base branch',
  args: {
    name: tool.schema.string().describe('Job name'),
    strategy: tool.schema
      .enum(['rebase', 'merge'])
      .optional()
      .describe('Sync strategy (default: rebase)'),
  },
  async execute(args) {
    // 1. Find job by name
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    // 2. Determine strategy (default: rebase)
    const syncStrategy = args.strategy || 'rebase';

    // 3. Sync the worktree
    const result = await syncWorktree(job.worktreePath, syncStrategy);

    // 4. Format output
    if (result.success) {
      return `Successfully synced job "${job.name}" using ${syncStrategy} strategy.`;
    }

    // Sync failed with conflicts
    const conflictList = result.conflicts
      ? result.conflicts.map((f) => `  - ${f}`).join('\n')
      : '  (no conflict details available)';

    return `Sync failed for job "${job.name}" using ${syncStrategy} strategy.\n\nConflicts:\n${conflictList}\n\nResolve conflicts manually and try again.`;
  },
});
