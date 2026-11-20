import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setupNotifications,
  annotateSessionTitle,
  resetSessionTitle,
  hasAnnotation,
  ensureMCPrefix,
  _getTitleStateForTesting,
  _getMCPrefixedSessionsForTesting,
} from '../../src/hooks/notifications';
import type { Job } from '../../src/lib/job-state';
import * as rpcEvents from '../../src/lib/rpc-events';
import * as toastMod from '../../src/lib/toast';

vi.mock('../../src/lib/reports', () => ({
  readReport: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/lib/toast', () => ({
  showToast: vi.fn(async () => {}),
}));

describe('notifications hook', () => {
  let mockMonitor: {
    handlers: Map<string, ((job: Job) => void)[]>;
    on(event: string, handler: (job: Job) => void): void;
  };
  let mockClient: {
    session: {
      prompt: ReturnType<typeof vi.fn>;
      synthetic: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let mockGetActiveSessionID: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _getTitleStateForTesting().clear();
    _getMCPrefixedSessionsForTesting().clear();

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
        synthetic: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue({ title: 'Original Title' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };

    mockGetActiveSessionID = vi.fn().mockResolvedValue('session-123');
  });

  it('should set up notification handlers for all events', () => {
    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
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

    expect(mockClient.session.synthetic).toHaveBeenCalled();
    const callArgs = mockClient.session.synthetic.mock.calls[0][0];
    expect(callArgs.text).toContain("🟢 Job 'feature-auth' completed");
    expect(callArgs.text).toContain('mc/feature-auth');
  });

  it('should send notification on job failure', async () => {
    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
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

    expect(mockClient.session.synthetic).toHaveBeenCalled();
    const callArgs = mockClient.session.synthetic.mock.calls[0][0];
    expect(callArgs.text).toContain("🔴 Job 'fix-bug-123' failed");
    expect(callArgs.text).toContain('mc/fix-bug-123');
  });

  it('should deduplicate notifications for the same job event', async () => {
    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
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

    const firstCallCount = mockClient.session.synthetic.mock.calls.length;

    handlers[0](job);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondCallCount = mockClient.session.synthetic.mock.calls.length;

    expect(firstCallCount).toBe(1);
    expect(secondCallCount).toBe(1);
  });

  it('should not send notification if no active session', async () => {
    mockGetActiveSessionID.mockResolvedValue(undefined);

    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
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

    expect(mockClient.session.synthetic).not.toHaveBeenCalled();
  });

  it('should send notification on blocked event', async () => {
    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
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

    expect(mockClient.session.synthetic).toHaveBeenCalled();
    const callArgs = mockClient.session.synthetic.mock.calls[0][0];
    expect(callArgs.text).toContain("⚠️ Job 'blocked-task' is blocked");
  });

  it('should send notification on needs_review event', async () => {
    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
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

    expect(mockClient.session.synthetic).toHaveBeenCalled();
    const callArgs = mockClient.session.synthetic.mock.calls[0][0];
    expect(callArgs.text).toContain("👀 Job 'review-task' needs review");
  });

  it('should route notification to launchSessionID when present', async () => {
    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
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

    expect(mockClient.session.synthetic).toHaveBeenCalled();
    const callArgs = mockClient.session.synthetic.mock.calls[0][0];
    expect(callArgs.sessionID).toBe('ses_launch_abc');
    expect(callArgs.text).toContain("🟢 Job 'routed-job' completed");
  });

  it('should fallback to activeSessionID when launchSessionID is undefined', async () => {
    mockGetActiveSessionID.mockResolvedValue('ses_active_456');

    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
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

    expect(mockClient.session.synthetic).toHaveBeenCalled();
    const callArgs = mockClient.session.synthetic.mock.calls[0][0];
    expect(callArgs.sessionID).toBe('ses_active_456');
  });

  it('should not send notification when launchSessionID is invalid', async () => {
    mockGetActiveSessionID.mockResolvedValue(undefined);

    setupNotifications({
      client: mockClient as any,
      monitor: mockMonitor as any,
      getActiveSessionID: mockGetActiveSessionID as any,
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

    expect(mockClient.session.synthetic).not.toHaveBeenCalled();

  });

  describe('title annotations', () => {
    it('should annotate session title on job completion', async () => {
      setupNotifications({
        client: mockClient as any,
        monitor: mockMonitor as any,
        getActiveSessionID: mockGetActiveSessionID as any,
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
        sessionID: 'ses_launcher',
        title: '✅ Original Title',
      });
    });

    it('should annotate session title on job failure', async () => {
      setupNotifications({
        client: mockClient as any,
        monitor: mockMonitor as any,
        getActiveSessionID: mockGetActiveSessionID as any,
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
        sessionID: 'ses_launcher',
        title: '❌ Original Title',
      });
    });

    it('should annotate session title on awaiting_input', async () => {
      setupNotifications({
        client: mockClient as any,
        monitor: mockMonitor as any,
        getActiveSessionID: mockGetActiveSessionID as any,
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
        sessionID: 'ses_launcher',
        title: '❓ Original Title',
      });
    });

    it('should aggregate multiple annotations as "N jobs need attention"', async () => {
      setupNotifications({
        client: mockClient as any,
        monitor: mockMonitor as any,
        getActiveSessionID: mockGetActiveSessionID as any,
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
        sessionID: 'ses_launcher',
        title: '🔔 Original Title',
      });
    });

    it('should annotate title for blocked events', async () => {
      setupNotifications({
        client: mockClient as any,
        monitor: mockMonitor as any,
        getActiveSessionID: mockGetActiveSessionID as any,
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

      expect(mockClient.session.update).toHaveBeenCalledWith({
        sessionID: 'ses_launcher',
        title: '🚧 Original Title',
      });
    });

    it('should not annotate title when sessionID is undefined', async () => {
      mockGetActiveSessionID.mockResolvedValue(undefined);

      setupNotifications({
        client: mockClient as any,
        monitor: mockMonitor as any,
        getActiveSessionID: mockGetActiveSessionID as any,
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
      expect(mockClient.session.get).toHaveBeenCalledWith({ sessionID: 'ses_test' });
    });
  });

  describe('title reset', () => {
    it('should restore original title on reset', async () => {
      await annotateSessionTitle(mockClient as any, 'ses_reset', 'my-job', 'done');
      expect(hasAnnotation('ses_reset')).toBe(true);

      await resetSessionTitle(mockClient as any, 'ses_reset');

      expect(mockClient.session.update).toHaveBeenLastCalledWith({
        sessionID: 'ses_reset',
        title: 'Original Title',
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

  describe('[MC] prefix', () => {
    it('should prefix session title with [MC] on first call', async () => {
      await ensureMCPrefix(mockClient as any, 'ses_mc1');

      expect(mockClient.session.get).toHaveBeenCalledWith({ sessionID: 'ses_mc1' });
      expect(mockClient.session.update).toHaveBeenCalledWith({
        sessionID: 'ses_mc1',
        title: '[MC] Original Title',
      });
    });

    it('should be idempotent — second call is a no-op', async () => {
      await ensureMCPrefix(mockClient as any, 'ses_mc2');
      await ensureMCPrefix(mockClient as any, 'ses_mc2');

      expect(mockClient.session.update).toHaveBeenCalledTimes(1);
    });

    it('should not prefix when sessionID is undefined', async () => {
      await ensureMCPrefix(mockClient as any, undefined);

      expect(mockClient.session.get).not.toHaveBeenCalled();
      expect(mockClient.session.update).not.toHaveBeenCalled();
    });

    it('should not prefix when sessionID is invalid', async () => {
      await ensureMCPrefix(mockClient as any, 'not-a-session');

      expect(mockClient.session.get).not.toHaveBeenCalled();
      expect(mockClient.session.update).not.toHaveBeenCalled();
    });

    it('should not double-prefix when title already starts with [MC]', async () => {
      mockClient.session.get.mockResolvedValueOnce({ title: '[MC] Already Prefixed' });
      await ensureMCPrefix(mockClient as any, 'ses_mc3');

      expect(mockClient.session.update).not.toHaveBeenCalled();
    });

    it('should include [MC] in annotated titles when session is prefixed', async () => {
      await ensureMCPrefix(mockClient as any, 'ses_mc4');
      mockClient.session.update.mockClear();

      await annotateSessionTitle(mockClient as any, 'ses_mc4', 'my-job', 'complete');

      expect(mockClient.session.update).toHaveBeenCalledWith({
        sessionID: 'ses_mc4',
        title: '[MC] \u2705 Original Title',
      });
    });

    it('should include [MC] in multi-annotation titles', async () => {
      await ensureMCPrefix(mockClient as any, 'ses_mc5');
      mockClient.session.update.mockClear();

      await annotateSessionTitle(mockClient as any, 'ses_mc5', 'job-a', 'complete');
      await annotateSessionTitle(mockClient as any, 'ses_mc5', 'job-b', 'failed');

      const calls = mockClient.session.update.mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall).toEqual({
        sessionID: 'ses_mc5',
        title: '[MC] \uD83D\uDD14 Original Title',
      });
    });

    it('should preserve [MC] prefix on title reset', async () => {
      await ensureMCPrefix(mockClient as any, 'ses_mc6');
      await annotateSessionTitle(mockClient as any, 'ses_mc6', 'my-job', 'complete');
      mockClient.session.update.mockClear();

      await resetSessionTitle(mockClient as any, 'ses_mc6');

      expect(mockClient.session.update).toHaveBeenCalledWith({
        sessionID: 'ses_mc6',
        title: '[MC] Original Title',
      });
    });

    it('should re-render with [MC] when annotations already exist', async () => {
      await annotateSessionTitle(mockClient as any, 'ses_mc7', 'my-job', 'failed');
      mockClient.session.update.mockClear();

      await ensureMCPrefix(mockClient as any, 'ses_mc7');

      expect(mockClient.session.update).toHaveBeenCalledWith({
        sessionID: 'ses_mc7',
        title: '[MC] \u274C Original Title',
      });
    });

    it('should strip [MC] from fetched title when storing originalTitle', async () => {
      mockClient.session.get.mockResolvedValue({ title: '[MC] My Session' });

      await annotateSessionTitle(mockClient as any, 'ses_mc8', 'my-job', 'complete');

      const state = _getTitleStateForTesting().get('ses_mc8');
      expect(state?.originalTitle).toBe('My Session');
    });
  });

  describe('attention events', () => {
    const makeJob = (overrides: Partial<Job> = {}): Job => ({
      id: 'job-attention',
      name: 'feature-auth',
      worktreePath: '/path/to/worktree',
      branch: 'mc/feature-auth',
      status: 'running',
      prompt: 'Add OAuth support',
      createdAt: new Date().toISOString(),
      sessionID: 'ses_job',
      ...overrides,
    });

    const fire = async (event: string, job: Job, extra?: unknown) => {
      setupNotifications({
        client: mockClient as any,
        monitor: mockMonitor as any,
        getActiveSessionID: mockGetActiveSessionID as any,
      });
      (mockMonitor.handlers.get(event)![0] as (job: Job, extra?: unknown) => void)(job, extra);
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    it('emits an attention event instead of a plain toast when clients can receive it', async () => {
      const emitAttention = vi.spyOn(rpcEvents, 'emitAttention').mockResolvedValue(undefined);
      vi.spyOn(rpcEvents, 'hasRpcEventEmitter').mockReturnValue(true);
      (toastMod.showToast as ReturnType<typeof vi.fn>).mockClear();

      await fire('complete', makeJob({ status: 'completed', completedAt: new Date().toISOString() }));

      expect(emitAttention).toHaveBeenCalledWith({
        kind: 'complete',
        title: 'Job "feature-auth" completed',
        message: 'Branch: mc/feature-auth',
        jobName: 'feature-auth',
        sessionID: 'ses_job',
      });
      expect(toastMod.showToast).not.toHaveBeenCalled();
      // The launching session is still told.
      expect(mockClient.session.synthetic).toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('maps each job event to an attention kind', async () => {
      const emitAttention = vi.spyOn(rpcEvents, 'emitAttention').mockResolvedValue(undefined);
      vi.spyOn(rpcEvents, 'hasRpcEventEmitter').mockReturnValue(true);

      await fire('failed', makeJob({ id: 'j-failed', status: 'failed', completedAt: new Date().toISOString() }));
      await fire('blocked', makeJob({ id: 'j-blocked' }));
      await fire('needs_review', makeJob({ id: 'j-review' }));
      await fire('awaiting_input', makeJob({ id: 'j-await' }));

      expect(emitAttention.mock.calls.map(([data]) => data.kind)).toEqual([
        'failed',
        'blocked',
        'needs_review',
        'question',
      ]);
      vi.restoreAllMocks();
    });

    it('still tells connected clients about a job that has no session to notify', async () => {
      // Launched from the TUI dashboard, and no session has been seen yet.
      const emitAttention = vi.spyOn(rpcEvents, 'emitAttention').mockResolvedValue(undefined);
      vi.spyOn(rpcEvents, 'hasRpcEventEmitter').mockReturnValue(true);
      mockGetActiveSessionID.mockResolvedValue(undefined);

      await fire('complete', makeJob({ id: 'j-dashboard', status: 'completed', completedAt: new Date().toISOString() }));

      expect(emitAttention).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'complete', jobName: 'feature-auth' }),
      );
      expect(mockClient.session.synthetic).not.toHaveBeenCalled();
      expect(mockClient.session.update).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('sends notifications whatever kind of session was active last', async () => {
      // There used to be a gate that silenced every notification once the
      // "active" session turned out to be a subagent. No such lookup is made now.
      const emitAttention = vi.spyOn(rpcEvents, 'emitAttention').mockResolvedValue(undefined);
      vi.spyOn(rpcEvents, 'hasRpcEventEmitter').mockReturnValue(true);
      mockClient.session.get.mockResolvedValue({ title: 'Subagent', parentID: 'ses_parent' });

      await fire(
        'complete',
        makeJob({ id: 'j-sub', status: 'completed', completedAt: new Date().toISOString(), launchSessionID: 'ses_launcher' }),
      );

      expect(emitAttention).toHaveBeenCalledTimes(1);
      expect(mockClient.session.synthetic).toHaveBeenCalledWith(
        expect.objectContaining({ sessionID: 'ses_launcher' }),
      );
      vi.restoreAllMocks();
    });

    it('says that a finished job left uncommitted changes', async () => {
      const emitAttention = vi.spyOn(rpcEvents, 'emitAttention').mockResolvedValue(undefined);
      vi.spyOn(rpcEvents, 'hasRpcEventEmitter').mockReturnValue(true);

      await fire(
        'needs_review',
        makeJob({
          id: 'j-dirty',
          status: 'completed',
          completedAt: new Date().toISOString(),
          launchSessionID: 'ses_launcher',
          uncommittedChanges: ['src/new.ts', 'README.md'],
        }),
      );

      expect(emitAttention).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'needs_review',
          message: expect.stringContaining('2 uncommitted file(s)'),
        }),
      );
      const [{ text }] = mockClient.session.synthetic.mock.calls[0];
      expect(text).toContain('needs review');
      expect(text).toContain('src/new.ts, README.md');
      expect(text).toContain('not on its branch');
      vi.restoreAllMocks();
    });

    it('says why a job failed', async () => {
      vi.spyOn(rpcEvents, 'emitAttention').mockResolvedValue(undefined);
      vi.spyOn(rpcEvents, 'hasRpcEventEmitter').mockReturnValue(true);

      await fire(
        'failed',
        makeJob({
          id: 'j-why',
          status: 'failed',
          completedAt: new Date().toISOString(),
          launchSessionID: 'ses_launcher',
          failureReason: 'its session was deleted',
        }),
      );

      const [{ text }] = mockClient.session.synthetic.mock.calls[0];
      expect(text).toContain('Reason: its session was deleted.');
      vi.restoreAllMocks();
    });

    it('falls back to the plain toast when no client can receive attention events', async () => {
      const emitAttention = vi.spyOn(rpcEvents, 'emitAttention').mockResolvedValue(undefined);
      vi.spyOn(rpcEvents, 'hasRpcEventEmitter').mockReturnValue(false);
      (toastMod.showToast as ReturnType<typeof vi.fn>).mockClear();

      await fire('complete', makeJob({ id: 'j-toast', status: 'completed', completedAt: new Date().toISOString() }));

      expect(emitAttention).not.toHaveBeenCalled();
      expect(toastMod.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Job "feature-auth" completed', variant: 'success' }),
      );
      vi.restoreAllMocks();
    });
  });
});
