import { getRunningJobs } from '../lib/job-state';
import { getWorktreeContext } from './awareness';

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

export async function getJobCompactionContext(): Promise<string> {
  const context = await getWorktreeContext();

  if (context.isInJob && context.jobName) {
    const mode = context.mode || 'unknown';
    const jobPrompt = context.jobPrompt || 'Complete your assigned work';
    return `Mission Control Job Agent: You are working on job '${context.jobName}' (${mode} mode). Your task: ${jobPrompt}. Focus on YOUR task only. Use mc_report to report status. Do NOT manage other jobs.`;
  }

  return 'Mission Control Job Agent: Focus on your assigned task. Use mc_report to report status.';
}
