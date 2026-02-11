import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupNotifications } from '../../src/hooks/notifications';
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
    };
  };
  let mockGetActiveSessionID: ReturnType<typeof vi.fn>;
  let mockIsSubagent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
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
});
