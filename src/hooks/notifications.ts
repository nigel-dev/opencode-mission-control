import type { PluginInput } from '@opencode-ai/plugin';
import type { Job } from '../lib/job-state';
import { readReport } from '../lib/reports';
import { formatElapsed } from '../lib/utils';

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

interface SessionTitleState {
  originalTitle: string;
  annotations: Map<string, string>; // jobName → status text ("done", "failed", "needs input")
}

const titleState = new Map<string, SessionTitleState>();

function extractSessionTitle(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const obj = response as Record<string, unknown>;

  // SDK may wrap in { data: { ... } } or return flat
  if (obj.data && typeof obj.data === 'object') {
    const data = obj.data as Record<string, unknown>;
    if (typeof data.title === 'string') return data.title;
  }

  if (typeof obj.title === 'string') return obj.title;

  return undefined;
}

function buildAnnotatedTitle(state: SessionTitleState): string {
  if (state.annotations.size === 0) return state.originalTitle;
  if (state.annotations.size === 1) {
    const [[jobName, statusText]] = [...state.annotations.entries()];
    return `${jobName} ${statusText}`;
  }
  return `${state.annotations.size} jobs need attention`;
}

export async function annotateSessionTitle(
  client: Client,
  sessionID: string,
  jobName: string,
  statusText: string,
): Promise<void> {
  if (!sessionID || !sessionID.startsWith('ses')) return;

  try {
    if (!titleState.has(sessionID)) {
      const session = await client.session.get({ path: { id: sessionID } });
      const originalTitle = extractSessionTitle(session) ?? '';
      titleState.set(sessionID, {
        originalTitle,
        annotations: new Map(),
      });
    }

    const state = titleState.get(sessionID)!;
    state.annotations.set(jobName, statusText);
    const annotatedTitle = buildAnnotatedTitle(state);

    await client.session.update({
      path: { id: sessionID },
      body: { title: annotatedTitle },
    });
  } catch {
    // Fire-and-forget: don't block on title update failures
  }
}

export async function resetSessionTitle(client: Client, sessionID: string): Promise<void> {
  const state = titleState.get(sessionID);
  if (!state) return;

  const originalTitle = state.originalTitle;
  titleState.delete(sessionID);

  try {
    await client.session.update({
      path: { id: sessionID },
      body: { title: originalTitle },
    });
  } catch {
    // Fire-and-forget: don't block on title reset failures
  }
}

export function hasAnnotation(sessionID: string): boolean {
  return titleState.has(sessionID);
}

// Exposed for testing only
export function _getTitleStateForTesting(): Map<string, SessionTitleState> {
  return titleState;
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

    const sessionID = job.launchSessionID ?? await getActiveSessionID();
    if (!sessionID || !sessionID.startsWith('ses')) {
      return;
    }

    const duration = formatElapsed(job.createdAt);
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

    const titleAnnotationMap: Partial<Record<NotificationEvent, string>> = {
      complete: 'done',
      failed: 'failed',
      awaiting_input: 'needs input',
    };
    const statusText = titleAnnotationMap[event];
    if (statusText) {
      await annotateSessionTitle(client, sessionID, job.name, statusText);
    }
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
