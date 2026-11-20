import { EventEmitter } from 'events';
import type { V2Event } from '@opencode/client';
import { getJob, getRunningJobs, loadJobState, updateJob, type Job } from './job-state.js';
import { loadConfig } from './config.js';
import { readReport, type AgentReport } from './reports.js';
import {
  getJobOutcome,
  getRuntimeClient,
  hasBackgroundWork,
  hasRuntimeClient,
  isJobSession,
  isSessionMissing,
  promptJobSession,
  registerJobSession,
  type JobOutcome,
} from './job-runtime.js';
import {
  QuestionRelay,
  type PermissionRequest,
  type PendingQuestion,
  addPendingQuestion,
  removePendingQuestion,
  clearPendingQuestionsForJob,
  getPendingQuestionsForJob,
  buildTaskSummary,
} from './question-relay.js';
import { emitChanged } from './rpc-events.js';
import { bindToDirectory, getProjectDirectory, runInProject } from './project-context.js';
import { findUncommittedChanges } from './worktree-status.js';
import { buildPermissionRequest, decidePermission, type PermissionData } from './job-permissions.js';

/**
 * The fields of a permission request the monitor reads. Both the
 * `permission.asked` event payload and `permission.list` entries satisfy it.
 */
interface QuestionToolPart {
  id: string;
  state: { status: string; input?: Record<string, unknown> };
}

type JobEventType = 'complete' | 'failed' | 'blocked' | 'needs_review' | 'awaiting_input' | 'agent_report' | 'question';

interface EventAccumulator {
  filesEdited: string[];
  currentTool?: string;
  lastActivityAt: number;
  eventCount: number;
  currentFile?: string;
}

const MAX_EVENTS_PER_JOB = 100;
const STREAM_INITIAL_BACKOFF_MS = 100;
const STREAM_MAX_BACKOFF_MS = 30000;
const STREAM_BACKOFF_FACTOR = 2;
const DEFAULT_JOB_CACHE_TTL_MS = 1000;
/** How long a job told to continue after a restart may take to start its next turn. */
const DEFAULT_RESUME_GRACE_MS = 60_000;
const MAX_LISTED_FILES = 20;

export const RESTART_PROMPT =
  'The server restarted while you were working. Continue your task from where you left off.';

/** How long after a user interrupt a delete of the same session still explains it. */
const INTERRUPT_THEN_DELETE_WINDOW_MS = 10_000;

export function buildCommitPrompt(files: string[]): string {
  const listed = files.slice(0, MAX_LISTED_FILES).map((file) => `  - ${file}`);
  if (files.length > MAX_LISTED_FILES) {
    listed.push(`  - ... and ${files.length - MAX_LISTED_FILES} more`);
  }
  return [
    'You ended your turn with uncommitted changes in your worktree:',
    ...listed,
    '',
    'Only committed work is taken from your branch. Commit everything that belongs to your task with a conventional commit message, remove anything that does not, then call mc_report(status: "completed", ...) again.',
  ].join('\n');
}

export interface JobMonitorOptions {
  /** How often running jobs are reconciled against their sessions and reports. */
  pollInterval?: number;
  /**
   * How long a lookup of running jobs is trusted before an event for an
   * unknown session triggers a reload. Bounds how often jobs.json is read for
   * events that belong to sessions that are not jobs.
   */
  jobCacheTtl?: number;
  /**
   * How long a job the monitor prompted (to continue after a restart, or to
   * commit) is given to start its next turn before its idle session is taken
   * at face value again.
   */
  resumeGrace?: number;
}

/** Narrow a raw stream event to the event union without trusting its shape. */
function toEvent(event: unknown): V2Event | undefined {
  if (!event || typeof event !== 'object') {
    return undefined;
  }
  const candidate = event as { type?: unknown };
  if (typeof candidate.type !== 'string') {
    return undefined;
  }
  return candidate as { type: string } as V2Event;
}

/**
 * Watches running jobs. Every job is an OpenCode session on the same server as
 * the plugin, so one subscription to the plugin's event stream covers all of
 * them: events are dispatched to the running job whose `sessionID` they carry.
 * A periodic reconcile pass covers anything the stream missed (a reload, a
 * dropped connection) and reads the reports agents write with `mc_report`.
 */
export class JobMonitor extends EventEmitter {
  private pollInterval: number;
  private jobCacheTtl: number;
  private intervalId?: Timer;
  private isRunning = false;
  private isReconciling = false;
  private abortController?: AbortController;
  private eventAccumulators: Map<string, EventAccumulator> = new Map();
  private questionRelay: QuestionRelay;

  /** Running jobs by session ID, as of the last load of jobs.json. */
  private jobsBySession: Map<string, Job> = new Map();
  private jobsLoadedAt = 0;

  /** Jobs already told they are waiting for input (one notification per wait). */
  private awaitingInputNotified: Set<string> = new Set();
  /** Permission requests per job that have not been answered yet. */
  private unansweredPermissions: Map<string, Set<string>> = new Map();
  /** `{jobId}:{permissionId}` of requests already processed, to skip replays. */
  private seenPermissions: Set<string> = new Set();
  /** Jobs whose pending questions and permissions were loaded from the server. */
  private backfilled: Set<string> = new Set();
  /** Jobs currently being moved to a terminal status. */
  private finishing: Set<string> = new Set();
  /**
   * Jobs just failed by a user interrupt, by session ID. Removing a running
   * session interrupts it first and deletes it a moment later; the delete
   * corrects the recorded reason.
   */
  private interruptedByUser: Map<string, { jobId: string; at: number }> = new Map();
  /** When this monitor started watching; jobs older than this ran before a restart. */
  private startedAt = Date.now();
  private resumeGrace: number;
  /** Jobs whose session was interrupted because the server shut down. */
  private shutdownInterrupted: Set<string> = new Set();
  /** Jobs this monitor has reconciled at least once. */
  private reconciledOnce: Set<string> = new Set();
  /**
   * Jobs the monitor just prompted (to commit, to continue after a restart),
   * with the time until which their next turn is given to start. Until it has
   * started, "the turn finished" still refers to the turn before the prompt.
   */
  private awaitingTurnStart: Map<string, number> = new Map();

  constructor(options: JobMonitorOptions = {}) {
    super();
    this.pollInterval = options.pollInterval ?? 10000;
    this.jobCacheTtl = options.jobCacheTtl ?? DEFAULT_JOB_CACHE_TTL_MS;
    this.resumeGrace = options.resumeGrace ?? DEFAULT_RESUME_GRACE_MS;
    this.questionRelay = new QuestionRelay();

    const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
    if (this.pollInterval < 10000 && !isTest) {
      throw new Error('Poll interval must be at least 10000ms (10s)');
    }
  }

  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.startedAt = Date.now();
    // Everything the monitor does later (timer ticks, stream events) is bound
    // to the project it was started for, instead of trusting the ambient
    // async context to still be there.
    const directory = getProjectDirectory();

    const abortController = new AbortController();
    this.abortController = abortController;

    if (hasRuntimeClient()) {
      this.runEventStream(abortController.signal, directory).catch((error) => {
        console.error('[Monitor] Event stream stopped unexpectedly:', error);
      });
    } else {
      console.warn('[Monitor] No runtime client available; job events will not be received.');
    }

    this.intervalId = setInterval(
      bindToDirectory(directory, () => {
        this.reconcile().catch((error) => {
          console.error('Error during job monitoring reconcile:', error);
        });
      }),
      this.pollInterval,
    );

    this.reconcile().catch((error) => {
      console.error('Error during initial job monitoring reconcile:', error);
    });
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.abortController?.abort();
    this.abortController = undefined;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.jobsBySession.clear();
    this.jobsLoadedAt = 0;
    this.interruptedByUser.clear();
    this.awaitingInputNotified.clear();
    this.unansweredPermissions.clear();
    this.seenPermissions.clear();
    this.backfilled.clear();
    this.shutdownInterrupted.clear();
    this.reconciledOnce.clear();
    this.awaitingTurnStart.clear();
  }

  on(event: JobEventType, handler: (job: Job, ...extra: unknown[]) => void): this {
    return super.on(event, handler);
  }

  getEventAccumulator(jobId: string): EventAccumulator | undefined {
    return this.eventAccumulators.get(jobId);
  }

  /** Permission requests of a job that wait for the user's answer. */
  getUnansweredPermissionCount(jobId: string): number {
    return this.unansweredPermissions.get(jobId)?.size ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Event stream
  // ---------------------------------------------------------------------------

  private async runEventStream(signal: AbortSignal, directory: string): Promise<void> {
    let reconnectAttempts = 0;

    while (this.isRunning && !signal.aborted) {
      try {
        const events = await runInProject(directory, () => getRuntimeClient().event.subscribe({ signal }));

        for await (const event of events) {
          if (signal.aborted) {
            return;
          }
          reconnectAttempts = 0;
          // The stream is the host's: re-enter the project for every event.
          await runInProject(directory, () => this.dispatchEvent(event));
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        console.warn('[Monitor] Event stream error:', error);
      }

      if (signal.aborted || !this.isRunning) {
        return;
      }

      const backoffMs = Math.min(
        STREAM_INITIAL_BACKOFF_MS * Math.pow(STREAM_BACKOFF_FACTOR, reconnectAttempts),
        STREAM_MAX_BACKOFF_MS,
      );
      reconnectAttempts += 1;
      console.warn(
        `[Monitor] Event stream ended, reconnecting in ${backoffMs}ms (attempt ${reconnectAttempts})`,
      );
      await this.sleep(backoffMs, signal);
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private async dispatchEvent(raw: unknown): Promise<void> {
    const event = toEvent(raw);
    if (!event) {
      return;
    }

    try {
      const sessionID = (event.data as { sessionID?: unknown } | undefined)?.sessionID;

      if (event.type === 'session.deleted' && typeof sessionID === 'string') {
        const interrupted = this.interruptedByUser.get(sessionID);
        this.interruptedByUser.delete(sessionID);
        if (interrupted && Date.now() - interrupted.at < INTERRUPT_THEN_DELETE_WINDOW_MS) {
          const current = await getJob(interrupted.jobId);
          // Only the record is corrected: the failure was already announced.
          if (current?.status === 'failed') {
            await updateJob(interrupted.jobId, { failureReason: 'its session was deleted' });
          }
          return;
        }
      }

      if (event.type === 'session.created' && typeof sessionID === 'string') {
        // A session started by a job (a subagent) is the job's, not the
        // user's: remember it so it is never taken for the user's own session.
        const parentID = event.data.parentID;
        if (parentID && isJobSession(parentID)) {
          registerJobSession(sessionID);
        }
        return;
      }

      if (typeof sessionID === 'string') {
        // Events for sessions that are not jobs (the user's own sessions,
        // subagents of a job) are ignored.
        const job = await this.findJobBySession(sessionID);
        if (job) {
          await this.handleSSEEvent(job, event);
        }
        return;
      }

      if (event.type === 'filesystem.changed') {
        // File events carry no session; attribute them by worktree path.
        const job = this.findJobByFile(event.data.file);
        if (job) {
          await this.handleSSEEvent(job, event);
        }
      }
    } catch (error) {
      console.error(`[Monitor] Failed to handle event ${event.type}:`, error);
    }
  }

  private async refreshJobs(): Promise<Job[]> {
    const jobs = await getRunningJobs();
    this.jobsBySession.clear();
    for (const job of jobs) {
      if (job.sessionID) {
        this.jobsBySession.set(job.sessionID, job);
        registerJobSession(job.sessionID);
      }
    }
    this.jobsLoadedAt = Date.now();
    return jobs;
  }

  private async findJobBySession(sessionID: string): Promise<Job | undefined> {
    const cached = this.jobsBySession.get(sessionID);
    if (cached) {
      return cached;
    }

    // Unknown session: it may be a job launched since the last load, or not a
    // job at all. Reload, but no more often than the cache TTL.
    if (Date.now() - this.jobsLoadedAt < this.jobCacheTtl) {
      return undefined;
    }

    await this.refreshJobs();
    return this.jobsBySession.get(sessionID);
  }

  private findJobByFile(file: string): Job | undefined {
    for (const job of this.jobsBySession.values()) {
      if (file === job.worktreePath || file.startsWith(`${job.worktreePath}/`)) {
        return job;
      }
    }
    return undefined;
  }

  private async handleSSEEvent(job: Job, event: V2Event): Promise<void> {
    // Compared as a plain string so the monitor does not depend on whether the
    // installed client's event union already lists this event.
    const type: string = event.type;
    if (type === 'session.execution.interrupted') {
      const reason = (event.data as { reason?: unknown }).reason;
      if (reason === 'superseded') {
        // Newer input replaced the turn; the session keeps running.
        return;
      }
      if (reason === 'shutdown') {
        // The server is going down, the job did not fail. The reconcile pass
        // after the restart tells it to continue.
        this.shutdownInterrupted.add(job.id);
        return;
      }
      if (reason === 'user' && job.sessionID) {
        const now = Date.now();
        for (const [id, entry] of this.interruptedByUser) {
          if (now - entry.at >= INTERRUPT_THEN_DELETE_WINDOW_MS) this.interruptedByUser.delete(id);
        }
        this.interruptedByUser.set(job.sessionID, { jobId: job.id, at: now });
      }
      await this.finishJob(
        job,
        'failed',
        reason === 'user'
          ? 'its session was interrupted'
          : reason === 'inactivity'
            ? 'its session was interrupted after a period of inactivity'
            : `its session was interrupted (${String(reason ?? 'unknown reason')})`,
      );
      return;
    }
    if (type === 'session.deleted') {
      await this.finishJob(job, 'failed', 'its session was deleted');
      return;
    }
    if (type === 'session.execution.started') {
      // The turn a prompt of ours asked for is under way.
      this.awaitingTurnStart.delete(job.id);
      return;
    }

    switch (event.type) {
      case 'session.status': {
        if (event.data.status.type === 'idle') {
          await this.handleTurnFinished(job);
        }
        break;
      }

      case 'session.idle': {
        await this.handleTurnFinished(job);
        break;
      }

      case 'session.execution.succeeded': {
        await this.handleTurnFinished(job);
        break;
      }

      case 'session.execution.failed': {
        await this.finishJob(job, 'failed', 'its session ended with an error');
        break;
      }

      case 'session.tool.called': {
        const input = event.data.input as Record<string, unknown> | undefined;
        if (input && Array.isArray(input.questions)) {
          this.handleQuestionToolUpdate(job, {
            id: event.data.id,
            state: { status: 'running', input },
          });
        }
        this.updateEventAccumulator(job.id, { currentTool: 'streaming' });
        break;
      }

      case 'session.tool.progress':
      case 'session.tool.success':
      case 'session.tool.failed': {
        if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
          if (removePendingQuestion(job.id, event.data.id)) {
            // The question was answered: a later wait is a new one.
            this.awaitingInputNotified.delete(job.id);
          }
        }
        this.updateEventAccumulator(job.id, { currentTool: 'streaming' });
        break;
      }

      case 'filesystem.changed': {
        if (event.data.event !== 'unlink') {
          this.updateEventAccumulator(job.id, {
            filesEdited: [event.data.file],
            currentFile: event.data.file,
          });
        }
        break;
      }

      case 'permission.asked': {
        await this.handlePermissionUpdate(job, event.data);
        break;
      }

      case 'permission.replied': {
        const requestID = String(event.data.requestID);
        this.unansweredPermissions.get(job.id)?.delete(requestID);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Completion
  // ---------------------------------------------------------------------------

  /**
   * A session reports success every time a turn ends, including when the agent
   * merely stops to wait. A finished turn completes the job unless the job is
   * waiting on a question, an unanswered permission request, an answer to a
   * "blocked" report, or background work it started.
   * Returns true when the job was completed.
   */
  private async handleTurnFinished(job: Job): Promise<boolean> {
    const turnStartDeadline = this.awaitingTurnStart.get(job.id);
    if (turnStartDeadline !== undefined) {
      if (Date.now() < turnStartDeadline) {
        // A prompt was just sent and its turn has not started: this is still
        // the end of the turn before it (a late idle event, or the session's
        // recorded outcome not having moved on yet).
        return false;
      }
      this.awaitingTurnStart.delete(job.id);
    }

    const waitingOnQuestion = getPendingQuestionsForJob(job.id).length > 0;
    if (waitingOnQuestion || (await this.hasUnansweredPermission(job))) {
      if (!this.awaitingInputNotified.has(job.id)) {
        this.awaitingInputNotified.add(job.id);
        this.emit('awaiting_input', job);
      }
      return false;
    }

    const report = await this.readReportSafely(job);
    if (report?.status === 'blocked') {
      // The agent reported it is blocked and ended its turn to wait for an
      // answer (mc_answer resumes it). The job is not finished.
      this.emit('blocked', job, report);
      return false;
    }

    const saidDone = report?.status === 'completed' || report?.status === 'needs_review';
    if (!saidDone && job.sessionID && hasBackgroundWork(job.worktreePath, job.sessionID)) {
      // The session went idle with a shell or subagent of its own still
      // running; that work wakes it for another turn when it finishes. An
      // agent that reported completion is taken at its word instead (a dev
      // server left running must not keep the job open forever).
      return false;
    }

    return this.completeJob(job, report);
  }

  /**
   * Complete a job whose session is idle. Work that was never committed is not
   * on the job's branch, so it is checked first: the job is asked once to
   * commit it, and if it still has not, it completes flagged for review.
   */
  private async completeJob(job: Job, report: AgentReport | null): Promise<boolean> {
    const uncommitted = await this.findUncommittedSafely(job);

    if (uncommitted.length > 0 && job.sessionID) {
      const current = await getJob(job.id);
      const config = await loadConfig();
      if (current?.status === 'running' && !current.commitPromptedAt && config.autoCommit !== false) {
        try {
          await promptJobSession(job.sessionID, buildCommitPrompt(uncommitted));
          this.awaitingTurnStart.set(job.id, Date.now() + this.resumeGrace);
          await updateJob(job.id, { commitPromptedAt: new Date().toISOString() });
          return false;
        } catch (error) {
          // Could not ask: complete the job, flagged, instead of leaving it open.
          console.warn(`[Monitor] Could not ask job ${job.name} to commit its changes:`, error);
        }
      }
    }

    const finished = await this.finishJob(
      job,
      'completed',
      undefined,
      uncommitted.length > 0 ? { uncommittedChanges: uncommitted } : undefined,
    );
    if (finished && (uncommitted.length > 0 || report?.status === 'needs_review')) {
      this.emit('needs_review', finished, report);
    }
    return finished !== null;
  }

  private async findUncommittedSafely(job: Job): Promise<string[]> {
    try {
      return await findUncommittedChanges(job);
    } catch (error) {
      // A worktree that cannot be inspected (already removed) has nothing left
      // to protect, and must not keep the job from finishing.
      console.warn(`[Monitor] Could not check the worktree of job ${job.name} for uncommitted changes:`, error);
      return [];
    }
  }

  /**
   * Move a job to a terminal status and emit the matching event. Returns the
   * finished job, or null when the job is no longer running (it was killed,
   * cleaned up, or already finished by a concurrent event).
   */
  private async finishJob(
    job: Job,
    status: 'completed' | 'failed',
    failureReason?: string,
    extra?: Pick<Job, 'uncommittedChanges'>,
  ): Promise<Job | null> {
    if (this.finishing.has(job.id)) {
      return null;
    }
    this.finishing.add(job.id);

    try {
      // The cached job may be stale: mc_kill and mc_cleanup change jobs.json
      // behind the monitor's back, and their status must win.
      const current = await getJob(job.id);
      if (!current || current.status !== 'running') {
        this.forgetJob(job);
        return null;
      }

      const updates: Partial<Job> = {
        status,
        completedAt: new Date().toISOString(),
        ...(failureReason ? { failureReason } : {}),
        ...extra,
      };
      await updateJob(job.id, updates);
      this.forgetJob(job);

      const finished: Job = { ...current, ...updates };
      this.emit(status === 'completed' ? 'complete' : 'failed', finished);
      return finished;
    } finally {
      this.finishing.delete(job.id);
    }
  }

  private forgetJob(job: Job): void {
    clearPendingQuestionsForJob(job.id);
    this.awaitingInputNotified.delete(job.id);
    this.unansweredPermissions.delete(job.id);
    this.backfilled.delete(job.id);
    this.shutdownInterrupted.delete(job.id);
    this.reconciledOnce.delete(job.id);
    this.awaitingTurnStart.delete(job.id);
    if (job.sessionID) {
      this.jobsBySession.delete(job.sessionID);
    }
  }

  // ---------------------------------------------------------------------------
  // Reconcile
  // ---------------------------------------------------------------------------

  private async reconcile(): Promise<void> {
    if (this.isReconciling) {
      return;
    }
    this.isReconciling = true;

    try {
      const jobs = await this.refreshJobs();
      const activeJobIds = new Set(jobs.map((job) => job.id));

      for (const id of this.awaitingInputNotified) {
        if (!activeJobIds.has(id)) {
          this.awaitingInputNotified.delete(id);
        }
      }
      for (const id of this.unansweredPermissions.keys()) {
        if (!activeJobIds.has(id)) {
          this.unansweredPermissions.delete(id);
        }
      }
      for (const id of this.backfilled) {
        if (!activeJobIds.has(id)) {
          this.backfilled.delete(id);
        }
      }
      for (const id of this.shutdownInterrupted) {
        if (!activeJobIds.has(id)) {
          this.shutdownInterrupted.delete(id);
        }
      }
      for (const id of this.reconciledOnce) {
        if (!activeJobIds.has(id)) {
          this.reconciledOnce.delete(id);
        }
      }
      for (const id of this.awaitingTurnStart.keys()) {
        if (!activeJobIds.has(id)) {
          this.awaitingTurnStart.delete(id);
        }
      }
      for (const key of this.seenPermissions) {
        if (!activeJobIds.has(key.slice(0, key.indexOf(':')))) {
          this.seenPermissions.delete(key);
        }
      }
      if ([...this.eventAccumulators.keys()].some((id) => !activeJobIds.has(id))) {
        // Activity of a finished job is kept while the job is still listed,
        // and dropped once it has been cleaned up.
        const listed = new Set((await loadJobState()).jobs.map((job) => job.id));
        for (const id of this.eventAccumulators.keys()) {
          if (!listed.has(id)) {
            this.eventAccumulators.delete(id);
          }
        }
      }

      for (const job of jobs) {
        try {
          await this.reconcileJob(job);
        } catch (error) {
          console.error(`Error checking job ${job.id}:`, error);
        }
      }
    } finally {
      this.isReconciling = false;
    }
  }

  private async reconcileJob(job: Job): Promise<void> {
    if (!job.sessionID) {
      // A running job without a session predates native sessions (or its
      // launch was interrupted): there is nothing left to monitor.
      await this.finishJob(job, 'failed', 'it has no session');
      return;
    }

    try {
      await this.reconcileJobSession(job, job.sessionID);
    } finally {
      this.reconciledOnce.add(job.id);
    }
  }

  private async reconcileJobSession(job: Job, sessionID: string): Promise<void> {
    if (!this.backfilled.has(job.id)) {
      this.backfilled.add(job.id);
      await this.backfillPendingQuestions(job, sessionID);
      await this.backfillPendingPermissions(job, sessionID);
    }

    // Unknown until the session answers: an unreadable session is neither
    // treated as finished nor as failed.
    let outcome: JobOutcome | 'unknown' = 'unknown';
    try {
      outcome = await getJobOutcome(sessionID);
    } catch (error) {
      if (isSessionMissing(error)) {
        await this.finishJob(job, 'failed', 'its session no longer exists');
        return;
      }
      // Non-fatal: the event stream can still finish the job.
      console.warn(`[Monitor] Could not read the session of job ${job.name}:`, error);
    }

    if (outcome === 'failed') {
      await this.finishJob(job, 'failed', 'its session ended with an error');
      return;
    }

    if (outcome === 'interrupted') {
      await this.handleInterruptedSession(job, sessionID);
      return;
    }

    // A report alone never finishes a job: "completed" written while the turn
    // is still running (before the final commit, say) takes effect when the
    // session goes idle, which is what `succeeded` means here.
    if (outcome === 'succeeded' && (await this.handleTurnFinished(job))) {
      return;
    }

    await this.checkAgentReport(job);
  }

  /**
   * The session is idle after an interruption. An interruption the monitor saw
   * with a reason other than "shutdown" was already handled as a failure by
   * the event; what is left is a job that was cut off by a server restart,
   * which is told once to continue.
   */
  private async handleInterruptedSession(job: Job, sessionID: string): Promise<void> {
    const current = await getJob(job.id);
    if (!current || current.status !== 'running') {
      return;
    }

    const resumedAt = current.restartResumedAt ? Date.parse(current.restartResumedAt) : 0;
    const resumedByThisMonitor = resumedAt >= this.startedAt;
    const cutOffByRestart =
      this.shutdownInterrupted.has(job.id) ||
      (!this.reconciledOnce.has(job.id) && Date.parse(job.createdAt) < this.startedAt);

    if (cutOffByRestart && !resumedByThisMonitor) {
      try {
        await promptJobSession(sessionID, RESTART_PROMPT);
      } catch (error) {
        // Try again on the next pass.
        this.shutdownInterrupted.add(job.id);
        console.warn(`[Monitor] Could not tell job ${job.name} to continue after the restart:`, error);
        return;
      }
      this.shutdownInterrupted.delete(job.id);
      this.awaitingTurnStart.set(job.id, Date.now() + this.resumeGrace);
      await updateJob(job.id, { restartResumedAt: new Date().toISOString() });
      return;
    }

    if (resumedByThisMonitor && Date.now() - resumedAt < this.resumeGrace) {
      // Told to continue a moment ago; its next turn has not started yet.
      return;
    }

    await this.finishJob(job, 'failed', 'its session was interrupted');
  }

  private async readReportSafely(job: Job): Promise<AgentReport | null> {
    try {
      return await readReport(job.id);
    } catch (error) {
      // Non-fatal: report read failures should not disrupt monitoring.
      console.warn(`[Monitor] Failed to read the report of job ${job.name}:`, error);
      return null;
    }
  }

  /**
   * Announce the job's `mc_report` file. `agent_report` and `blocked` are
   * emitted on every pass; listeners de-duplicate on the report timestamp.
   * Completion is not decided here (see `reconcileJobSession`).
   */
  private async checkAgentReport(job: Job): Promise<void> {
    const report = await this.readReportSafely(job);
    if (!report) {
      return;
    }

    this.emit('agent_report', job, report);

    if (report.status === 'blocked') {
      this.emit('blocked', job, report);
    }
  }

  // ---------------------------------------------------------------------------
  // Questions
  // ---------------------------------------------------------------------------

  private async backfillPendingQuestions(job: Job, sessionID: string): Promise<void> {
    try {
      const messages = await getRuntimeClient().session.context({ sessionID });

      for (const msg of messages) {
        if (msg.type !== 'assistant') continue;
        for (const part of msg.content) {
          if (part.type === 'tool' && part.name === 'question' && part.state.status === 'running') {
            this.handleQuestionToolUpdate(job, {
              id: part.id,
              state: { status: 'running', input: part.state.input },
            });
          }
        }
      }
    } catch (error) {
      // Non-fatal: the live event stream still delivers new questions.
      console.warn(`[Monitor] Could not load pending questions for job ${job.name}:`, error);
    }
  }

  private handleQuestionToolUpdate(job: Job, part: QuestionToolPart): void {
    const state = part.state;
    if (!state) return;

    if (state.status === 'running') {
      const input = state.input ?? {};
      const questions = (input.questions ?? []) as Array<{
        question?: string;
        header?: string;
        options?: Array<{ label: string; description?: string }>;
        multiple?: boolean;
      }>;

      if (questions.length === 0) return;
      if (!job.sessionID) return;

      const first = questions[0];
      const pending: PendingQuestion = {
        jobId: job.id,
        jobName: job.name,
        taskSummary: buildTaskSummary(job.prompt),
        partId: part.id,
        callID: part.id,
        sessionID: job.sessionID,
        question: first.question ?? '',
        options: first.options ?? [],
        header: first.header,
        multiple: first.multiple,
        detectedAt: Date.now(),
      };

      const isNew = addPendingQuestion(pending);
      if (isNew) {
        this.emit('question', job, pending);
      }
    } else if (state.status === 'completed' || state.status === 'error') {
      removePendingQuestion(job.id, part.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------

  private async backfillPendingPermissions(job: Job, sessionID: string): Promise<void> {
    try {
      const pending = await getRuntimeClient().permission.list({ sessionID });
      for (const request of pending) {
        await this.handlePermissionUpdate(job, request);
      }
    } catch (error) {
      // Non-fatal: the live event stream may still deliver the request.
      console.warn(`[Monitor] Could not load pending permissions for job ${job.name}:`, error);
    }
  }

  /**
   * Whether the job still has a permission request nobody answered. Requests
   * relayed to the user are answered outside the monitor (by the user or by the
   * relay's timeout), so the server's pending list is the authority.
   */
  private async hasUnansweredPermission(job: Job): Promise<boolean> {
    const tracked = this.unansweredPermissions.get(job.id);
    if (!tracked || tracked.size === 0 || !job.sessionID) {
      return false;
    }

    try {
      const pending = await getRuntimeClient().permission.list({ sessionID: job.sessionID });
      const pendingIds = new Set(pending.map((request) => String(request.id)));
      for (const id of tracked) {
        if (!pendingIds.has(id)) {
          tracked.delete(id);
        }
      }
    } catch (error) {
      // Keep what is tracked: treating the job as still waiting is the safe
      // reading when the server cannot confirm otherwise.
      console.warn(`[Monitor] Could not list pending permissions for job ${job.name}:`, error);
    }

    return tracked.size > 0;
  }

  private trackPermission(jobId: string, permissionId: string): void {
    let tracked = this.unansweredPermissions.get(jobId);
    if (!tracked) {
      tracked = new Set();
      this.unansweredPermissions.set(jobId, tracked);
    }
    tracked.add(permissionId);
  }

  private async handlePermissionUpdate(job: Job, data: PermissionData): Promise<void> {
    try {
      const permission = buildPermissionRequest(data, job);

      // The same request can arrive from the stream and from a backfill.
      const seenKey = `${job.id}:${permission.id}`;
      if (this.seenPermissions.has(seenKey)) {
        return;
      }
      this.seenPermissions.add(seenKey);
      this.trackPermission(job.id, permission.id);

      const accumulator = this.getOrCreateEventAccumulator(job.id);
      // The same verdict the permission gate in the job's worktree reached.
      const { decision, reason } = await decidePermission(job, data);

      if (decision === 'auto-approve') {
        await this.questionRelay.respondToPermission(job, permission.id, true, `Auto-approved by permission policy: ${reason}`);
        this.unansweredPermissions.get(job.id)?.delete(permission.id);
        return;
      }

      if (decision === 'deny') {
        await this.questionRelay.respondToPermission(job, permission.id, false, `Denied by permission policy: ${reason}`);
        this.unansweredPermissions.get(job.id)?.delete(permission.id);
        console.warn(`[Monitor] Permission denied by policy for job ${job.name}: ${permission.description}`);
        return;
      }

      // ask-user: the request stays unanswered until the user replies in the
      // job's session, or the relay's timeout denies it. Nothing is approved here.
      await this.questionRelay.handlePermissionRequest(job, permission, accumulator.currentFile);
    } catch (error) {
      console.error(`[Monitor] Failed to process permission update for job ${job.name}:`, error);
    }
  }

  // ---------------------------------------------------------------------------
  // Activity
  // ---------------------------------------------------------------------------

  private getOrCreateEventAccumulator(jobId: string): EventAccumulator {
    let accumulator = this.eventAccumulators.get(jobId);
    if (!accumulator) {
      accumulator = {
        filesEdited: [],
        lastActivityAt: Date.now(),
        eventCount: 0,
      };
      this.eventAccumulators.set(jobId, accumulator);
    }
    return accumulator;
  }

  private updateEventAccumulator(
    jobId: string,
    updates: Partial<Omit<EventAccumulator, 'eventCount'>>,
  ): void {
    const accumulator = this.getOrCreateEventAccumulator(jobId);
    accumulator.eventCount++;
    accumulator.lastActivityAt = Date.now();
    let visibleChange = false;

    if (updates.currentTool !== undefined) {
      visibleChange ||= accumulator.currentTool !== updates.currentTool;
      accumulator.currentTool = updates.currentTool;
    }
    if (updates.currentFile !== undefined) {
      visibleChange ||= accumulator.currentFile !== updates.currentFile;
      accumulator.currentFile = updates.currentFile;
    }
    if (updates.filesEdited !== undefined) {
      for (const file of updates.filesEdited) {
        if (!accumulator.filesEdited.includes(file)) {
          visibleChange = true;
          accumulator.filesEdited.push(file);
          if (accumulator.filesEdited.length > MAX_EVENTS_PER_JOB) {
            accumulator.filesEdited.shift();
          }
        }
      }
    }

    // Clients show each job's current tool and file; refresh them when those
    // change (debounced, and a no-op when nothing is connected).
    if (visibleChange) {
      emitChanged('activity');
    }
  }
}
