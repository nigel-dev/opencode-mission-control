import { isInManagedWorktree } from '../lib/worktree';
import { loadJobState } from '../lib/job-state';

export interface WorktreeContext {
  isInJob: boolean;
  jobName?: string;
  jobPrompt?: string;
  mode?: string;
}

export async function getWorktreeContext(): Promise<WorktreeContext> {
  const cwd = process.cwd();
  const { isManaged, worktreePath } = await isInManagedWorktree(cwd);

  if (!isManaged) {
    return { isInJob: false };
  }

  // Find job by worktreePath
  const state = await loadJobState();
  const job = state.jobs.find((j) => j.worktreePath === worktreePath);

  return {
    isInJob: true,
    jobName: job?.name,
    jobPrompt: job?.prompt,
    mode: job?.mode,
  };
}
