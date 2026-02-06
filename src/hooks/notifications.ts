import type { Job } from '../lib/job-state';

/**
 * JobMonitor interface for event-based job monitoring
 * This will be implemented in src/lib/monitor.ts
 */
export interface JobMonitor {
  on(event: 'complete' | 'failed', handler: (job: Job) => void): void;
  off?(event: 'complete' | 'failed', handler: (job: Job) => void): void;
}

/**
 * Set up toast notifications for job completion and failure events
 * Subscribes to monitor events and displays notifications in the terminal
 *
 * @param monitor - JobMonitor instance to subscribe to
 */
export function setupNotifications(monitor: JobMonitor): void {
  // Handle job completion
  monitor.on('complete', (job: Job) => {
    const message = `✓ Job '${job.name}' completed successfully`;
    console.log(`\n${message}\n`);
  });

  // Handle job failure
  monitor.on('failed', (job: Job) => {
    const exitCode = job.exitCode ?? 'unknown';
    const message = `✗ Job '${job.name}' failed (exit code ${exitCode})`;
    console.log(`\n${message}\n`);
  });
}

/**
 * Tear down notifications by unsubscribing from monitor events
 * Optional cleanup function for when notifications are no longer needed
 *
 * @param monitor - JobMonitor instance to unsubscribe from
 * @param completeHandler - The complete event handler to remove
 * @param failedHandler - The failed event handler to remove
 */
export function teardownNotifications(
  monitor: JobMonitor,
  completeHandler: (job: Job) => void,
  failedHandler: (job: Job) => void
): void {
  if (monitor.off) {
    monitor.off('complete', completeHandler);
    monitor.off('failed', failedHandler);
  }
}
