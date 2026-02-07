import { EventEmitter } from 'events';
import { getRunningJobs, updateJob, type Job } from './job-state.js';
import { isPaneRunning, capturePane, captureExitStatus } from './tmux.js';
import { loadConfig } from './config.js';
import { readReport, type AgentReport } from './reports.js';

type JobEventType = 'complete' | 'failed' | 'blocked' | 'needs_review' | 'agent_report';
type JobEventHandler = (job: Job) => void;

interface IdleTracker {
  lastOutputHash: string;
  lastChangedAt: number;
}

export interface JobMonitorOptions {
  pollInterval?: number;
  idleThreshold?: number;
}

function hashOutput(output: string): string {
  return Bun.hash(output).toString(36);
}

type SessionState = 'idle' | 'streaming' | 'unknown';

function detectSessionState(output: string): SessionState {
  const lines = output.split('\n');
  const bottomChunk = lines.slice(-10).join('\n');

  if (bottomChunk.includes('⬝') || bottomChunk.includes('esc interrupt')) {
    return 'streaming';
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

  private explicitIdleThreshold: boolean;

  constructor(options: JobMonitorOptions = {}) {
    super();
    this.pollInterval = options.pollInterval ?? 10000;
    this.idleThreshold = options.idleThreshold ?? 300000;
    this.explicitIdleThreshold = options.idleThreshold !== undefined;

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

  private async checkAgentReport(job: Job): Promise<void> {
    try {
      const report = await readReport(job.id);
      if (!report) {
        return;
      }

      this.emit('agent_report', job, report);

      if (report.status === 'blocked') {
        this.emit('blocked', job, report);
      } else if (report.status === 'needs_review') {
        this.emit('needs_review', job, report);
      }
    } catch {
      // Non-fatal: report read failures should not disrupt monitoring
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

     for (const job of jobs) {
       try {
         const isRunning = await isPaneRunning(job.tmuxTarget);

         if (!isRunning) {
           this.idleTrackers.delete(job.id);
           const now = new Date().toISOString();
           
           // Check exit status to determine success vs failure
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

        const output = await capturePane(job.tmuxTarget, 50);
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

        if (now - tracker.lastChangedAt >= this.idleThreshold) {
          const state = detectSessionState(output);
          if (state !== 'idle') {
            continue;
          }
          this.idleTrackers.delete(job.id);
          const completedAt = new Date().toISOString();
          await updateJob(job.id, { status: 'completed', completedAt });
          this.emit('complete', { ...job, status: 'completed', completedAt });
        }

        await this.checkAgentReport(job);
      } catch (error) {
        console.error(`Error checking job ${job.id}:`, error);
      }
    }
  }
}
