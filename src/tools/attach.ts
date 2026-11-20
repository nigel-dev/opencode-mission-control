import { z } from 'zod';
import { getJobByName, type Job } from '../lib/job-state';
import { jobSessionTitle } from '../lib/job-runtime';
import { emitOpen } from '../lib/rpc-events';

export interface AttachInfo {
  sessionID: string;
  worktreePath: string;
  title: string;
}

/**
 * What a client needs to open a job's session. Returns undefined for a job
 * that has no session (launched by a pre-2.0 release).
 */
export function getAttachInfo(job: Job): AttachInfo | undefined {
  if (!job.sessionID) {
    return undefined;
  }
  return {
    sessionID: job.sessionID,
    worktreePath: job.worktreePath,
    title: jobSessionTitle(job.name),
  };
}

export const mc_attach = {
  name: 'mc_attach',
  description: 'Get instructions for opening a job\'s session',
  input: z.object({
    name: z.string().describe('Job name'),
  }).strict(),
  async execute(args: { name: string }) {
    const job = await getJobByName(args.name);

    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    const info = getAttachInfo(job);
    if (!info) {
      return { content: [
        `Job "${args.name}" has no session to open (it was launched by an older version of Mission Control).`,
        '',
        `  Worktree: ${job.worktreePath}`,
      ].join('\n') };
    }

    // Ask a connected TUI to focus the job's tab. Best-effort: with no TUI
    // listening nothing happens, so the instructions below stay the fallback.
    await emitOpen({ sessionID: info.sessionID, title: info.title });

    return { content: [
      `To open job "${args.name}":`,
      '',
      `  Session:  ${info.sessionID}`,
      `  Worktree: ${info.worktreePath}`,
      '',
      'A tab for this session was requested in the TUI. If it did not open:',
      '',
      '# In the TUI: open the session list (Ctrl+X then L, or /sessions) and pick:',
      `${info.title}`,
      '',
      '# From a shell:',
      `cd ${info.worktreePath} && opencode --session ${info.sessionID}`,
    ].join('\n') };
  },
};
