import { getSharedNotifyCallback } from './notify.js';
import type { Job } from './job-state.js';
import { getRuntimeClient, type RuntimeClient } from './job-runtime.js';
import { PERMISSION_ANSWER_TIMEOUT_MS, PERMISSION_TIMEOUT_MESSAGE } from './job-permissions.js';
import { emitAttention } from './rpc-events.js';

/**
 * A pending question asked by a job's agent through the `question` tool.
 * Keyed by `{jobId}:{partId}` for dedup.
 */
export interface PendingQuestion {
  jobId: string;
  jobName: string;
  taskSummary: string;
  partId: string;
  callID: string;
  /** The job's own session, where the question form lives. */
  sessionID: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  header?: string;
  multiple?: boolean;
  detectedAt: number;
}

/**
 * In-memory store for pending questions across all jobs.
 */
const pendingQuestions = new Map<string, PendingQuestion>();

function pendingKey(jobId: string, partId: string): string {
  return `${jobId}:${partId}`;
}

/**
 * Register a pending question detected from an SSE event.
 * Returns true if this is a new question (not a duplicate).
 */
export function addPendingQuestion(question: PendingQuestion): boolean {
  const key = pendingKey(question.jobId, question.partId);
  if (pendingQuestions.has(key)) {
    return false;
  }
  pendingQuestions.set(key, question);
  return true;
}

/**
 * Remove a pending question (tool completed or errored).
 */
export function removePendingQuestion(jobId: string, partId: string): boolean {
  return pendingQuestions.delete(pendingKey(jobId, partId));
}

/**
 * Get all pending questions for a specific job.
 */
export function getPendingQuestionsForJob(jobId: string): PendingQuestion[] {
  const result: PendingQuestion[] = [];
  for (const [key, q] of pendingQuestions) {
    if (key.startsWith(`${jobId}:`)) {
      result.push(q);
    }
  }
  return result;
}

/**
 * Clear all pending questions for a job (cleanup).
 */
export function clearPendingQuestionsForJob(jobId: string): void {
  for (const key of pendingQuestions.keys()) {
    if (key.startsWith(`${jobId}:`)) {
      pendingQuestions.delete(key);
    }
  }
}

export { findQuestionForm, buildFormAnswer } from './form-answer.js';

/**
 * Build a notification message for relaying a question to the launching session.
 */
export function buildQuestionRelayMessage(question: PendingQuestion): string {
  const parts: string[] = [
    `❓ Job "${question.jobName}" is asking a question in its own session.`,
    `Task: ${question.taskSummary}`,
    '',
    'This is an interactive form that can only be answered in the job\'s session.',
    `Tell the user to open it: run mc_attach(name: "${question.jobName}"), or answer it from the Mission Control panel in the TUI.`,
    '',
  ];

  if (question.header) {
    parts.push(`Header: ${question.header}`);
  }

  parts.push(`Question: ${question.question}`);

  if (question.options.length > 0) {
    parts.push('');
    parts.push('Options:');
    for (const opt of question.options) {
      const desc = opt.description ? ` — ${opt.description}` : '';
      parts.push(`  - ${opt.label}${desc}`);
    }
  }

  if (question.multiple) {
    parts.push('');
    parts.push('(Allow multiple selections)');
  }

  return parts.join('\n');
}

/**
 * A permission request raised by a job's session, as the monitor classified it.
 */
export interface PermissionRequest {
  id: string;
  type: 'file_operation' | 'shell_command' | 'network' | 'mcp' | 'other';
  /** Target of a file operation, absolute. Never set for shell commands. */
  path?: string;
  description: string;
  action?: string;
  target?: string;
  rawType?: string;
  /** The command line of a shell request. */
  command?: string;
}

/**
 * Context for relaying a question to the launching session
 */
export interface QuestionContext {
  jobName: string;
  taskSummary: string;
  currentFile?: string;
  permissionRequest?: PermissionRequest;
}

/**
 * Configuration for question relay behavior
 */
export interface QuestionRelayConfig {
  autoResponseTimeoutMs: number;
  defaultResponse: string;
}

const DEFAULT_CONFIG: QuestionRelayConfig = {
  autoResponseTimeoutMs: PERMISSION_ANSWER_TIMEOUT_MS,
  defaultResponse: PERMISSION_TIMEOUT_MESSAGE,
};

/**
 * Build a task summary from job prompt (first ~120 chars)
 */
export function buildTaskSummary(prompt: string): string {
  const maxLen = 120;
  if (prompt.length <= maxLen) {
    return prompt;
  }
  return prompt.slice(0, maxLen - 3) + '...';
}

/**
 * Build the question prompt to send to the launching session
 */
export function buildQuestionPrompt(context: QuestionContext): string {
  const parts: string[] = [
    `🔔 Job "${context.jobName}" needs your attention:`,
    '',
    `Task: ${context.taskSummary}`,
  ];

  if (context.currentFile) {
    parts.push(`Current file: ${context.currentFile}`);
  }

  if (context.permissionRequest) {
    parts.push('');
    parts.push('Permission request:');
    parts.push(`  Type: ${context.permissionRequest.type}`);
    parts.push(`  Description: ${context.permissionRequest.description}`);
    if (context.permissionRequest.path) {
      parts.push(`  Path: ${context.permissionRequest.path}`);
    }
    if (context.permissionRequest.command) {
      parts.push(`  Command: ${context.permissionRequest.command}`);
    }
  }

  parts.push('');
  parts.push('Options:');
  parts.push(`  - Approve or deny it in the job's session: run mc_attach(name: "${context.jobName}"), or use the Mission Control dashboard`);
  parts.push('  - If nobody answers before the timeout, the request is denied and the job continues without it');

  return parts.join('\n');
}

/**
 * Relays permission requests the policy wants a human to decide, and denies
 * the ones nobody answers in time.
 */
export class QuestionRelay {
  private config: QuestionRelayConfig;

  constructor(config: Partial<QuestionRelayConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Hand a permission request to the user. The policy said "ask-user", so
   * nothing is approved here: the request is announced (to the launching
   * session when there is one, and always to connected clients), and it is
   * denied when nobody answers before the timeout.
   */
  async handlePermissionRequest(
    job: Job,
    permission: PermissionRequest,
    currentFile?: string,
  ): Promise<void> {
    if (!job.sessionID) {
      console.warn(`[QuestionRelay] Job ${job.name} has no session; its permission request cannot be answered.`);
      return;
    }

    // The denial of an unanswered request is armed by the permission gate in
    // the job's own location (installPermissionGate): only a plugin instance
    // there can answer the job's permission requests.

    if (job.launchSessionID) {
      const prompt = buildQuestionPrompt({
        jobName: job.name,
        taskSummary: buildTaskSummary(job.prompt),
        currentFile,
        permissionRequest: permission,
      });
      // Relay through the shared notifier so the request reaches the launching
      // session the same way every other Mission Control notification does.
      const notify = getSharedNotifyCallback();
      if (notify) {
        notify(prompt, job.launchSessionID);
      } else {
        console.warn(
          `[QuestionRelay] No control-center notifier available; permission request for job ${job.name} was not relayed to its launching session.`,
        );
      }
    }

    // Best-effort and never throws: clients show it as a toast and a system notification.
    await emitAttention({
      kind: 'question',
      title: `Job "${job.name}" needs permission`,
      message: `${permission.description} Denied automatically if nobody answers in ${Math.round(this.config.autoResponseTimeoutMs / 1000)}s.`,
      jobName: job.name,
      sessionID: job.sessionID,
    });
  }

  async respondToPermission(
    job: Job,
    permissionId: string,
    approved: boolean,
    message?: string,
  ): Promise<void> {
    if (!job.sessionID) {
      return;
    }

    await this.replyToPermission(getRuntimeClient(), job.sessionID, permissionId, approved, message);
  }

  /**
   * Reply to a permission request
   */
  private async replyToPermission(
    client: RuntimeClient,
    sessionID: string,
    permissionId: string,
    approved: boolean,
    message?: string,
  ): Promise<void> {
    await client.permission.reply({
      sessionID,
      requestID: permissionId,
      decision: approved ? "once" : "reject",
      message: message || (approved ? "Approved" : "Denied"),
    });
  }
}
