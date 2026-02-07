import { EventEmitter } from 'events';
import { getRunningJobs, updateJob, type Job } from './job-state.js';
import { isPaneRunning } from './tmux.js';

type JobEventType = 'complete' | 'failed';
type JobEventHandler = (job: Job) => void;

export interface JobMonitorOptions {
  pollInterval?: number; // milliseconds, default 10000 (10s)
}

/**
 * JobMonitor watches running jobs and emits events when they complete or fail.
 * Uses hybrid monitoring: tmux hooks + polling every 10s (configurable).
 */
export class JobMonitor extends EventEmitter {
  private pollInterval: number;
  private intervalId?: Timer;
  private isRunning = false;

  constructor(options: JobMonitorOptions = {}) {
    super();
    this.pollInterval = options.pollInterval ?? 10000; // Default 10s

    const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
    if (this.pollInterval < 10000 && !isTest) {
      throw new Error('Poll interval must be at least 10000ms (10s)');
    }
  }

  /**
   * Start monitoring jobs
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.intervalId = setInterval(() => {
      this.poll().catch((error) => {
        console.error('Error during job monitoring poll:', error);
      });
    }, this.pollInterval);

    // Run initial poll immediately
    this.poll().catch((error) => {
      console.error('Error during initial job monitoring poll:', error);
    });
  }

  /**
   * Stop monitoring jobs
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  /**
   * Subscribe to job events
   */
  on(event: JobEventType, handler: JobEventHandler): this {
    return super.on(event, handler);
  }

  /**
   * Poll running jobs and check their status
   */
  private async poll(): Promise<void> {
    const jobs = await getRunningJobs();

    for (const job of jobs) {
      try {
        const isRunning = await isPaneRunning(job.tmuxTarget);

        if (!isRunning) {
          // Pane died - job completed
          const now = new Date().toISOString();
          
          // Determine if job failed or completed successfully
          // For now, we assume completion. Exit code detection would require
          // additional tmux hooks or shell integration.
          const status = 'completed';
          
          await updateJob(job.id, {
            status,
            completedAt: now,
          });

          // Emit appropriate event
          const updatedJob = { ...job, status, completedAt: now };
          if (status === 'completed') {
            this.emit('complete', updatedJob);
          } else {
            this.emit('failed', updatedJob);
          }
        }
      } catch (error) {
        console.error(`Error checking job ${job.id}:`, error);
      }
    }
  }
}
