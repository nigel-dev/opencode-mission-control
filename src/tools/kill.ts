import { z } from 'zod';
import { getJobByName, updateJob } from '../lib/job-state';
import { stopJobSession } from '../lib/job-runtime';

export const mc_kill = {
  name: 'mc_kill',
  description: 'Stop a running job',
  input: z.object({
    name: z.string().describe('Job name'),
    force: z.boolean().optional().describe('Accepted for compatibility; stopping a job always interrupts its session'),
  }).strict(),
  async execute(args: { name: string; force?: boolean }) {
    // 1. Find job by name
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    // 2. Only a running job can be stopped. A finished job keeps its status:
    //    rewriting "completed" or "failed" to "stopped" would lose the outcome.
    if (job.status === 'stopped') {
      return { content: `Job "${args.name}" is already stopped.` };
    }
    if (job.status !== 'running') {
      return { content: `Job "${args.name}" is not running (status: ${job.status}); nothing to stop.` };
    }

    // 3. Mark the job stopped first. Interrupting the session makes it emit
    //    an "interrupted" event, which the monitor would otherwise record as
    //    a failure of a job that is still marked running.
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

    // 4. Interrupt the job's session. A job that never got a session (or whose
    //    session is already gone) has nothing left to stop.
    let warning: string | undefined;
    if (job.sessionID) {
      try {
        await stopJobSession(job.sessionID);
      } catch (error) {
        warning = `Warning: could not interrupt session ${job.sessionID}: ${error instanceof Error ? error.message : String(error)}`;
        console.warn(`[Mission Control] ${warning}`);
      }
    }

    // 5. Return success message
    return { content: [
      `Job "${args.name}" stopped successfully.`,
      '',
      `  ID:        ${job.id}`,
      `  Status:    stopped`,
      ...(job.sessionID ? [`  Session:   ${job.sessionID}`] : []),
      `  Worktree:  ${job.worktreePath}`,
      ...(warning ? ['', warning] : []),
      '',
      'Note: Worktree is preserved. Use mc_cleanup to remove it.',
    ].join('\n') };
  },
};
