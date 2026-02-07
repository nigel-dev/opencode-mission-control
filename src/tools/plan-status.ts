import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { loadPlan } from '../lib/plan-state';
import type { JobSpec, PlanSpec } from '../lib/plan-types';

function getJobStatusIndicator(status: string): string {
  switch (status) {
    case 'running':
      return '▶';
    case 'completed':
      return '✓';
    case 'merged':
      return '✓✓';
    case 'failed':
      return '✗';
    case 'conflict':
      return '⚡';
    case 'queued':
      return '○';
    case 'waiting_deps':
      return '◌';
    case 'ready_to_merge':
      return '⬆';
    case 'merging':
      return '⇄';
    case 'stopped':
      return '⊘';
    case 'canceled':
      return '⊘';
    default:
      return '•';
  }
}

function formatJobLine(job: JobSpec): string {
  const indicator = getJobStatusIndicator(job.status);
  const deps =
    job.dependsOn?.length ? ` (deps: ${job.dependsOn.join(', ')})` : '';
  const error = job.error ? ` - Error: ${job.error}` : '';
  const merged = job.mergedAt ? ` (merged: ${job.mergedAt})` : '';
  return `  ${indicator} ${job.name}: ${job.status}${deps}${error}${merged}`;
}

function getNextActions(plan: PlanSpec): string {
  const queued = plan.jobs.filter((j) => j.status === 'queued').length;
  const waiting = plan.jobs.filter((j) => j.status === 'waiting_deps').length;
  const running = plan.jobs.filter((j) => j.status === 'running').length;
  const readyToMerge = plan.jobs.filter(
    (j) => j.status === 'ready_to_merge',
  ).length;
  const merging = plan.jobs.filter((j) => j.status === 'merging').length;

  const actions: string[] = [];
  if (running > 0) actions.push(`${running} job(s) running`);
  if (readyToMerge > 0) actions.push(`${readyToMerge} job(s) ready to merge`);
  if (merging > 0) actions.push(`${merging} job(s) merging`);
  if (queued > 0) actions.push(`${queued} job(s) queued`);
  if (waiting > 0) actions.push(`${waiting} job(s) waiting on deps`);

  return actions.length > 0 ? actions.join(', ') : 'None';
}

export const mc_plan_status: ToolDefinition = tool({
  description: 'Show status of the active orchestrated plan',
  args: {},
  async execute() {
    const plan = await loadPlan();
    if (!plan) {
      return 'No active plan.';
    }

    const merged = plan.jobs.filter((j) => j.status === 'merged').length;
    const total = plan.jobs.length;
    const progress = `${merged}/${total} merged`;

    const jobLines = plan.jobs.map(formatJobLine).join('\n');

    const lines: string[] = [
      `Plan: ${plan.name} (${plan.status})`,
      `Mode: ${plan.mode}`,
      `Progress: ${progress}`,
      '',
      'Jobs:',
      jobLines,
      '',
      `Next: ${getNextActions(plan)}`,
    ];

    if (plan.prUrl) {
      lines.push(`PR: ${plan.prUrl}`);
    }

    return lines.join('\n');
  },
});
