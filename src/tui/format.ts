import type { FormField, FormInfo, SessionFormReplyInput } from '@opencode/client';
import { buildFormAnswer } from '../lib/form-answer';
import { validateJobName } from '../lib/job-name';
import type {
  AttentionEvent,
  AttentionKind,
  JobView,
  PlanJobView,
  PlanView,
  SnapshotCounts,
  ToastVariant,
} from '../rpc';

// Pure presentation logic for the TUI part. Nothing here touches the renderer,
// so it can be unit tested without one.

/** Semantic color of a piece of status text; views map it to theme tokens. */
export type Tone = 'info' | 'success' | 'warning' | 'error' | 'muted';

export const DASHBOARD_PANEL = 'mission-control.dashboard';
export const DASHBOARD_COMMAND = 'mission-control.dashboard';
export const DASHBOARD_SLASH = 'mc-dashboard';
export const DASHBOARD_ROUTE = 'dashboard';
export const SIDEBAR_JOB_LIMIT = 6;

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

type JobState = Pick<JobView, 'status' | 'attention'>;

export function needsAttention(job: JobState): boolean {
  return job.attention !== 'none';
}

export function jobIcon(job: JobState): string {
  if (job.attention === 'question') return '?';
  if (job.attention !== 'none') return '⚠';
  switch (job.status) {
    case 'running':
      return '▶';
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'stopped':
      return '■';
  }
}

export function jobLabel(job: JobState): string {
  switch (job.attention) {
    case 'question':
      return 'question';
    case 'blocked':
      return 'blocked';
    case 'needs_review':
      return 'needs review';
    case 'none':
      return job.status;
  }
}

export function jobTone(job: JobState): Tone {
  if (job.attention !== 'none') return 'warning';
  switch (job.status) {
    case 'running':
      return 'info';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'stopped':
      return 'muted';
  }
}

function timeOf(value: string | undefined): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function jobRank(job: JobState): number {
  if (job.status === 'running' && !needsAttention(job)) return 0;
  if (needsAttention(job)) return 1;
  return 2;
}

/**
 * Running jobs first, then jobs needing attention, then finished jobs, each
 * group newest first (finished jobs by when they finished).
 */
export function sortJobs(jobs: readonly JobView[]): JobView[] {
  const recency = (job: JobView): number =>
    jobRank(job) === 2 ? timeOf(job.completedAt ?? job.createdAt) : timeOf(job.createdAt);

  return [...jobs].sort((left, right) => {
    const rank = jobRank(left) - jobRank(right);
    if (rank !== 0) return rank;
    const time = recency(right) - recency(left);
    if (time !== 0) return time;
    return left.name.localeCompare(right.name);
  });
}

/** The jobs a capped list shows, and how many it leaves out. */
export function capJobs(
  jobs: readonly JobView[],
  limit: number = SIDEBAR_JOB_LIMIT,
): { visible: JobView[]; hidden: number } {
  const sorted = sortJobs(jobs);
  const visible = sorted.slice(0, Math.max(0, limit));
  return { visible, hidden: sorted.length - visible.length };
}

function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** One short phrase about what a job is doing or waiting for. */
export function jobDetail(job: JobView): string {
  if (needsAttention(job)) {
    return job.note ?? job.report?.message ?? (job.attention === 'question' ? 'waiting for an answer' : '');
  }
  if (job.status !== 'running') {
    return job.note ?? '';
  }
  const tool = job.activity?.currentTool;
  const file = job.activity?.currentFile ? baseName(job.activity.currentFile) : undefined;
  if (tool && file) return `${tool} ${file}`;
  if (tool) return tool;
  if (file) return file;
  if (job.report?.message) return job.report.message;
  return '';
}

export function truncate(text: string, width: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (width <= 0) return '';
  if (single.length <= width) return single;
  if (width === 1) return '…';
  return `${single.slice(0, width - 1)}…`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** How long a job has run (running) or ran (finished). */
export function jobElapsed(job: Pick<JobView, 'createdAt' | 'completedAt'>, now: number): string {
  const start = timeOf(job.createdAt);
  if (start === 0) return '';
  const end = job.completedAt ? timeOf(job.completedAt) : now;
  return formatDuration(end - start);
}

/** Label/value rows describing a job in full, for the dashboard. */
export function jobDetailRows(job: JobView, now: number): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Status', value: `${jobLabel(job)} (${jobElapsed(job, now)})` },
    { label: 'Branch', value: job.branch },
    { label: 'Worktree', value: job.worktreePath },
  ];
  if (job.sessionID) rows.push({ label: 'Session', value: job.sessionID });
  if (job.agent) rows.push({ label: 'Agent', value: job.agent });
  if (job.model) rows.push({ label: 'Model', value: job.model });
  if (job.planId) rows.push({ label: 'Plan', value: job.planId });
  if (job.note) rows.push({ label: 'Note', value: job.note });
  if (job.report) {
    const progress = job.report.progress !== undefined ? ` (${job.report.progress}%)` : '';
    rows.push({ label: 'Report', value: `[${job.report.status}]${progress} ${job.report.message}` });
  }
  if (job.activity) {
    const parts = [
      job.activity.currentTool,
      job.activity.currentFile,
      `${job.activity.filesEdited} file${job.activity.filesEdited === 1 ? '' : 's'} edited`,
    ].filter((part): part is string => Boolean(part));
    rows.push({ label: 'Activity', value: parts.join(' · ') });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

export interface FooterSegment {
  text: string;
  tone: Tone;
}

/** The parts of the footer indicator; empty when there are no jobs. */
export function footerSegments(counts: SnapshotCounts | undefined): FooterSegment[] {
  if (!counts) return [];
  const segments: FooterSegment[] = [];
  if (counts.running > 0) segments.push({ text: `▶${counts.running}`, tone: 'info' });
  if (counts.blocked > 0) segments.push({ text: `⚠${counts.blocked}`, tone: 'warning' });
  if (counts.completed > 0) segments.push({ text: `✓${counts.completed}`, tone: 'success' });
  if (counts.failed > 0) segments.push({ text: `✗${counts.failed}`, tone: 'error' });
  if (counts.stopped > 0) segments.push({ text: `■${counts.stopped}`, tone: 'muted' });
  return segments;
}

/** The footer indicator as plain text, e.g. `MC ▶3 ⚠1 ✓5 ✗1`; empty when there are no jobs. */
export function footerSummary(counts: SnapshotCounts | undefined): string {
  const segments = footerSegments(counts);
  if (segments.length === 0) return '';
  return ['MC', ...segments.map((segment) => segment.text)].join(' ');
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const ACTIVE_PLAN_STATUSES = new Set(['pending', 'running', 'paused', 'merging', 'creating_pr']);

export function isPlanActive(plan: Pick<PlanView, 'status'> | null | undefined): boolean {
  return Boolean(plan && ACTIVE_PLAN_STATUSES.has(plan.status));
}

export function planProgress(plan: Pick<PlanView, 'jobs'>): { merged: number; total: number } {
  return {
    merged: plan.jobs.filter((job) => job.status === 'merged').length,
    total: plan.jobs.length,
  };
}

/** The sidebar's plan line: name, status and merged/total. */
export function planSummary(plan: PlanView): string {
  const { merged, total } = planProgress(plan);
  const status = plan.checkpoint ? `checkpoint ${plan.checkpoint}` : plan.status;
  return `${plan.name} · ${status} · ${merged}/${total} merged`;
}

export function planJobIcon(status: string): string {
  switch (status) {
    case 'merged':
      return '✓';
    case 'completed':
    case 'ready_to_merge':
      return '◆';
    case 'running':
      return '▶';
    case 'merging':
      return '⇄';
    case 'failed':
    case 'conflict':
    case 'needs_rebase':
      return '✗';
    case 'stopped':
    case 'canceled':
      return '■';
    default:
      return '○';
  }
}

export function planJobTone(status: string): Tone {
  switch (status) {
    case 'merged':
      return 'success';
    case 'running':
    case 'merging':
    case 'completed':
    case 'ready_to_merge':
      return 'info';
    case 'failed':
    case 'conflict':
    case 'needs_rebase':
      return 'error';
    default:
      return 'muted';
  }
}

export function planJobLine(job: PlanJobView): string {
  const deps = job.dependsOn.length > 0 ? `  ← ${job.dependsOn.join(', ')}` : '';
  return `${planJobIcon(job.status)} ${job.name}  ${job.status.replace(/_/g, ' ')}${deps}`;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

export function moveIndex(index: number, delta: number, length: number): number {
  return clampIndex(index + delta, length);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function toVariant(value: unknown): ToastVariant {
  if (value === 'info' || value === 'success' || value === 'warning' || value === 'error') {
    return value;
  }
  return 'info';
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export interface ToastView {
  title: string;
  message: string;
  variant: ToastVariant;
  duration: number;
}

/** Event data arrives unvalidated on the client; narrow it before showing it. */
export function toastFromEvent(data: Readonly<Record<string, unknown>>): ToastView {
  return {
    title: toText(data.title) || 'Mission Control',
    message: toText(data.message),
    variant: toVariant(data.variant),
    duration: typeof data.duration === 'number' ? data.duration : 5000,
  };
}

const ATTENTION_KINDS: readonly AttentionKind[] = [
  'complete',
  'failed',
  'blocked',
  'needs_review',
  'question',
  'checkpoint',
];

export function parseAttention(data: Readonly<Record<string, unknown>>): AttentionEvent | undefined {
  const kind = ATTENTION_KINDS.find((candidate) => candidate === data.kind);
  if (!kind || typeof data.message !== 'string') {
    return undefined;
  }
  return {
    kind,
    title: toText(data.title) || 'Mission Control',
    message: data.message,
    ...(typeof data.jobName === 'string' ? { jobName: data.jobName } : {}),
    ...(typeof data.sessionID === 'string' ? { sessionID: data.sessionID } : {}),
  };
}

export function parseOpen(
  data: Readonly<Record<string, unknown>>,
): { sessionID: string; title?: string } | undefined {
  if (typeof data.sessionID !== 'string' || data.sessionID === '') {
    return undefined;
  }
  return {
    sessionID: data.sessionID,
    ...(typeof data.title === 'string' ? { title: data.title } : {}),
  };
}

const ATTENTION_VARIANTS: Record<AttentionKind, ToastVariant> = {
  complete: 'success',
  failed: 'error',
  blocked: 'warning',
  needs_review: 'info',
  question: 'warning',
  checkpoint: 'warning',
};

const ACTION_HINTS: Partial<Record<AttentionKind, string>> = {
  blocked: `Open the dashboard (/${DASHBOARD_SLASH}) and press a to answer.`,
  question: `Open the dashboard (/${DASHBOARD_SLASH}) and press a to answer.`,
  checkpoint: `Open the dashboard (/${DASHBOARD_SLASH}) and press p to approve.`,
};

/** The toast for an attention event; kinds the user must act on say how. */
export function attentionToast(event: AttentionEvent): ToastView {
  const hint = ACTION_HINTS[event.kind];
  const message = [event.message, hint].filter(Boolean).join(' ');
  return {
    title: event.title,
    message,
    variant: ATTENTION_VARIANTS[event.kind],
    duration: hint ? 10000 : 5000,
  };
}

export type AttentionSoundName = 'default' | 'question' | 'permission' | 'error' | 'done';

export function attentionSound(kind: AttentionKind): AttentionSoundName {
  switch (kind) {
    case 'complete':
      return 'done';
    case 'failed':
      return 'error';
    case 'blocked':
    case 'question':
      return 'question';
    case 'checkpoint':
      return 'permission';
    case 'needs_review':
      return 'default';
  }
}

/**
 * Whether an RPC event belongs to this TUI's project. External clients receive
 * events from every location; an event or TUI without a location is accepted.
 */
export function sameLocation(
  eventLocation: { directory?: string } | undefined,
  location: { directory?: string } | undefined,
): boolean {
  if (!eventLocation?.directory || !location?.directory) {
    return true;
  }
  const trim = (directory: string): string =>
    directory.length > 1 ? directory.replace(/\/+$/, '') : directory;
  return trim(eventLocation.directory) === trim(location.directory);
}

/** The message of a failed RPC call: declared errors carry it in `data`. */
export function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown; data?: unknown };
    if (candidate.data && typeof candidate.data === 'object') {
      const message = (candidate.data as { message?: unknown }).message;
      if (typeof message === 'string' && message) return message;
    }
    if (typeof candidate.message === 'string' && candidate.message) {
      return candidate.message;
    }
  }
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

/** The first line of a tool's output, for a toast. */
export function firstLine(content: string): string {
  const line = content.split('\n').find((candidate) => candidate.trim() !== '');
  return line?.trim() ?? '';
}

export { validateJobName };

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

/** Fields a person fills in: not hidden, and not an external link. */
export function answerableFields(form: Pick<FormInfo, 'fields'>): FormField[] {
  return form.fields.filter(
    (field) => field.type !== 'external' && !('hidden' in field && field.hidden),
  );
}

/** What to show when asking for one form field's value. */
export function formFieldPrompt(
  form: Pick<FormInfo, 'title'>,
  field: FormField,
): { title: string; description?: string; placeholder?: string } {
  const lines: string[] = [];
  if (field.title && field.title !== form.title) lines.push(field.title);
  if (field.description) lines.push(field.description);

  let placeholder: string | undefined;
  if ((field.type === 'string' || field.type === 'multiselect') && field.options?.length) {
    lines.push(`Options: ${field.options.map((option) => option.label).join(', ')}`);
    placeholder = field.type === 'multiselect' ? 'comma-separated options' : 'one of the options';
  } else if (field.type === 'boolean') {
    placeholder = 'yes or no';
  } else if (field.type === 'number' || field.type === 'integer') {
    placeholder = 'a number';
  } else if (field.type === 'string' && field.placeholder) {
    placeholder = field.placeholder;
  }

  return {
    title: form.title || field.title || 'Answer',
    ...(lines.length > 0 ? { description: lines.join('\n') } : {}),
    ...(placeholder ? { placeholder } : {}),
  };
}

/** The reply to a form, from one typed response per answerable field. */
export function buildFormReply(
  form: Pick<FormInfo, 'id' | 'sessionID' | 'fields'>,
  responses: readonly string[],
): SessionFormReplyInput {
  const fields = answerableFields(form);
  const answer: Record<string, string | number | boolean | string[]> = {};
  fields.forEach((field, index) => {
    Object.assign(answer, buildFormAnswer([field], responses[index] ?? ''));
  });
  return { sessionID: form.sessionID, formID: form.id, answer };
}
