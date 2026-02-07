import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName, updateJob } from '../lib/job-state';
import { killSession, killWindow } from '../lib/tmux';

export const mc_kill: ToolDefinition = tool({
  description: 'Stop a running job',
  args: {
    name: tool.schema.string().describe('Job name'),
    force: tool.schema
      .boolean()
      .optional()
      .describe('Force kill (SIGKILL)'),
  },
  async execute(args) {
    // 1. Find job by name
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    // 2. Check if job is already stopped
    if (job.status === 'stopped') {
      return `Job "${args.name}" is already stopped.`;
    }

    // 3. Kill tmux session or window
    try {
      if (job.placement === 'session') {
        // Extract session name from tmuxTarget (e.g., "mc-job-name")
        await killSession(job.tmuxTarget);
      } else {
        // Extract session and window from tmuxTarget (e.g., "session:window")
        const [session, window] = job.tmuxTarget.split(':');
        if (!session || !window) {
          throw new Error(
            `Invalid tmux target format: ${job.tmuxTarget}. Expected "session:window"`,
          );
        }
        await killWindow(session, window);
      }
    } catch (error) {
      throw new Error(
        `Failed to kill tmux ${job.placement}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 4. Update job status to 'stopped'
    try {
      await updateJob(job.id, {
        status: 'stopped',
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      throw new Error(
        `Failed to update job status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 5. Return success message
    return [
      `Job "${args.name}" stopped successfully.`,
      '',
      `  ID:        ${job.id}`,
      `  Status:    stopped`,
      `  Placement: ${job.placement}`,
      `  Worktree:  ${job.worktreePath}`,
      '',
      'Note: Worktree is preserved. Use mc_cleanup to remove it.',
    ].join('\n');
  },
});
