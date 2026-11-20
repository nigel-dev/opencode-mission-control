import { z } from 'zod';
import { loadJobState, type Job } from '../lib/job-state';
import { formatTimeAgo } from '../lib/utils';
import { getJobUsage, type JobUsage } from '../lib/job-runtime';



function truncatePrompt(prompt: string, maxLength: number = 50): string {
  if (prompt.length <= maxLength) return prompt;
  return prompt.substring(0, maxLength - 3) + '...';
}

function getStatusIndicator(status: string): string {
  switch (status) {
    case 'running':
      return '▶';
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'stopped':
      return '⊘';
    default:
      return '•';
  }
}

function groupJobsByStatus(
  jobs: Job[],
  filterStatus?: string,
): Record<string, Job[]> {
  const filtered =
    filterStatus && filterStatus !== 'all'
      ? jobs.filter((j) => j.status === filterStatus)
      : jobs;

  const grouped: Record<string, Job[]> = {
    running: [],
    completed: [],
    failed: [],
    stopped: [],
  };

  filtered.forEach((job) => {
    if (job.status in grouped) {
      grouped[job.status].push(job);
    }
  });

  return grouped;
}

function formatUsage(usage: JobUsage): string {
  return `Cost: $${usage.cost.toFixed(4)} | Tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`;
}

async function loadUsage(jobs: Job[]): Promise<Map<string, JobUsage>> {
  const usageByJob = new Map<string, JobUsage>();
  await Promise.all(
    jobs.map(async (job) => {
      if (job.status !== 'running' || !job.sessionID) return;
      try {
        usageByJob.set(job.id, await getJobUsage(job.sessionID));
      } catch {
        // Usage is informational: omit it when the session cannot be read.
      }
    }),
  );
  return usageByJob;
}

function formatJobsOutput(
  grouped: Record<string, Job[]>,
  usageByJob: Map<string, JobUsage>,
): string {
  const lines: string[] = ['Mission Control Jobs', '====================', ''];

  let hasJobs = false;

  for (const [status, jobs] of Object.entries(grouped)) {
    if (jobs.length === 0) continue;

    hasJobs = true;
    const statusLabel =
      status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
    lines.push(`${statusLabel} (${jobs.length}):`);

    jobs.forEach((job) => {
      const indicator = getStatusIndicator(job.status);
      const truncatedPrompt = truncatePrompt(job.prompt);
       const durationLabel =
         job.status === 'completed' && job.completedAt
           ? `Completed: ${formatTimeAgo(job.completedAt)}`
           : `Started: ${formatTimeAgo(job.createdAt)}`;

      lines.push(
        `• ${job.name} [${job.status}] ${indicator} - "${truncatedPrompt}"`,
      );
      lines.push(
        `  Branch: ${job.branch} | ${durationLabel}`,
      );

      const sessionParts = [
        ...(job.sessionID ? [`Session: ${job.sessionID}`] : []),
        ...(job.agent ? [`Agent: ${job.agent}`] : []),
        ...(job.model ? [`Model: ${job.model}`] : []),
      ];
      if (sessionParts.length > 0) {
        lines.push(`  ${sessionParts.join(' | ')}`);
      }

      const usage = usageByJob.get(job.id);
      if (usage) {
        lines.push(`  ${formatUsage(usage)}`);
      }
    });

    lines.push('');
  }

  if (!hasJobs) {
    lines.push('No jobs found.');
  }

  return lines.join('\n');
}

export const mc_jobs = {
  name: 'mc_jobs',
  description: 'List all Mission Control jobs with status',
  input: z.object({
    status: z.enum(['all', 'running', 'completed', 'failed']).optional().describe('Filter by status (default: all)'),
  }).strict(),
  async execute(args: { status?: 'all' | 'running' | 'completed' | 'failed' }) {
    const state = await loadJobState();
    const grouped = groupJobsByStatus(state.jobs, args.status);
    const usageByJob = await loadUsage(grouped.running);
    return { content: formatJobsOutput(grouped, usageByJob) };
  },
};
