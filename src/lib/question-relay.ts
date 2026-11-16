import type { FormField, FormInfo, FormOption, FormValue } from '@opencode/client';
import type { OpencodeClient } from './sdk-client.js';
import type { Job } from './job-state.js';
import { createJobClient, sendPrompt } from './sdk-client.js';

/**
 * A pending mcp_question from a serve-mode job's agent.
 * Keyed by `{jobId}:{partId}` for dedup.
 */
export interface PendingQuestion {
  jobId: string;
  jobName: string;
  taskSummary: string;
  partId: string;
  callID: string;
  remoteSessionID: string;
  port: number;
  serverPassword?: string;
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
 * Get a specific pending question by job name (for mc_answer tool).
 */
export function findPendingQuestionByJobName(jobName: string): PendingQuestion | undefined {
  for (const q of pendingQuestions.values()) {
    if (q.jobName === jobName) {
      return q;
    }
  }
  return undefined;
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

/**
 * Get count of all pending questions.
 */
export function getPendingQuestionCount(): number {
  return pendingQuestions.size;
}

function getFormToolId(form: FormInfo): string | undefined {
  const tool = form.metadata?.tool;
  if (tool && typeof tool === 'object' && 'id' in tool) {
    const id = (tool as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

function getFormKind(form: FormInfo): string | undefined {
  const kind = form.metadata?.kind;
  return typeof kind === 'string' ? kind : undefined;
}

/**
 * Locate the form backing a question tool call. V2 renders the `question` tool
 * as a session form, so the tool call id is stored in form metadata.
 */
export function findQuestionForm(forms: readonly FormInfo[], partId: string): FormInfo | undefined {
  const exact = forms.find((form) => getFormToolId(form) === partId);
  if (exact) return exact;

  const questions = forms.filter((form) => getFormKind(form) === 'question');
  return questions.length === 1 ? questions[0] : undefined;
}

function matchOptionValue(options: readonly FormOption[] | undefined, raw: string): string {
  const text = raw.trim();
  if (!options) return text;
  const match = options.find(
    (option) =>
      option.value.toLowerCase() === text.toLowerCase() ||
      option.label.toLowerCase() === text.toLowerCase(),
  );
  return match ? match.value : text;
}

function coerceFormField(field: FormField, raw: string): FormValue {
  switch (field.type) {
    case 'multiselect': {
      const parts = raw
        .split(/[,\n;]+/)
        .map((part) => part.trim())
        .filter(Boolean);
      return parts.map((part) => matchOptionValue(field.options, part));
    }
    case 'boolean':
      return /^(true|yes|y|1|on)$/i.test(raw.trim());
    case 'number':
    case 'integer': {
      const value = Number(raw.trim());
      return Number.isFinite(value) ? value : raw.trim();
    }
    case 'string':
      return field.options && field.options.length > 0
        ? matchOptionValue(field.options, raw)
        : raw;
    default:
      return raw;
  }
}

export function buildFormAnswer(
  fields: readonly FormField[],
  response: string,
): Record<string, FormValue> {
  const answer: Record<string, FormValue> = {};
  const lines = response.split(/\r?\n/).map((line) => line.trim());
  const linePerField = fields.length > 1 && lines.length >= fields.length;

  fields.forEach((field, index) => {
    const raw = fields.length === 1
      ? response
      : linePerField
        ? lines[index]
        : index === 0
          ? response
          : '';
    answer[field.key] = coerceFormField(field, raw);
  });

  return answer;
}

/**
 * Answer a pending question by replying to the question form on the job's
 * session. V2's `question` tool is implemented as a session form; posting a
 * prompt does not unblock it. Fall back to a prompt for compatibility.
 */
export async function answerPendingQuestion(
  question: PendingQuestion,
  response: string,
  password?: string,
): Promise<void> {
  const client = createJobClient(question.port, question.serverPassword ?? password);

  let form: FormInfo | undefined;
  try {
    const forms = await client.session.form.list({ sessionID: question.remoteSessionID });
    form = findQuestionForm(forms, question.partId);
  } catch {
    // Form listing may fail on older servers; fall back to a prompt below.
  }

  if (form) {
    await client.session.form.reply({
      sessionID: question.remoteSessionID,
      formID: form.id,
      answer: buildFormAnswer(form.fields, response),
    });
  } else {
    await sendPrompt(client, question.remoteSessionID, response);
  }

  pendingQuestions.delete(pendingKey(question.jobId, question.partId));
}

/**
 * Build a notification message for relaying a question to the launching session.
 */
export function buildQuestionRelayMessage(question: PendingQuestion): string {
  const parts: string[] = [
    `❓ Job "${question.jobName}" is asking a question.`,
    `Task: ${question.taskSummary}`,
    '',
    'IMPORTANT: You MUST use mcp_question to present this question to the user with the EXACT same options below,',
    `plus one final option labeled "Attach to job" with description "Open the job's terminal to see full context before answering".`,
    `If the user picks "Attach to job", run mc_attach(name: "${question.jobName}") instead of mc_answer.`,
    `Otherwise, use mc_answer(name: "${question.jobName}", response: "<user's choice>") to send their answer back.`,
    '',
  ];

  if (question.header) {
    parts.push(`Header: ${question.header}`);
  }

  parts.push(`Question: ${question.question}`);

  if (question.options.length > 0) {
    parts.push('');
    parts.push('Options (pass these exactly to mcp_question):');
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
 * Permission request from an SSE event
 */
export interface PermissionRequest {
  id: string;
  type: 'file_operation' | 'shell_command' | 'network' | 'mcp' | 'other';
  path?: string;
  description: string;
  action?: string;
  target?: string;
  rawType?: string;
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
 * Result of handling a permission request
 */
export interface PermissionResult {
  approved: boolean;
  autoApproved: boolean;
  reason: string;
}

/**
 * Configuration for question relay behavior
 */
export interface QuestionRelayConfig {
  autoResponseTimeoutMs: number;
  defaultResponse: string;
}

const DEFAULT_CONFIG: QuestionRelayConfig = {
  autoResponseTimeoutMs: 120_000, // 2 minutes
  defaultResponse: 'use your best judgment',
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
 * Check if a path is inside the worktree
 */
export function isPathInsideWorktree(path: string, worktreePath: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedWorktree = worktreePath.replace(/\\/g, '/');
  return normalizedPath.startsWith(normalizedWorktree);
}

/**
 * Determine if a permission request should be auto-approved
 */
export function shouldAutoApprove(
  permission: PermissionRequest,
  worktreePath: string,
): PermissionResult {
  // MCP tool execution: auto-approve
  if (permission.type === 'mcp') {
    return {
      approved: true,
      autoApproved: true,
      reason: 'MCP tool execution is auto-approved',
    };
  }

  // File operations: check if inside worktree
  if (permission.type === 'file_operation' && permission.path) {
    if (isPathInsideWorktree(permission.path, worktreePath)) {
      return {
        approved: true,
        autoApproved: true,
        reason: 'File operation inside worktree is auto-approved',
      };
    }
    return {
      approved: false,
      autoApproved: false,
      reason: 'File operation outside worktree requires user approval',
    };
  }

  // Shell commands: check if inside worktree context
  if (permission.type === 'shell_command') {
    // Shell commands are generally safe inside worktree, but check if path is specified
    if (!permission.path || isPathInsideWorktree(permission.path, worktreePath)) {
      return {
        approved: true,
        autoApproved: true,
        reason: 'Shell command inside worktree is auto-approved',
      };
    }
    return {
      approved: false,
      autoApproved: false,
      reason: 'Shell command outside worktree requires user approval',
    };
  }

  // Network/dangerous operations: always relay to user
  if (permission.type === 'network') {
    return {
      approved: false,
      autoApproved: false,
      reason: 'Network operation requires user approval',
    };
  }

  // Unknown/other types: relay to user
  return {
    approved: false,
    autoApproved: false,
    reason: 'Unknown permission type requires user approval',
  };
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
  }

  parts.push('');
  parts.push('Options:');
  parts.push('  - Reply "yes" to approve');
  parts.push('  - Reply "no" to deny');
  parts.push('  - Reply with specific instructions');
  parts.push('  - Let it decide: use its best judgment (auto-response after timeout)');

  return parts.join('\n');
}

/**
 * Question relay handler for managing permission requests
 */
export class QuestionRelay {
  private config: QuestionRelayConfig;
  private pendingResponses: Map<string, Timer> = new Map();
  private clients: Map<string, OpencodeClient> = new Map();

  constructor(config: Partial<QuestionRelayConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get or create a client for a job's port
   */
  private getClient(port: number, password?: string): OpencodeClient {
    const key = `${port}:${password ?? ''}`;
    if (!this.clients.has(key)) {
      this.clients.set(key, createJobClient(port, password));
    }
    return this.clients.get(key)!;
  }

  /**
   * Handle a permission request from an SSE event
   * Returns true if auto-approved, false if relayed to user
   */
  async handlePermissionRequest(
    job: Job,
    permission: PermissionRequest,
    currentFile?: string,
  ): Promise<PermissionResult> {
    const result = shouldAutoApprove(permission, job.worktreePath);

    if (result.autoApproved) {
      // Auto-approve the permission
      if (job.port && job.remoteSessionID) {
        try {
          const client = this.getClient(job.port, job.serverPassword);
          await this.replyToPermission(client, job.remoteSessionID, permission.id, true);
        } catch (error) {
          console.error(`[QuestionRelay] Failed to auto-approve permission for job ${job.name}:`, error);
        }
      }
      return result;
    }

    // Relay to launching session
    if (job.launchSessionID && job.port) {
      await this.relayToLaunchingSession(job, permission, currentFile);
    }

    return result;
  }

  async respondToPermission(
    job: Job,
    permissionId: string,
    approved: boolean,
    message?: string,
  ): Promise<void> {
    if (!job.port || !job.remoteSessionID) {
      return;
    }

    const client = this.getClient(job.port, job.serverPassword);
    await this.replyToPermission(client, job.remoteSessionID, permissionId, approved, message);
  }

  /**
   * Relay a question to the launching session
   */
  private async relayToLaunchingSession(
    job: Job,
    permission: PermissionRequest,
    currentFile?: string,
  ): Promise<void> {
    if (!job.launchSessionID || !job.remoteSessionID || !job.port) {
      console.warn(`[QuestionRelay] Cannot relay: missing launchSessionID, remoteSessionID or port for job ${job.name}`);
      return;
    }

    const context: QuestionContext = {
      jobName: job.name,
      taskSummary: buildTaskSummary(job.prompt),
      currentFile,
      permissionRequest: permission,
    };

    const prompt = buildQuestionPrompt(context);

    try {
      // The launching session belongs to the control-center server, not the
      // job's server. Relay through the shared notifier instead of the job
      // client, which would raise SessionNotFoundError.
      const { getSharedNotifyCallback } = await import('./orchestrator-singleton.js');
      const notify = getSharedNotifyCallback();
      if (notify) {
        notify(prompt, job.launchSessionID);
      } else {
        console.warn(
          `[QuestionRelay] No control-center notifier available; permission request for job ${job.name} was not relayed.`,
        );
      }

      // Auto-response always targets the job server.
      const client = this.getClient(job.port, job.serverPassword);
      this.setupAutoResponse(job.id, permission.id, job.remoteSessionID, client);
    } catch (error) {
      console.error(`[QuestionRelay] Failed to relay question for job ${job.name}:`, error);
    }
  }

  /**
   * Set up automatic response after timeout
   */
  private setupAutoResponse(
    jobId: string,
    permissionId: string,
    sessionID: string,
    client: OpencodeClient,
  ): void {
    // Clear any existing timeout for this permission
    const existingKey = `${jobId}:${permissionId}`;
    if (this.pendingResponses.has(existingKey)) {
      clearTimeout(this.pendingResponses.get(existingKey)!);
    }

    // Set new timeout
    const timeoutId = setTimeout(async () => {
      try {
        await this.replyToPermission(client, sessionID, permissionId, true, this.config.defaultResponse);
        console.log(`[QuestionRelay] Auto-responded to permission ${permissionId} for job ${jobId}`);
      } catch (error) {
        console.error(`[QuestionRelay] Failed to auto-respond for job ${jobId}:`, error);
      } finally {
        this.pendingResponses.delete(existingKey);
      }
    }, this.config.autoResponseTimeoutMs);

    this.pendingResponses.set(existingKey, timeoutId);
  }

  /**
   * Reply to a permission request
   */
  private async replyToPermission(
    client: OpencodeClient,
    sessionID: string,
    permissionId: string,
    approved: boolean,
    message?: string,
  ): Promise<void> {
    try {
      await client.permission.reply({
        sessionID,
        requestID: permissionId,
        decision: approved ? "once" : "reject",
        message: message || (approved ? "Approved" : "Denied"),
      });
    } catch (error) {
      console.error(`[QuestionRelay] Failed to reply to permission ${permissionId}:`, error);
      throw error;
    }
  }

  /**
   * Handle user response to a relayed question
   * Called when the user replies in the launching session
   */
  async handleUserResponse(
    job: Job,
    permissionId: string,
    response: string,
  ): Promise<void> {
    // Clear the auto-response timeout
    const key = `${job.id}:${permissionId}`;
    if (this.pendingResponses.has(key)) {
      clearTimeout(this.pendingResponses.get(key)!);
      this.pendingResponses.delete(key);
    }

    if (!job.port || !job.remoteSessionID) {
      return;
    }

    // Parse user response
    const normalizedResponse = response.toLowerCase().trim();
    let approved: boolean;
    let message: string;

    if (normalizedResponse === 'yes' || normalizedResponse === 'y' || normalizedResponse === 'approve') {
      approved = true;
      message = 'Approved by user';
    } else if (normalizedResponse === 'no' || normalizedResponse === 'n' || normalizedResponse === 'deny') {
      approved = false;
      message = 'Denied by user';
    } else if (normalizedResponse.includes('let it decide') || normalizedResponse.includes('best judgment')) {
      approved = true;
      message = 'Let agent use best judgment';
    } else {
      // Treat as specific instructions - approve with the message
      approved = true;
      message = response;
    }

    try {
      const client = this.getClient(job.port, job.serverPassword);
      await this.replyToPermission(client, job.remoteSessionID, permissionId, approved, message);
    } catch (error) {
      console.error(`[QuestionRelay] Failed to send user response for job ${job.name}:`, error);
    }
  }

  /**
   * Clean up resources for a job
   */
  cleanup(jobId: string): void {
    // Clear all pending timeouts for this job
    for (const [key, timeoutId] of this.pendingResponses) {
      if (key.startsWith(`${jobId}:`)) {
        clearTimeout(timeoutId);
        this.pendingResponses.delete(key);
      }
    }
  }

  /**
   * Clean up all resources
   */
  dispose(): void {
    for (const timeoutId of this.pendingResponses.values()) {
      clearTimeout(timeoutId);
    }
    this.pendingResponses.clear();
    this.clients.clear();
  }
}
