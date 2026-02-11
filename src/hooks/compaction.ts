import { loadJobState } from '../lib/job-state';
import type { Job } from '../lib/job-state';
import { readAllReports } from '../lib/reports';
import type { AgentReport } from '../lib/reports';
import { getWorktreeContext } from './awareness';

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes}m`;
}

function truncatePrompt(prompt: string, maxLen: number = 60): string {
  if (prompt.length <= maxLen) return prompt;
  return prompt.slice(0, maxLen - 3) + '...';
}

function isStale(job: Job, report: AgentReport | undefined, now: number): boolean {
  const createdAt = new Date(job.createdAt).getTime();
  const runningMs = now - createdAt;

  // Running > 10 min with no report at all
  if (!report && runningMs > 10 * 60_000) return true;

  // Last report > 15 min old
  if (report) {
    const reportAge = now - new Date(report.timestamp).getTime();
    if (reportAge > 15 * 60_000) return true;
  }

  return false;
}

function buildJobCard(job: Job, report: AgentReport | undefined, now: number): string {
  const runningMs = now - new Date(job.createdAt).getTime();
  const duration = formatDuration(runningMs);
  const stale = isStale(job, report, now);

  let reportStr = 'report: none';
  if (report) {
    reportStr = `report: ${report.status} - ${report.message}`;
  }

  const staleMarker = stale ? ' [stale]' : '';
  const prompt = truncatePrompt(job.prompt);

  return `- ${job.name} [${job.status} ${duration}] ${job.branch} ${job.mode} | "${prompt}" | ${reportStr}${staleMarker}`;
}

export async function getCompactionContext(): Promise<string> {
  const state = await loadJobState();
  const allJobs = state.jobs;

  if (allJobs.length === 0) {
    return 'No Mission Control jobs running';
  }

  const runningJobs = allJobs.filter((j) => j.status === 'running');
  const completedCount = allJobs.filter((j) => j.status === 'completed').length;
  const failedCount = allJobs.filter((j) => j.status === 'failed').length;

  if (runningJobs.length === 0) {
    const parts: string[] = [];
    if (completedCount > 0) parts.push(`${completedCount} completed`);
    if (failedCount > 0) parts.push(`${failedCount} failed`);
    return `Mission Control (${parts.join(', ')}): No active jobs.`;
  }

  const reports = await readAllReports();
  const reportsByJobId = new Map<string, AgentReport>();
  for (const report of reports) {
    reportsByJobId.set(report.jobId, report);
  }

  const now = Date.now();

  const summaryParts: string[] = [`${runningJobs.length} running`];
  if (completedCount > 0) summaryParts.push(`${completedCount} completed`);
  if (failedCount > 0) summaryParts.push(`${failedCount} failed`);

  const header = `Mission Control (${summaryParts.join(', ')}):`;
  const cards = runningJobs.map((job) => buildJobCard(job, reportsByJobId.get(job.id), now));

  const lines = [header, ...cards, 'Commands: mc_overview, mc_capture(name), mc_diff(name), mc_merge(name)'];

  return lines.join('\n');
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
