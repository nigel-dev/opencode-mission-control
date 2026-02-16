import type { PluginInput } from '@opencode-ai/plugin';
import type { Job } from '../lib/job-state';
import { readReport } from '../lib/reports';
import { formatElapsed } from '../lib/utils';
import { type PendingQuestion, buildQuestionRelayMessage } from '../lib/question-relay';

type Client = PluginInput['client'];
type NotificationEvent = 'complete' | 'failed' | 'blocked' | 'needs_review' | 'awaiting_input' | 'question';

interface JobMonitorLike {
  on(event: NotificationEvent, handler: (job: Job, ...extra: unknown[]) => void): void;
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

async function sendMessage(client: Client, sessionID: string, text: string, expectReply = false): Promise<void> {
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      noReply: !expectReply,
      parts: [{ type: 'text' as const, text, ...(!expectReply && { ignored: true }) }],
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

  const notify = async (event: NotificationEvent, job: Job, extra?: unknown): Promise<void> => {
    const report = event === 'blocked' || event === 'needs_review' ? await readReport(job.id) : null;
    const questionData = event === 'question' ? extra as PendingQuestion | undefined : undefined;
    const dedupKey = event === 'question' && questionData
      ? `question:${job.id}:${questionData.partId}`
      : getDedupKey(event, job, report?.timestamp);
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

    if (event === 'question' && questionData) {
      message = buildQuestionRelayMessage(questionData);
    } else if (event === 'complete') {
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

    let sessionLabel = sessionID;
    try {
      const sessionInfo = await client.session.get({ path: { id: sessionID } });
      const data = (sessionInfo as any)?.data ?? sessionInfo;
      sessionLabel = data?.title ?? data?.slug ?? sessionID;
    } catch {
      // Fall back to raw session ID
    }

    const titleAnnotationMap: Partial<Record<NotificationEvent, string>> = {
      complete: 'done',
      failed: 'failed',
      awaiting_input: 'needs input',
      question: 'has question',
    };
    const statusText = titleAnnotationMap[event];
    if (statusText) {
      await annotateSessionTitle(client, sessionID, job.name, statusText);
    }

    const toastMap: Partial<Record<NotificationEvent, { variant: 'info' | 'success' | 'warning' | 'error'; title: string }>> = {
      complete: { variant: 'success', title: `Job "${job.name}" completed` },
      failed: { variant: 'error', title: `Job "${job.name}" failed` },
      blocked: { variant: 'warning', title: `Job "${job.name}" is blocked` },
      awaiting_input: { variant: 'warning', title: `Job "${job.name}" needs input` },
      needs_review: { variant: 'info', title: `Job "${job.name}" needs review` },
      question: { variant: 'warning', title: `Job "${job.name}" has a question` },
    };
    const toast = toastMap[event];
    if (toast) {
      try {
        await client.tui.showToast({
          body: {
            title: toast.title,
            message: `Switch to session "${sessionLabel}" to respond`,
            variant: toast.variant,
            duration: event === 'question' ? 10000 : 5000,
          },
        });
      } catch {
        // Toast may not be available in all environments
      }
    }

    await sendMessage(client, sessionID, message, event === 'question');
    sent.add(dedupKey);
  };

  const enqueue = (event: NotificationEvent, job: Job, extra?: unknown): void => {
    pending = pending.then(() => notify(event, job, extra)).catch(() => {});
  };

  monitor.on('complete', (job) => enqueue('complete', job));
  monitor.on('failed', (job) => enqueue('failed', job));
  monitor.on('blocked', (job) => enqueue('blocked', job));
  monitor.on('needs_review', (job) => enqueue('needs_review', job));
  monitor.on('awaiting_input', (job) => enqueue('awaiting_input', job));
  monitor.on('question', (job, questionData) => enqueue('question', job, questionData));
}
