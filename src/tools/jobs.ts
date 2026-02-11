import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { loadJobState, type Job } from '../lib/job-state';
import { formatTimeAgo } from '../lib/utils';



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

function formatJobsOutput(grouped: Record<string, Job[]>): string {
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
        `  Branch: ${job.branch} | Mode: ${job.mode} | ${durationLabel}`,
      );
    });

    lines.push('');
  }

  if (!hasJobs) {
    lines.push('No jobs found.');
  }

  return lines.join('\n');
}

export const mc_jobs: ToolDefinition = tool({
  description: 'List all Mission Control jobs with status',
  args: {
    status: tool.schema
      .enum(['all', 'running', 'completed', 'failed'])
      .optional()
      .describe('Filter by status (default: all)'),
  },
  async execute(args) {
    const state = await loadJobState();
    const grouped = groupJobsByStatus(state.jobs, args.status);
    return formatJobsOutput(grouped);
  },
});
