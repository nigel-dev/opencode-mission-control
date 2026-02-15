import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setupNotifications,
  annotateSessionTitle,
  resetSessionTitle,
  hasAnnotation,
  _getTitleStateForTesting,
} from '../../src/hooks/notifications';
import type { Job } from '../../src/lib/job-state';

vi.mock('../../src/lib/reports', () => ({
  readReport: vi.fn().mockResolvedValue(null),
}));

describe('notifications hook', () => {
  let mockMonitor: {
    handlers: Map<string, ((job: Job) => void)[]>;
    on(event: string, handler: (job: Job) => void): void;
  };
  let mockClient: {
    session: {
      prompt: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let mockGetActiveSessionID: ReturnType<typeof vi.fn>;
  let mockIsSubagent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _getTitleStateForTesting().clear();

    mockMonitor = {
      handlers: new Map(),
      on(event: string, handler: (job: Job) => void) {
        if (!this.handlers.has(event)) {
          this.handlers.set(event, []);
        }
        this.handlers.get(event)!.push(handler);
      },
    };

    mockClient = {
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue({ data: { title: 'Original Title' } }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };

    mockGetActiveSessionID = vi.fn().mockResolvedValue('session-123');
    mockIsSubagent = vi.fn().mockResolvedValue(false);
  });

  it('should set up notification handlers for all events', () => {
    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
      isSubagent: mockIsSubagent as any,
    });

    expect(mockMonitor.handlers.has('complete')).toBe(true);
    expect(mockMonitor.handlers.has('failed')).toBe(true);
    expect(mockMonitor.handlers.has('blocked')).toBe(true);
    expect(mockMonitor.handlers.has('needs_review')).toBe(true);
    expect(mockMonitor.handlers.get('complete')).toHaveLength(1);
    expect(mockMonitor.handlers.get('failed')).toHaveLength(1);
    expect(mockMonitor.handlers.get('blocked')).toHaveLength(1);
    expect(mockMonitor.handlers.get('needs_review')).toHaveLength(1);
  });

  it('should send notification on job completion', async () => {
    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
      isSubagent: mockIsSubagent as any,
    });

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

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockClient.session.prompt).toHaveBeenCalled();
    const callArgs = mockClient.session.prompt.mock.calls[0][0];
    expect(callArgs.body.parts[0].text).toContain("🟢 Job 'feature-auth' completed");
    expect(callArgs.body.parts[0].text).toContain('mc/feature-auth');
  });

  it('should send notification on job failure', async () => {
    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
      isSubagent: mockIsSubagent as any,
    });

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

    // Give async handler time to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockClient.session.prompt).toHaveBeenCalled();
    const callArgs = mockClient.session.prompt.mock.calls[0][0];
    expect(callArgs.body.parts[0].text).toContain("🔴 Job 'fix-bug-123' failed");
    expect(callArgs.body.parts[0].text).toContain('mc/fix-bug-123');
  });

  it('should deduplicate notifications for the same job event', async () => {
    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
      isSubagent: mockIsSubagent as any,
    });

    const completedAt = new Date().toISOString();
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
      completedAt,
    };

    const handlers = mockMonitor.handlers.get('complete')!;
    handlers[0](job);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const firstCallCount = mockClient.session.prompt.mock.calls.length;

    handlers[0](job);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondCallCount = mockClient.session.prompt.mock.calls.length;

    expect(firstCallCount).toBe(1);
    expect(secondCallCount).toBe(1);
  });

  it('should not send notification if no active session', async () => {
    mockGetActiveSessionID.mockResolvedValue(undefined);

    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
      isSubagent: mockIsSubagent as any,
    });

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

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockClient.session.prompt).not.toHaveBeenCalled();
  });

  it('should send notification on blocked event', async () => {
    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
      isSubagent: mockIsSubagent as any,
    });

    const job: Job = {
      id: 'job-3',
      name: 'blocked-task',
      worktreePath: '/path/to/worktree',
      branch: 'mc/blocked-task',
      tmuxTarget: 'mc-blocked-task',
      placement: 'session',
      status: 'completed',
      prompt: 'Some task',
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
    };

    const handlers = mockMonitor.handlers.get('blocked')!;
    handlers[0](job);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockClient.session.prompt).toHaveBeenCalled();
    const callArgs = mockClient.session.prompt.mock.calls[0][0];
    expect(callArgs.body.parts[0].text).toContain("⚠️ Job 'blocked-task' is blocked");
  });

  it('should send notification on needs_review event', async () => {
    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
      isSubagent: mockIsSubagent as any,
    });

    const job: Job = {
      id: 'job-4',
      name: 'review-task',
      worktreePath: '/path/to/worktree',
      branch: 'mc/review-task',
      tmuxTarget: 'mc-review-task',
      placement: 'session',
      status: 'completed',
      prompt: 'Some task',
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
    };

    const handlers = mockMonitor.handlers.get('needs_review')!;
    handlers[0](job);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockClient.session.prompt).toHaveBeenCalled();
    const callArgs = mockClient.session.prompt.mock.calls[0][0];
    expect(callArgs.body.parts[0].text).toContain("👀 Job 'review-task' needs review");
  });

  it('should route notification to launchSessionID when present', async () => {
    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
      isSubagent: mockIsSubagent as any,
    });

    const job: Job = {
      id: 'job-5',
      name: 'routed-job',
      worktreePath: '/path/to/worktree',
      branch: 'mc/routed-job',
      tmuxTarget: 'mc-routed-job',
      placement: 'session',
      status: 'completed',
      prompt: 'Some task',
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      launchSessionID: 'ses_launch_abc',
    };

    const handlers = mockMonitor.handlers.get('complete')!;
    handlers[0](job);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockClient.session.prompt).toHaveBeenCalled();
    const callArgs = mockClient.session.prompt.mock.calls[0][0];
    expect(callArgs.path.id).toBe('ses_launch_abc');
    expect(callArgs.body.parts[0].text).toContain("🟢 Job 'routed-job' completed");
  });

  it('should fallback to activeSessionID when launchSessionID is undefined', async () => {
    mockGetActiveSessionID.mockResolvedValue('ses_active_456');

    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
      isSubagent: mockIsSubagent as any,
    });

    const job: Job = {
      id: 'job-6',
      name: 'fallback-job',
      worktreePath: '/path/to/worktree',
      branch: 'mc/fallback-job',
      tmuxTarget: 'mc-fallback-job',
      placement: 'session',
      status: 'completed',
      prompt: 'Some task',
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    const handlers = mockMonitor.handlers.get('complete')!;
    handlers[0](job);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockClient.session.prompt).toHaveBeenCalled();
    const callArgs = mockClient.session.prompt.mock.calls[0][0];
    expect(callArgs.path.id).toBe('ses_active_456');
  });

  it('should not send notification when launchSessionID is invalid', async () => {
    mockGetActiveSessionID.mockResolvedValue(undefined);

    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
      isSubagent: mockIsSubagent as any,
    });

    const job: Job = {
      id: 'job-7',
      name: 'invalid-session-job',
      worktreePath: '/path/to/worktree',
      branch: 'mc/invalid-session-job',
      tmuxTarget: 'mc-invalid-session-job',
      placement: 'session',
      status: 'completed',
      prompt: 'Some task',
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      launchSessionID: 'not-a-valid-session',
    };

    const handlers = mockMonitor.handlers.get('complete')!;
    handlers[0](job);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockClient.session.prompt).not.toHaveBeenCalled();

  });

  describe('title annotations', () => {
    it('should annotate session title on job completion', async () => {
      setupNotifications({
        client: mockClient as any,
        monitor: mockMonitor as any,
        getActiveSessionID: mockGetActiveSessionID as any,
        isSubagent: mockIsSubagent as any,
      });

      const job: Job = {
        id: 'job-t1',
        name: 'feature-auth',
        worktreePath: '/path/to/worktree',
        branch: 'mc/feature-auth',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'completed',
        prompt: 'Add OAuth',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        launchSessionID: 'ses_launcher',
      };

      mockMonitor.handlers.get('complete')![0](job);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockClient.session.update).toHaveBeenCalledWith({
        path: { id: 'ses_launcher' },
        body: { title: 'feature-auth done' },
      });
    });

    it('should annotate session title on job failure', async () => {
      setupNotifications({
        client: mockClient as any,
        monitor: mockMonitor as any,
        getActiveSessionID: mockGetActiveSessionID as any,
        isSubagent: mockIsSubagent as any,
      });

      const job: Job = {
        id: 'job-t2',
        name: 'fix-bug',
        worktreePath: '/path/to/worktree',
        branch: 'mc/fix-bug',
        tmuxTarget: 'mc-fix-bug',
        placement: 'session',
        status: 'failed',
        prompt: 'Fix bug',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        launchSessionID: 'ses_launcher',
      };

      mockMonitor.handlers.get('failed')![0](job);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockClient.session.update).toHaveBeenCalledWith({
        path: { id: 'ses_launcher' },
        body: { title: 'fix-bug failed' },
      });
    });

    it('should annotate session title on awaiting_input', async () => {
      setupNotifications({
        client: mockClient as any,
        monitor: mockMonitor as any,
        getActiveSessionID: mockGetActiveSessionID as any,
        isSubagent: mockIsSubagent as any,
      });

      const job: Job = {
        id: 'job-t3',
        name: 'setup-db',
        worktreePath: '/path/to/worktree',
        branch: 'mc/setup-db',
        tmuxTarget: 'mc-setup-db',
        placement: 'session',
        status: 'running',
        prompt: 'Setup DB',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
        launchSessionID: 'ses_launcher',
      };

      mockMonitor.handlers.get('awaiting_input')![0](job);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockClient.session.update).toHaveBeenCalledWith({
        path: { id: 'ses_launcher' },
        body: { title: 'setup-db needs input' },
      });
    });

    it('should aggregate multiple annotations as "N jobs need attention"', async () => {
      setupNotifications({
        client: mockClient as any,
        monitor: mockMonitor as any,
        getActiveSessionID: mockGetActiveSessionID as any,
        isSubagent: mockIsSubagent as any,
      });

      const job1: Job = {
        id: 'job-t4',
        name: 'job-a',
        worktreePath: '/path/a',
        branch: 'mc/job-a',
        tmuxTarget: 'mc-job-a',
        placement: 'session',
        status: 'completed',
        prompt: 'Task A',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        launchSessionID: 'ses_launcher',
      };

      const job2: Job = {
        id: 'job-t5',
        name: 'job-b',
        worktreePath: '/path/b',
        branch: 'mc/job-b',
        tmuxTarget: 'mc-job-b',
        placement: 'session',
        status: 'failed',
        prompt: 'Task B',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        launchSessionID: 'ses_launcher',
      };

      mockMonitor.handlers.get('complete')![0](job1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      mockMonitor.handlers.get('failed')![0](job2);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const calls = mockClient.session.update.mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall).toEqual({
        path: { id: 'ses_launcher' },
        body: { title: '2 jobs need attention' },
      });
    });

    it('should not annotate title for blocked events', async () => {
      setupNotifications({
        client: mockClient as any,
        monitor: mockMonitor as any,
        getActiveSessionID: mockGetActiveSessionID as any,
        isSubagent: mockIsSubagent as any,
      });

      const job: Job = {
        id: 'job-t6',
        name: 'blocked-job',
        worktreePath: '/path/to/worktree',
        branch: 'mc/blocked-job',
        tmuxTarget: 'mc-blocked-job',
        placement: 'session',
        status: 'completed',
        prompt: 'Some task',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
        launchSessionID: 'ses_launcher',
      };

      mockMonitor.handlers.get('blocked')![0](job);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockClient.session.update).not.toHaveBeenCalled();
    });

    it('should not annotate title when sessionID is undefined', async () => {
      mockGetActiveSessionID.mockResolvedValue(undefined);

      setupNotifications({
        client: mockClient as any,
        monitor: mockMonitor as any,
        getActiveSessionID: mockGetActiveSessionID as any,
        isSubagent: mockIsSubagent as any,
      });

      const job: Job = {
        id: 'job-t7',
        name: 'no-session-job',
        worktreePath: '/path/to/worktree',
        branch: 'mc/no-session-job',
        tmuxTarget: 'mc-no-session-job',
        placement: 'session',
        status: 'completed',
        prompt: 'Task',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      mockMonitor.handlers.get('complete')![0](job);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockClient.session.update).not.toHaveBeenCalled();
    });

    it('should fetch original title only once per session', async () => {
      await annotateSessionTitle(mockClient as any, 'ses_test', 'job-a', 'done');
      await annotateSessionTitle(mockClient as any, 'ses_test', 'job-b', 'failed');

      expect(mockClient.session.get).toHaveBeenCalledTimes(1);
      expect(mockClient.session.get).toHaveBeenCalledWith({ path: { id: 'ses_test' } });
    });
  });

  describe('title reset', () => {
    it('should restore original title on reset', async () => {
      await annotateSessionTitle(mockClient as any, 'ses_reset', 'my-job', 'done');
      expect(hasAnnotation('ses_reset')).toBe(true);

      await resetSessionTitle(mockClient as any, 'ses_reset');

      expect(mockClient.session.update).toHaveBeenLastCalledWith({
        path: { id: 'ses_reset' },
        body: { title: 'Original Title' },
      });
      expect(hasAnnotation('ses_reset')).toBe(false);
    });

    it('should be a no-op when session has no annotation', async () => {
      await resetSessionTitle(mockClient as any, 'ses_unknown');
      expect(mockClient.session.update).not.toHaveBeenCalled();
    });

    it('should clear all annotations for the session', async () => {
      await annotateSessionTitle(mockClient as any, 'ses_multi', 'job-x', 'done');
      await annotateSessionTitle(mockClient as any, 'ses_multi', 'job-y', 'failed');
      expect(_getTitleStateForTesting().get('ses_multi')!.annotations.size).toBe(2);

      await resetSessionTitle(mockClient as any, 'ses_multi');
      expect(hasAnnotation('ses_multi')).toBe(false);
      expect(_getTitleStateForTesting().has('ses_multi')).toBe(false);
    });

    it('should not throw when session.update fails during reset', async () => {
      mockClient.session.update.mockRejectedValueOnce(new Error('network error'));

      await annotateSessionTitle(mockClient as any, 'ses_err', 'my-job', 'done');
      await expect(resetSessionTitle(mockClient as any, 'ses_err')).resolves.toBeUndefined();
      expect(hasAnnotation('ses_err')).toBe(false);
    });
  });
});
