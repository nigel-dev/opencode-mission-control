import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { loadJobState, getRunningJobs, type Job } from '../lib/job-state';
import { loadPlan } from '../lib/plan-state';
import { readAllReports, type AgentReport } from '../lib/reports';
import { formatTimeAgo } from '../lib/utils';
import { getSharedMonitor } from '../lib/orchestrator-singleton';



function truncate(text: string, maxLength: number = 80): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function getLatestReportsByJob(reports: AgentReport[]): Map<string, AgentReport> {
  const sorted = [...reports].sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  const byKey = new Map<string, AgentReport>();

  for (const report of sorted) {
    const idKey = `id:${report.jobId}`;
    const nameKey = `name:${report.jobName}`;

    if (!byKey.has(idKey)) {
      byKey.set(idKey, report);
    }
    if (!byKey.has(nameKey)) {
      byKey.set(nameKey, report);
    }
  }

  return byKey;
}

function getReportForJob(
  job: Job,
  reportsByJob: Map<string, AgentReport>,
): AgentReport | undefined {
  return reportsByJob.get(`id:${job.id}`) ?? reportsByJob.get(`name:${job.name}`);
}

function getJobActivityState(job: Job): { state: string; lastActivity: string } {
  const isServeMode = job.port !== undefined && job.port > 0;
  if (!isServeMode) {
    return { state: 'tmux', lastActivity: formatTimeAgo(job.createdAt) };
  }

  const monitor = getSharedMonitor();
  const accumulator = monitor.getEventAccumulator(job.id);
  if (!accumulator) {
    return { state: 'idle', lastActivity: formatTimeAgo(job.createdAt) };
  }

  const lastActivityTime = new Date(accumulator.lastActivityAt).toISOString();
  const lastActivity = formatTimeAgo(lastActivityTime);

  let state = 'idle';
  if (accumulator.currentTool) {
    state = accumulator.currentTool;
  }

  return { state, lastActivity };
}

function formatRecentCompletions(jobs: Job[]): string[] {
  const completed = jobs
    .filter((job) => job.status === 'completed' && job.completedAt)
    .sort(
      (a, b) =>
        new Date(b.completedAt as string).getTime() -
        new Date(a.completedAt as string).getTime(),
    )
    .slice(0, 5);

  if (completed.length === 0) {
    return ['- None'];
  }

  return completed.map((job) => {
    const duration = formatTimeAgo(job.createdAt, job.completedAt);
    return `- ${job.name} | ${duration} | ${job.branch}`;
  });
}

function formatAlerts(reports: AgentReport[]): string[] {
  const alerts = reports
    .filter((report) => report.status === 'blocked' || report.status === 'needs_review')
    .sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

  if (alerts.length === 0) {
    return ['- None'];
  }

  return alerts.slice(0, 5).map((report) => {
    return `- ${report.jobName} [${report.status}]: ${truncate(report.message, 100)}`;
  });
}

function formatRecentFailures(jobs: Job[]): string[] {
  const failed = jobs
    .filter((job) => job.status === 'failed')
    .sort((a, b) => {
      const aDate = new Date(a.completedAt ?? a.createdAt).getTime();
      const bDate = new Date(b.completedAt ?? b.createdAt).getTime();
      return bDate - aDate;
    })
    .slice(0, 5);

  if (failed.length === 0) {
    return ['- None'];
  }

  return failed.map((job) => {
    const endedAt = job.completedAt ?? job.createdAt;
    return `- ${job.name} | failed ${formatTimeAgo(endedAt)} | ${job.branch}`;
  });
}

function getSuggestedActions(
  jobs: Job[],
  planLoaded: Awaited<ReturnType<typeof loadPlan>>,
  reports: AgentReport[],
): string[] {
  const runningJobs = jobs.filter((job) => job.status === 'running');
  const completedJobs = jobs.filter((job) => job.status === 'completed');
  const failedJobs = jobs.filter((job) => job.status === 'failed');
  const blockedReports = reports.filter((report) => report.status === 'blocked');
  const reviewReports = reports.filter(
    (report) => report.status === 'needs_review',
  );

  const actions: string[] = [];

  if (blockedReports.length > 0) {
    const names = blockedReports
      .slice(0, 2)
      .map((report) => report.jobName)
      .join(', ');
    actions.push(
      `${blockedReports.length} job(s) blocked - run mc_attach for ${names}`,
    );
  }

  if (reviewReports.length > 0) {
    actions.push(
      `${reviewReports.length} job(s) need review - run mc_diff on completed work`,
    );
  }

  if (completedJobs.length > 0) {
    actions.push(
      `${completedJobs.length} job(s) completed - run mc_diff or mc_pr to integrate`,
    );
  }

  if (failedJobs.length > 0) {
    actions.push(
      `${failedJobs.length} job(s) failed - run mc_status or mc_capture to diagnose`,
    );
  }

  if (planLoaded?.status === 'pending' && planLoaded.mode === 'copilot') {
    actions.push('Plan is pending approval - run mc_plan_approve');
  }

  if (planLoaded?.checkpoint) {
    actions.push(
      `Plan paused at ${planLoaded.checkpoint} - run mc_plan_approve`,
    );
  }

  if (runningJobs.length > 0) {
    actions.push(
      `${runningJobs.length} job(s) running - run mc_capture to check live progress`,
    );
  }

  if (actions.length === 0) {
    actions.push('No active work - run mc_launch to start a new job');
  }

  return actions.slice(0, 5).map((action) => `- ${action}`);
}

export const mc_overview: ToolDefinition = tool({
  description:
    'START HERE — Get a complete overview of all Mission Control activity, jobs, plans, and alerts',
  args: {},
  async execute() {
    const [jobState, runningJobs, plan, reports] = await Promise.all([
      loadJobState(),
      getRunningJobs(),
      loadPlan(),
      readAllReports(),
    ]);

    const jobs = jobState.jobs;
    const reportsByJob = getLatestReportsByJob(reports);
    const completedCount = jobs.filter((job) => job.status === 'completed').length;
    const failedCount = jobs.filter((job) => job.status === 'failed').length;
    const stoppedCount = jobs.filter((job) => job.status === 'stopped').length;

    const lines: string[] = [
      'Mission Control Dashboard',
      `Timestamp: ${new Date().toISOString()}`,
      '',
      'Active Plan',
      '-----------',
    ];

    if (plan) {
      const mergedCount = plan.jobs.filter((job) => job.status === 'merged').length;
      lines.push(`- Name: ${plan.name}`);
      lines.push(`- Status: ${plan.status}`);
      lines.push(`- Progress: ${mergedCount}/${plan.jobs.length} merged`);
      lines.push(`- Mode: ${plan.mode}`);
    } else {
      lines.push('- None');
    }

    lines.push('', 'Jobs Summary', '------------');
    lines.push(
      `- ${runningJobs.length} running, ${completedCount} completed, ${failedCount} failed${stoppedCount > 0 ? `, ${stoppedCount} stopped` : ''}`,
    );

    lines.push('', 'Running Jobs', '------------');
    if (runningJobs.length === 0) {
      lines.push('- None');
    } else {
      const runningLines = runningJobs
        .sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        )
        .map((job) => {
          const lastReport = getReportForJob(job, reportsByJob);
          const activity = getJobActivityState(job);
          const isServeMode = job.port !== undefined && job.port > 0;

          if (isServeMode) {
            return `- ${job.name} | ${activity.state} | ${activity.lastActivity} | ${job.branch}`;
          }

          const reportText = lastReport
            ? `${lastReport.status}: ${truncate(lastReport.message, 60)}`
            : 'none';
          return `- ${job.name} | ${activity.lastActivity} | ${job.branch} | last report: ${reportText}`;
        });
      lines.push(...runningLines);
    }

    lines.push('', 'Recent Completions', '------------------');
    lines.push(...formatRecentCompletions(jobs));

    lines.push('', 'Recent Failures', '---------------');
    lines.push(...formatRecentFailures(jobs));

    lines.push('', 'Alerts', '------');
    lines.push(...formatAlerts(reports));

    lines.push('', 'Suggested Actions', '-----------------');
    lines.push(...getSuggestedActions(jobs, plan, reports));

    return lines.join('\n');
  },
});
