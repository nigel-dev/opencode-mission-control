import { getProjectDirectory } from '../lib/project-context';
import { isInManagedWorktree } from '../lib/worktree';
import { loadJobState } from '../lib/job-state';

export interface WorktreeContext {
  isInJob: boolean;
  jobName?: string;
  jobPrompt?: string;
}

export async function getWorktreeContext(cwd: string = getProjectDirectory()): Promise<WorktreeContext> {
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
  };
}
