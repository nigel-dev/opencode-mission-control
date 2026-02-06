import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupNotifications, teardownNotifications, type JobMonitor } from '../../src/hooks/notifications';
import type { Job } from '../../src/lib/job-state';

describe('notifications hook', () => {
  let consoleSpy: any;
  let mockMonitor: JobMonitor & { handlers: Map<string, ((job: Job) => void)[]> };

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mockMonitor = {
      handlers: new Map(),
      on(event: 'complete' | 'failed', handler: (job: Job) => void) {
        if (!this.handlers.has(event)) {
          this.handlers.set(event, []);
        }
        this.handlers.get(event)!.push(handler);
      },
      off(event: 'complete' | 'failed', handler: (job: Job) => void) {
        if (this.handlers.has(event)) {
          const handlers = this.handlers.get(event)!;
          const index = handlers.indexOf(handler);
          if (index > -1) {
            handlers.splice(index, 1);
          }
        }
      },
    };
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should set up notification handlers', () => {
    setupNotifications(mockMonitor);

    expect(mockMonitor.handlers.has('complete')).toBe(true);
    expect(mockMonitor.handlers.has('failed')).toBe(true);
    expect(mockMonitor.handlers.get('complete')).toHaveLength(1);
    expect(mockMonitor.handlers.get('failed')).toHaveLength(1);
  });

  it('should show notification on job completion', () => {
    setupNotifications(mockMonitor);

    const job: Job = {
      id: 'job-1',
      name: 'feature-auth',
      worktreePath: '/path/to/worktree',
      branch: 'mc/feature-auth',
      tmuxTarget: 'mc-feature-auth',
      placement: 'session',
      status: 'completed',
      prompt: 'Add OAuth support',
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    const handlers = mockMonitor.handlers.get('complete')!;
    handlers[0](job);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("✓ Job 'feature-auth' completed successfully")
    );
  });

  it('should show notification on job failure with exit code', () => {
    setupNotifications(mockMonitor);

    const job: Job = {
      id: 'job-2',
      name: 'fix-bug-123',
      worktreePath: '/path/to/worktree',
      branch: 'mc/fix-bug-123',
      tmuxTarget: 'mc-fix-bug-123',
      placement: 'window',
      status: 'failed',
      prompt: 'Fix login redirect',
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 1,
    };

    const handlers = mockMonitor.handlers.get('failed')!;
    handlers[0](job);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("✗ Job 'fix-bug-123' failed (exit code 1)")
    );
  });

  it('should show notification on job failure with unknown exit code', () => {
    setupNotifications(mockMonitor);

    const job: Job = {
      id: 'job-3',
      name: 'refactor-api',
      worktreePath: '/path/to/worktree',
      branch: 'mc/refactor-api',
      tmuxTarget: 'mc-refactor-api',
      placement: 'session',
      status: 'failed',
      prompt: 'Refactor API endpoints',
      mode: 'plan',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    const handlers = mockMonitor.handlers.get('failed')!;
    handlers[0](job);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("✗ Job 'refactor-api' failed (exit code unknown)")
    );
  });

  it('should teardown notification handlers', () => {
    setupNotifications(mockMonitor);

    const completeHandlers = mockMonitor.handlers.get('complete')!;
    const failedHandlers = mockMonitor.handlers.get('failed')!;
    const completeHandler = completeHandlers[0];
    const failedHandler = failedHandlers[0];

    teardownNotifications(mockMonitor, completeHandler, failedHandler);

    expect(mockMonitor.handlers.get('complete')).toHaveLength(0);
    expect(mockMonitor.handlers.get('failed')).toHaveLength(0);
  });

  it('should handle multiple notifications in sequence', () => {
    setupNotifications(mockMonitor);

    const job1: Job = {
      id: 'job-1',
      name: 'task-1',
      worktreePath: '/path/to/worktree1',
      branch: 'mc/task-1',
      tmuxTarget: 'mc-task-1',
      placement: 'session',
      status: 'completed',
      prompt: 'Task 1',
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    const job2: Job = {
      id: 'job-2',
      name: 'task-2',
      worktreePath: '/path/to/worktree2',
      branch: 'mc/task-2',
      tmuxTarget: 'mc-task-2',
      placement: 'session',
      status: 'failed',
      prompt: 'Task 2',
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 127,
    };

    const completeHandlers = mockMonitor.handlers.get('complete')!;
    const failedHandlers = mockMonitor.handlers.get('failed')!;

    completeHandlers[0](job1);
    failedHandlers[0](job2);

    expect(consoleSpy).toHaveBeenCalledTimes(2);
    expect(consoleSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("✓ Job 'task-1' completed successfully")
    );
    expect(consoleSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("✗ Job 'task-2' failed (exit code 127)")
    );
  });
});
