import type { PluginInput } from '@opencode-ai/plugin';
import type { Job } from '../lib/job-state';
import { readReport } from '../lib/reports';

type Client = PluginInput['client'];
type NotificationEvent = 'complete' | 'failed' | 'blocked' | 'needs_review' | 'awaiting_input';

interface JobMonitorLike {
  on(event: NotificationEvent, handler: (job: Job) => void): void;
}

interface SetupNotificationsOptions {
  client: Client;
  monitor: JobMonitorLike;
  getActiveSessionID: () => Promise<string | undefined>;
  isSubagent: () => Promise<boolean>;
}

function formatDuration(createdAt: string): string {
  const start = Date.parse(createdAt);
  if (Number.isNaN(start)) {
    return 'unknown duration';
  }

  const totalSeconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

async function sendMessage(client: Client, sessionID: string, text: string): Promise<void> {
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      noReply: true,
      parts: [{ type: 'text' as const, text, ignored: true }],
    },
  });
}

function getDedupKey(event: NotificationEvent, job: Job, reportTimestamp?: string): string {
  if (event === 'complete' || event === 'failed') {
    return `${event}:${job.id}:${job.completedAt ?? ''}`;
  }
  if (event === 'awaiting_input') {
    return `${event}:${job.id}`;
  }
  return `${event}:${job.id}:${reportTimestamp ?? ''}`;
}

export function setupNotifications(options: SetupNotificationsOptions): void {
  const { client, monitor, getActiveSessionID, isSubagent } = options;
  const sent = new Set<string>();
  let pending: Promise<void> = Promise.resolve();

  const notify = async (event: NotificationEvent, job: Job): Promise<void> => {
    const report = event === 'blocked' || event === 'needs_review' ? await readReport(job.id) : null;
    const dedupKey = getDedupKey(event, job, report?.timestamp);
    if (sent.has(dedupKey)) {
      return;
    }

    // Skip notifications in subagent sessions
    try {
      if (await isSubagent()) return;
    } catch {
      // If detection fails, continue sending (safer default)
    }

    const sessionID = await getActiveSessionID();
    if (!sessionID || !sessionID.startsWith('ses')) {
      return;
    }

    const duration = formatDuration(job.createdAt);
    let message = '';

    if (event === 'complete') {
      message = `🟢 Job '${job.name}' completed in ${duration}. Branch: ${job.branch}. Next: run mc_diff(name: '${job.name}') to review changes, then mc_pr or mc_merge.`;
    } else if (event === 'failed') {
      message = `🔴 Job '${job.name}' failed after ${duration}. Branch: ${job.branch}. Next: run mc_capture(name: '${job.name}') for logs, then mc_attach(name: '${job.name}') to investigate.`;
    } else if (event === 'blocked') {
      const detail = report?.message ? ` Agent says: ${report.message}` : '';
      message = `⚠️ Job '${job.name}' is blocked (${duration} elapsed). Branch: ${job.branch}.${detail} Next: run mc_status(name: '${job.name}') and unblock, then continue or relaunch.`;
    } else if (event === 'awaiting_input') {
      message = `❓ Job '${job.name}' is waiting for input (${duration} elapsed). The agent asked a clarifying question. Next: run mc_attach(name: '${job.name}') to answer the question, or mc_kill(name: '${job.name}') to abort.`;
    } else {
      const detail = report?.message ? ` Reviewer note: ${report.message}` : '';
      message = `👀 Job '${job.name}' needs review (${duration} elapsed). Branch: ${job.branch}.${detail} Next: run mc_diff(name: '${job.name}') and mc_capture(name: '${job.name}') before approving next steps.`;
    }

    await sendMessage(client, sessionID, message);
    sent.add(dedupKey);
  };

  const enqueue = (event: NotificationEvent, job: Job): void => {
    pending = pending.then(() => notify(event, job)).catch(() => {});
  };

  monitor.on('complete', (job) => enqueue('complete', job));
  monitor.on('failed', (job) => enqueue('failed', job));
  monitor.on('blocked', (job) => enqueue('blocked', job));
  monitor.on('needs_review', (job) => enqueue('needs_review', job));
  monitor.on('awaiting_input', (job) => enqueue('awaiting_input', job));
}
