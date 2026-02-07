import { getRunningJobs } from '../lib/job-state';

/**
 * Get a summary of running jobs for OpenCode compaction context
 * Returns a compact string describing the current job state
 *
 * @returns Promise<string> - Summary of running jobs for compaction context
 */
export async function getCompactionContext(): Promise<string> {
  const jobs = await getRunningJobs();

  if (jobs.length === 0) {
    return 'No Mission Control jobs running';
  }

  const jobList = jobs.map((j) => `${j.name} (${j.status})`).join(', ');
  return `Mission Control: ${jobs.length} job(s) running - ${jobList}`;
}
