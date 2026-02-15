import { EventEmitter } from 'events';
import { getRunningJobs, updateJob, type Job } from './job-state.js';
import { isPaneRunning, capturePane, captureExitStatus } from './tmux.js';
import { loadConfig } from './config.js';
import { readReport, type AgentReport } from './reports.js';
import { createJobClient } from './sdk-client.js';
import { QuestionRelay, type PermissionRequest } from './question-relay.js';
import type { OpencodeClient } from '@opencode-ai/sdk';

type JobEventType = 'complete' | 'failed' | 'blocked' | 'needs_review' | 'awaiting_input' | 'agent_report';
type JobEventHandler = (job: Job) => void;

interface IdleTracker {
  lastOutputHash: string;
  lastChangedAt: number;
}

interface EventAccumulator {
  filesEdited: string[];
  currentTool?: string;
  lastActivityAt: number;
  eventCount: number;
  currentFile?: string;
}

interface SSESubscription {
  abortController: AbortController;
  client: OpencodeClient;
  reconnectAttempts: number;
}

const MAX_EVENTS_PER_JOB = 100;
const SSE_INITIAL_BACKOFF_MS = 100;
const SSE_MAX_BACKOFF_MS = 30000;
const SSE_BACKOFF_FACTOR = 2;

export interface JobMonitorOptions {
  pollInterval?: number;
  idleThreshold?: number;
}

function hashOutput(output: string): string {
  return Bun.hash(output).toString(36);
}

type SessionState = 'idle' | 'streaming' | 'awaiting_input' | 'unknown';

function detectSessionState(output: string): SessionState {
  const lines = output.split('\n');
  const bottomChunk = lines.slice(-10).join('\n');

  if (bottomChunk.includes('⬝') || bottomChunk.includes('esc interrupt')) {
    return 'streaming';
  }

  const isQuestionPrompt = bottomChunk.includes('↑↓ select') || bottomChunk.includes('enter submit') || bottomChunk.includes('esc dismiss');
  if (isQuestionPrompt) {
    return 'awaiting_input';
  }

  if (bottomChunk.includes('ctrl+p commands')) {
    return 'idle';
  }

  return 'unknown';
}

export class JobMonitor extends EventEmitter {
  private pollInterval: number;
  private idleThreshold: number;
  private intervalId?: Timer;
  private isRunning = false;
  private idleTrackers: Map<string, IdleTracker> = new Map();
  private awaitingInputNotified: Set<string> = new Set();
  private eventAccumulators: Map<string, EventAccumulator> = new Map();
  private sseSubscriptions: Map<string, SSESubscription> = new Map();
  private questionRelay: QuestionRelay;

  private explicitIdleThreshold: boolean;

  constructor(options: JobMonitorOptions = {}) {
    super();
    this.pollInterval = options.pollInterval ?? 10000;
    this.idleThreshold = options.idleThreshold ?? 300000;
    this.explicitIdleThreshold = options.idleThreshold !== undefined;
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
    if (!this.explicitIdleThreshold) {
      this.loadIdleThreshold();
    }
    this.intervalId = setInterval(() => {
      this.poll().catch((error) => {
        console.error('Error during job monitoring poll:', error);
      });
    }, this.pollInterval);

    this.poll().catch((error) => {
      console.error('Error during initial job monitoring poll:', error);
    });
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.idleTrackers.clear();
    this.awaitingInputNotified.clear();
    this.cleanupSSESubscriptions();
    this.questionRelay.dispose();
  }

  private cleanupSSESubscriptions(): void {
    for (const [jobId, subscription] of this.sseSubscriptions) {
      subscription.abortController.abort();
      this.sseSubscriptions.delete(jobId);
      this.questionRelay.cleanup(jobId);
    }
  }

  private cleanupSSEForJob(jobId: string): void {
    const subscription = this.sseSubscriptions.get(jobId);
    if (subscription) {
      subscription.abortController.abort();
      this.sseSubscriptions.delete(jobId);
      this.questionRelay.cleanup(jobId);
    }
  }

  on(event: JobEventType, handler: JobEventHandler): this {
    return super.on(event, handler);
  }

  private async loadIdleThreshold(): Promise<void> {
    try {
      const config = await loadConfig();
      this.idleThreshold = config.idleThreshold;
    } catch {}
  }

  private getOrCreateEventAccumulator(jobId: string): EventAccumulator {
    if (!this.eventAccumulators.has(jobId)) {
      this.eventAccumulators.set(jobId, {
        filesEdited: [],
        lastActivityAt: Date.now(),
        eventCount: 0,
      });
    }
    return this.eventAccumulators.get(jobId)!;
  }

  private updateEventAccumulator(
    jobId: string,
    updates: Partial<Omit<EventAccumulator, 'eventCount'>>,
  ): void {
    const accumulator = this.getOrCreateEventAccumulator(jobId);
    accumulator.eventCount++;
    accumulator.lastActivityAt = Date.now();

    if (updates.currentTool !== undefined) {
      accumulator.currentTool = updates.currentTool;
    }
    if (updates.currentFile !== undefined) {
      accumulator.currentFile = updates.currentFile;
    }
    if (updates.filesEdited !== undefined) {
      for (const file of updates.filesEdited) {
        if (!accumulator.filesEdited.includes(file)) {
          accumulator.filesEdited.push(file);
          if (accumulator.filesEdited.length > MAX_EVENTS_PER_JOB) {
            accumulator.filesEdited.shift();
          }
        }
      }
    }
  }

  private async subscribeToSSE(job: Job): Promise<void> {
    if (!job.port) {
      return;
    }

    if (this.sseSubscriptions.has(job.id)) {
      return;
    }

    const abortController = new AbortController();
    const client = createJobClient(job.port);

    this.sseSubscriptions.set(job.id, {
      abortController,
      client,
      reconnectAttempts: 0,
    });

    this.processSSEStream(job, client, abortController).catch((error) => {
      console.error(`[Monitor] SSE stream error for job ${job.name}:`, error);
    });
  }

  private async processSSEStream(
    job: Job,
    client: OpencodeClient,
    abortController: AbortController,
  ): Promise<void> {
    while (this.isRunning && !abortController.signal.aborted) {
      try {
        const subscription = this.sseSubscriptions.get(job.id);
        if (subscription) {
          subscription.reconnectAttempts = 0;
        }

        const events = await client.event.subscribe();

        for await (const event of events.stream) {
          if (abortController.signal.aborted) {
            break;
          }

          await this.handleSSEEvent(job, event);
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          break;
        }

        const subscription = this.sseSubscriptions.get(job.id);
        const reconnectAttempts = subscription?.reconnectAttempts ?? 0;
        const backoffMs = Math.min(
          SSE_INITIAL_BACKOFF_MS * Math.pow(SSE_BACKOFF_FACTOR, reconnectAttempts),
          SSE_MAX_BACKOFF_MS,
        );

        if (subscription) {
          subscription.reconnectAttempts = reconnectAttempts + 1;
        }

        console.warn(
          `[Monitor] SSE connection lost for job ${job.name}, reconnecting in ${backoffMs}ms (attempt ${reconnectAttempts + 1})`,
        );

        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  private async handleSSEEvent(job: Job, event: any): Promise<void> {
    const eventType = event.type || event.event;

    switch (eventType) {
      case 'session.status':
      case 'session.idle': {
        const now = new Date().toISOString();
        this.cleanupSSEForJob(job.id);
        await updateJob(job.id, { status: 'completed', completedAt: now });
        this.emit('complete', { ...job, status: 'completed', completedAt: now });
        break;
      }

      case 'session.error': {
        const now = new Date().toISOString();
        this.cleanupSSEForJob(job.id);
        await updateJob(job.id, { status: 'failed', completedAt: now });
        this.emit('failed', { ...job, status: 'failed', completedAt: now });
        break;
      }

      case 'message.part.updated': {
        this.updateEventAccumulator(job.id, { currentTool: 'streaming' });
        break;
      }

      case 'file.edited': {
        const filePath = event.properties?.path || event.path;
        if (filePath) {
          this.updateEventAccumulator(job.id, {
            filesEdited: [filePath],
            currentFile: filePath,
          });
        }
        break;
      }

      case 'permission.updated': {
        const permission: PermissionRequest = {
          id: event.properties?.id || event.id || 'unknown',
          type: this.inferPermissionType(event),
          path: event.properties?.path || event.path,
          description: event.properties?.description || event.description || 'Unknown permission request',
        };

        const accumulator = this.getOrCreateEventAccumulator(job.id);
        await this.questionRelay.handlePermissionRequest(job, permission, accumulator.currentFile);
        break;
      }
    }
  }

  private inferPermissionType(event: any): PermissionRequest['type'] {
    const eventData = event.properties || event;
    const typeHint = eventData.type || eventData.permissionType || '';

    if (typeHint.includes('file') || typeHint.includes('write') || typeHint.includes('edit')) {
      return 'file_operation';
    }
    if (typeHint.includes('shell') || typeHint.includes('command') || typeHint.includes('exec')) {
      return 'shell_command';
    }
    if (typeHint.includes('network') || typeHint.includes('http') || typeHint.includes('fetch')) {
      return 'network';
    }
    if (typeHint.includes('mcp') || typeHint.includes('tool')) {
      return 'mcp';
    }

    return 'other';
  }

  private isServeModeJob(job: Job): boolean {
    return job.port !== undefined && job.port > 0;
  }

  private async checkAgentReport(job: Job): Promise<boolean> {
    try {
      const report = await readReport(job.id);
      if (!report) {
        return false;
      }

      this.emit('agent_report', job, report);

      if (report.status === 'completed' || report.status === 'needs_review') {
        // Agent explicitly signaled completion — mark job done immediately
        const now = new Date().toISOString();
        this.idleTrackers.delete(job.id);
        await updateJob(job.id, { status: 'completed', completedAt: now });
        this.emit('complete', { ...job, status: 'completed', completedAt: now });
        if (report.status === 'needs_review') {
          this.emit('needs_review', { ...job, status: 'completed', completedAt: now }, report);
        }
        return true;
      } else if (report.status === 'blocked') {
        this.emit('blocked', job, report);
      }

      return false;
    } catch {
      // Non-fatal: report read failures should not disrupt monitoring
      return false;
    }
  }

  private async poll(): Promise<void> {
    const jobs = await getRunningJobs();
    const activeJobIds = new Set(jobs.map(j => j.id));

    for (const [id] of this.idleTrackers) {
      if (!activeJobIds.has(id)) {
        this.idleTrackers.delete(id);
      }
    }
    for (const id of this.awaitingInputNotified) {
      if (!activeJobIds.has(id)) {
        this.awaitingInputNotified.delete(id);
      }
    }

    for (const job of jobs) {
      try {
        if (this.isServeModeJob(job)) {
          await this.subscribeToSSE(job);
          continue;
        }

        let isRunning: boolean;
        try {
          isRunning = await isPaneRunning(job.tmuxTarget);
        } catch (paneError) {
          console.warn(
            `tmux error checking job ${job.id}, skipping this poll cycle:`,
            paneError instanceof Error ? paneError.message : paneError,
          );
          continue;
        }

        if (!isRunning) {
          this.idleTrackers.delete(job.id);
          this.awaitingInputNotified.delete(job.id);
          const now = new Date().toISOString();

          const exitCode = await captureExitStatus(job.tmuxTarget);
          const isFailed = exitCode !== undefined && exitCode !== 0;

          if (isFailed) {
            await updateJob(job.id, { status: 'failed', completedAt: now });
            this.emit('failed', { ...job, status: 'failed', completedAt: now });
          } else {
            await updateJob(job.id, { status: 'completed', completedAt: now });
            this.emit('complete', { ...job, status: 'completed', completedAt: now });
          }
          continue;
        }

        const reportHandled = await this.checkAgentReport(job);
        if (reportHandled) continue;

        const output = await capturePane(job.tmuxTarget, 50);
        const state = detectSessionState(output);

        if (state === 'awaiting_input' && !this.awaitingInputNotified.has(job.id)) {
          this.awaitingInputNotified.add(job.id);
          this.emit('awaiting_input', job);
        }

        const currentHash = hashOutput(output);
        const now = Date.now();
        const tracker = this.idleTrackers.get(job.id);

        if (!tracker) {
          this.idleTrackers.set(job.id, { lastOutputHash: currentHash, lastChangedAt: now });
          continue;
        }

        if (currentHash !== tracker.lastOutputHash) {
          tracker.lastOutputHash = currentHash;
          tracker.lastChangedAt = now;
          continue;
        }

        if (now - tracker.lastChangedAt >= this.idleThreshold && state === 'idle') {
          this.idleTrackers.delete(job.id);
          this.awaitingInputNotified.delete(job.id);
          const completedAt = new Date().toISOString();
          await updateJob(job.id, { status: 'completed', completedAt });
          this.emit('complete', { ...job, status: 'completed', completedAt });
        }
      } catch (error) {
        console.error(`Error checking job ${job.id}:`, error);
      }
    }
  }

  getEventAccumulator(jobId: string): EventAccumulator | undefined {
    return this.eventAccumulators.get(jobId);
  }
}
