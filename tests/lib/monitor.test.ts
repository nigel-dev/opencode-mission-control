import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import type { AgentReport } from '../../src/lib/reports';
import type { PermissionPolicyConfig } from '../../src/lib/permission-policy';
import * as jobState from '../../src/lib/job-state';
import * as reports from '../../src/lib/reports';
import * as configMod from '../../src/lib/config';
import * as planState from '../../src/lib/plan-state';
import * as rpcEvents from '../../src/lib/rpc-events';
import * as worktreeStatus from '../../src/lib/worktree-status';
import { runInProject } from '../../src/lib/project-context';
import {
  clearBackgroundWork,
  isJobSession,
  recordBackgroundWork,
  setRuntimeClient,
  type RuntimeClient,
} from '../../src/lib/job-runtime';
import {
  clearPendingQuestionsForJob,
  getPendingQuestionsForJob,
  type PendingQuestion,
} from '../../src/lib/question-relay';

const { JobMonitor, RESTART_PROMPT, buildCommitPrompt } = await import('../../src/lib/monitor');

type Monitor = InstanceType<typeof JobMonitor>;

/** A controllable stand-in for one connection to the server's event stream. */
class EventChannel {
  private queue: Array<{ event?: unknown; end?: boolean; error?: Error }> = [];
  private wake: (() => void) | null = null;

  push(type: string, data: Record<string, unknown>): void {
    this.queue.push({ event: { type, data } });
    this.wake?.();
  }

  pushRaw(event: unknown): void {
    this.queue.push({ event });
    this.wake?.();
  }

  end(): void {
    this.queue.push({ end: true });
    this.wake?.();
  }

  fail(error: Error): void {
    this.queue.push({ error });
    this.wake?.();
  }

  async *stream(signal?: AbortSignal): AsyncGenerator<unknown> {
    while (true) {
      while (this.queue.length === 0) {
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        this.wake = null;
      }
      const item = this.queue.shift()!;
      if (item.end) return;
      if (item.error) throw item.error;
      yield item.event;
    }
  }
}

function createFakeClient(channels: EventChannel[]) {
  let connection = 0;
  const signals: AbortSignal[] = [];
  return {
    signals,
    event: {
      subscribe: vi.fn((options?: { signal?: AbortSignal }) => {
        if (options?.signal) signals.push(options.signal);
        const channel = channels[Math.min(connection, channels.length - 1)];
        connection += 1;
        return channel.stream(options?.signal);
      }),
    },
    session: {
      get: vi.fn(async (_input: { sessionID: string }): Promise<Record<string, unknown>> => ({})),
      context: vi.fn(async (_input: { sessionID: string }): Promise<unknown[]> => []),
      prompt: vi.fn(async (_input: { sessionID: string; text: string }) => undefined),
    },
    permission: {
      list: vi.fn(async (_input: { sessionID: string }): Promise<Array<Record<string, unknown>>> => []),
      reply: vi.fn(async (_input: Record<string, unknown>) => undefined),
    },
  };
}

type FakeClient = ReturnType<typeof createFakeClient>;

const DEFAULT_POLICY: PermissionPolicyConfig = {
  permissions: {
    fileEdit: { insideWorktree: 'auto-approve', outsideWorktree: 'deny' },
    shellCommand: { insideWorktree: 'auto-approve', outsideWorktree: 'ask-user' },
    networkAccess: 'deny',
    installPackages: 'ask-user',
    mcpTools: 'auto-approve',
  },
};

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-a',
    name: 'job-a',
    worktreePath: '/wt/job-a',
    branch: 'mc/job-a',
    status: 'running',
    prompt: 'Do the work',
    // Launched a minute ago: the job existed before the monitor under test started.
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    sessionID: 'ses_a',
    ...overrides,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('JobMonitor', () => {
  let jobs: Job[];
  let reportsByJob: Map<string, AgentReport>;
  let policy: PermissionPolicyConfig;
  let channel: EventChannel;
  let client: FakeClient;
  let monitor: Monitor | undefined;
  let emitted: Array<{ type: string; job: Job; extra?: unknown }>;
  let updateJobSpy: ReturnType<typeof vi.spyOn>;
  let getRunningJobsSpy: ReturnType<typeof vi.spyOn>;
  /** What `git status` would report as the job's uncommitted work. */
  let uncommitted: string[];
  let findUncommittedSpy: ReturnType<typeof vi.spyOn>;

  function install(fake: FakeClient): void {
    client = fake;
    setRuntimeClient(fake as unknown as RuntimeClient);
  }

  function startMonitor(options: { pollInterval?: number; jobCacheTtl?: number; resumeGrace?: number } = {}): Monitor {
    const created = new JobMonitor({ jobCacheTtl: 0, ...options });
    for (const type of ['complete', 'failed', 'blocked', 'needs_review', 'awaiting_input', 'agent_report', 'question'] as const) {
      created.on(type, (job, extra) => {
        emitted.push({ type, job, extra });
      });
    }
    created.start();
    monitor = created;
    return created;
  }

  const eventsOfType = (type: string) => emitted.filter((entry) => entry.type === type);
  const statusOf = (id: string) => jobs.find((job) => job.id === id)?.status;

  beforeEach(() => {
    jobs = [];
    reportsByJob = new Map();
    policy = DEFAULT_POLICY;
    emitted = [];
    monitor = undefined;
    channel = new EventChannel();
    install(createFakeClient([channel]));

    getRunningJobsSpy = vi.spyOn(jobState, 'getRunningJobs').mockImplementation(
      async () => jobs.filter((job) => job.status === 'running').map((job) => ({ ...job })),
    );
    vi.spyOn(jobState, 'getJob').mockImplementation(async (id: string) => {
      const job = jobs.find((candidate) => candidate.id === id);
      return job ? { ...job } : undefined;
    });
    updateJobSpy = vi.spyOn(jobState, 'updateJob').mockImplementation(
      async (id: string, updates: Partial<Job>) => {
        const index = jobs.findIndex((job) => job.id === id);
        if (index === -1) throw new Error(`Job with id ${id} not found`);
        jobs[index] = { ...jobs[index], ...updates };
      },
    );
    vi.spyOn(reports, 'readReport').mockImplementation(
      async (jobId: string) => reportsByJob.get(jobId) ?? null,
    );
    vi.spyOn(configMod, 'loadConfig').mockImplementation(async () => ({
      pollInterval: 10000,
      worktreeBasePath: '/tmp/mc-worktrees',
      defaultPermissionPolicy: policy,
    }));
    vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);
    vi.spyOn(jobState, 'loadJobState').mockImplementation(async () => ({
      version: 4 as const,
      jobs: jobs.map((job) => ({ ...job })),
      updatedAt: new Date().toISOString(),
    }));
    uncommitted = [];
    findUncommittedSpy = vi
      .spyOn(worktreeStatus, 'findUncommittedChanges')
      .mockImplementation(async () => [...uncommitted]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    monitor?.stop();
    for (const id of ['job-a', 'job-b', 'job-legacy']) {
      clearPendingQuestionsForJob(id);
    }
    setRuntimeClient(null);
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create monitor with default 10s poll interval', () => {
      expect(new JobMonitor()).toBeDefined();
    });

    it('should create monitor with custom poll interval', () => {
      expect(new JobMonitor({ pollInterval: 15000 })).toBeDefined();
    });

    it('should throw error if poll interval is less than 10s in production', () => {
      const originalEnv = process.env.NODE_ENV;
      const originalVitest = process.env.VITEST;

      delete process.env.NODE_ENV;
      delete process.env.VITEST;

      try {
        expect(() => new JobMonitor({ pollInterval: 5000 })).toThrow(
          'Poll interval must be at least 10000ms (10s)',
        );
      } finally {
        if (originalEnv) process.env.NODE_ENV = originalEnv;
        if (originalVitest) process.env.VITEST = originalVitest;
      }
    });
  });

  describe('start and stop', () => {
    it('should open exactly one event subscription and reconcile immediately', async () => {
      startMonitor();
      await settle();

      expect(client.event.subscribe).toHaveBeenCalledTimes(1);
      expect(client.signals).toHaveLength(1);
      expect(client.signals[0].aborted).toBe(false);
      expect(getRunningJobsSpy).toHaveBeenCalledTimes(1);
    });

    it('should not start twice', async () => {
      const started = startMonitor();
      started.start();
      await settle();

      expect(client.event.subscribe).toHaveBeenCalledTimes(1);
      expect(getRunningJobsSpy).toHaveBeenCalledTimes(1);
    });

    it('should reconcile at the configured interval', async () => {
      startMonitor({ pollInterval: 60 });

      await waitFor(() => getRunningJobsSpy.mock.calls.length >= 3);

      expect(client.event.subscribe).toHaveBeenCalledTimes(1);
    });

    it('should abort the subscription and stop reconciling on stop', async () => {
      const started = startMonitor({ pollInterval: 60 });
      await settle();

      started.stop();
      const callsAtStop = getRunningJobsSpy.mock.calls.length;
      await settle(200);

      expect(client.signals[0].aborted).toBe(true);
      expect(getRunningJobsSpy.mock.calls.length).toBe(callsAtStop);
      expect(client.event.subscribe).toHaveBeenCalledTimes(1);
    });

    it('should ignore events after stop', async () => {
      jobs.push(makeJob());
      const started = startMonitor();
      await settle();

      started.stop();
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await settle();

      expect(statusOf('job-a')).toBe('running');
      expect(emitted).toEqual([]);
    });

    it('should keep a job running when its turn ends on a blocked report', async () => {
      jobs.push(makeJob());
      reportsByJob.set('job-a', {
        jobId: 'job-a',
        jobName: 'job-a',
        status: 'blocked',
        message: 'Which database?',
        timestamp: new Date().toISOString(),
      });
      startMonitor();
      await settle();

      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('blocked').length >= 1);

      expect(statusOf('job-a')).toBe('running');
      expect(eventsOfType('complete')).toEqual([]);

      // Once answered, the report is superseded and the next finished turn completes the job.
      reportsByJob.set('job-a', {
        jobId: 'job-a',
        jobName: 'job-a',
        status: 'working',
        message: 'Answer received',
        timestamp: new Date().toISOString(),
      });
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => statusOf('job-a') === 'completed');

      expect(eventsOfType('complete')).toHaveLength(1);
    });

    it('should be safe to stop repeatedly and without starting', () => {
      const idle = new JobMonitor();
      expect(() => idle.stop()).not.toThrow();

      const started = startMonitor();
      started.stop();
      expect(() => started.stop()).not.toThrow();
    });

    it('should still reconcile when no runtime client is installed', async () => {
      setRuntimeClient(null);

      startMonitor();
      await settle();

      expect(client.event.subscribe).not.toHaveBeenCalled();
      expect(getRunningJobsSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('event dispatch by session ID', () => {
    it('should complete the job whose session finished', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(statusOf('job-a')).toBe('completed');
      expect(updateJobSpy).toHaveBeenCalledWith('job-a', {
        status: 'completed',
        completedAt: expect.any(String),
      });
      const [complete] = eventsOfType('complete');
      expect(complete.job).toMatchObject({ id: 'job-a', status: 'completed', sessionID: 'ses_a' });
      expect(complete.job.completedAt).toEqual(expect.any(String));
    });

    it('should route each event to the job that owns the session', async () => {
      jobs.push(makeJob(), makeJob({ id: 'job-b', name: 'job-b', sessionID: 'ses_b', worktreePath: '/wt/job-b' }));
      startMonitor();
      await settle();

      channel.push('session.execution.succeeded', { sessionID: 'ses_b' });
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(statusOf('job-b')).toBe('completed');
      expect(statusOf('job-a')).toBe('running');
      expect(eventsOfType('complete')[0].job.id).toBe('job-b');
    });

    it('should ignore events for sessions that are not jobs', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('session.execution.succeeded', { sessionID: 'ses_user' });
      channel.push('session.execution.failed', { sessionID: 'ses_user' });
      channel.push('session.tool.called', { sessionID: 'ses_subagent', id: 't1', input: { questions: [{ question: 'x' }] } });
      await settle();

      expect(statusOf('job-a')).toBe('running');
      expect(updateJobSpy).not.toHaveBeenCalled();
      expect(emitted).toEqual([]);
    });

    it('should ignore malformed events and keep the stream alive', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.pushRaw(null);
      channel.pushRaw('not-an-event');
      channel.pushRaw({ data: { sessionID: 'ses_a' } });
      channel.pushRaw({ type: 'session.execution.succeeded' });
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(statusOf('job-a')).toBe('completed');
      expect(client.event.subscribe).toHaveBeenCalledTimes(1);
    });

    it('should pick up a job launched after the monitor started', async () => {
      startMonitor();
      await settle();

      jobs.push(makeJob());
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(statusOf('job-a')).toBe('completed');
    });

    it('should mark the job failed when its session fails', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('session.execution.failed', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('failed').length === 1);

      expect(statusOf('job-a')).toBe('failed');
      expect(eventsOfType('failed')[0].job).toMatchObject({ id: 'job-a', status: 'failed' });
      expect(eventsOfType('complete')).toEqual([]);
    });

    it.each([
      ['user', 'its session was interrupted'],
      ['inactivity', 'its session was interrupted after a period of inactivity'],
      ['something-new', 'its session was interrupted (something-new)'],
      [undefined, 'its session was interrupted (unknown reason)'],
    ])('should mark the job failed when its session is interrupted (reason: %s)', async (reason, failureReason) => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('session.execution.interrupted', { sessionID: 'ses_a', ...(reason ? { reason } : {}) });
      await waitFor(() => eventsOfType('failed').length === 1);

      expect(statusOf('job-a')).toBe('failed');
      expect(jobs[0].failureReason).toBe(failureReason);
      expect(eventsOfType('failed')[0].job).toMatchObject({ failureReason });
    });

    it('should ignore an interruption that was superseded by newer input', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      // mc_answer to a busy job: the turn is replaced, the session keeps running.
      channel.push('session.execution.interrupted', { sessionID: 'ses_a', reason: 'superseded' });
      await settle();

      expect(statusOf('job-a')).toBe('running');
      expect(emitted).toEqual([]);
      expect(updateJobSpy).not.toHaveBeenCalled();

      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);
    });

    it('should not fail a job whose session was interrupted by a server shutdown', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('session.execution.interrupted', { sessionID: 'ses_a', reason: 'shutdown' });
      await settle();

      expect(statusOf('job-a')).toBe('running');
      expect(eventsOfType('failed')).toEqual([]);
    });

    it('should fail the job when its session is deleted', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('session.deleted', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('failed').length === 1);

      expect(statusOf('job-a')).toBe('failed');
      expect(jobs[0].failureReason).toBe('its session was deleted');
    });

    it('should say the session was deleted when removal interrupts it first', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      // Removing a running session interrupts it, then deletes it.
      channel.push('session.execution.interrupted', { sessionID: 'ses_a', reason: 'user' });
      await waitFor(() => eventsOfType('failed').length === 1);
      channel.push('session.deleted', { sessionID: 'ses_a' });
      await waitFor(() => jobs[0].failureReason === 'its session was deleted');

      expect(statusOf('job-a')).toBe('failed');
      expect(eventsOfType('failed')).toHaveLength(1);
    });

    it('should record why a failed session failed', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('session.execution.failed', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('failed').length === 1);

      expect(jobs[0].failureReason).toBe('its session ended with an error');
    });

    it('should remember the sessions a job starts as job sessions', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      // A subagent of the job, and a subagent of that subagent.
      channel.push('session.created', { sessionID: 'ses_child', parentID: 'ses_a' });
      channel.push('session.created', { sessionID: 'ses_grandchild', parentID: 'ses_child' });
      // The user's own new session, and a subagent of it.
      channel.push('session.created', { sessionID: 'ses_user' });
      channel.push('session.created', { sessionID: 'ses_user_child', parentID: 'ses_user' });
      await settle();

      expect(isJobSession('ses_child')).toBe(true);
      expect(isJobSession('ses_grandchild')).toBe(true);
      expect(isJobSession('ses_user')).toBe(false);
      expect(isJobSession('ses_user_child')).toBe(false);
      // A subagent finishing is not the job finishing.
      channel.push('session.execution.succeeded', { sessionID: 'ses_child' });
      await settle();
      expect(statusOf('job-a')).toBe('running');
    });

    it('should emit a terminal event only once per job', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      channel.push('session.execution.failed', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);
      await settle();

      expect(eventsOfType('complete')).toHaveLength(1);
      expect(eventsOfType('failed')).toEqual([]);
      expect(statusOf('job-a')).toBe('completed');
    });

    it('should not overwrite a job that was stopped behind its back', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      // mc_kill marks the job stopped, then interrupts the session.
      jobs[0] = { ...jobs[0], status: 'stopped' };
      channel.push('session.execution.interrupted', { sessionID: 'ses_a' });
      await settle();

      expect(statusOf('job-a')).toBe('stopped');
      expect(updateJobSpy).not.toHaveBeenCalled();
      expect(emitted).toEqual([]);
    });
  });

  describe('completion vs awaiting input', () => {
    const questionInput = {
      questions: [
        {
          question: 'Which database?',
          header: 'Database',
          options: [{ label: 'Postgres', description: 'Recommended' }, { label: 'SQLite' }],
          multiple: false,
        },
      ],
    };

    it('should relay a question asked through the question tool', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('session.tool.called', { sessionID: 'ses_a', id: 'tool-1', input: questionInput });
      await waitFor(() => eventsOfType('question').length === 1);

      const pending = eventsOfType('question')[0].extra as PendingQuestion;
      expect(pending).toMatchObject({
        jobId: 'job-a',
        jobName: 'job-a',
        partId: 'tool-1',
        callID: 'tool-1',
        sessionID: 'ses_a',
        question: 'Which database?',
        header: 'Database',
        options: [{ label: 'Postgres', description: 'Recommended' }, { label: 'SQLite' }],
        multiple: false,
        taskSummary: 'Do the work',
      });
      expect(getPendingQuestionsForJob('job-a')).toHaveLength(1);
    });

    it('should not relay the same question twice', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('session.tool.called', { sessionID: 'ses_a', id: 'tool-1', input: questionInput });
      channel.push('session.tool.called', { sessionID: 'ses_a', id: 'tool-1', input: questionInput });
      await waitFor(() => eventsOfType('question').length >= 1);
      await settle();

      expect(eventsOfType('question')).toHaveLength(1);
    });

    it('should treat a finished turn with a pending question as awaiting input, not complete', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('session.tool.called', { sessionID: 'ses_a', id: 'tool-1', input: questionInput });
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('awaiting_input').length === 1);
      await settle();

      expect(statusOf('job-a')).toBe('running');
      expect(eventsOfType('complete')).toEqual([]);
      expect(updateJobSpy).not.toHaveBeenCalled();
      expect(eventsOfType('awaiting_input')[0].job.id).toBe('job-a');
    });

    it('should announce awaiting input once per wait', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('session.tool.called', { sessionID: 'ses_a', id: 'tool-1', input: questionInput });
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('awaiting_input').length >= 1);
      await settle();

      expect(eventsOfType('awaiting_input')).toHaveLength(1);
    });

    it('should complete the job once the question is answered and the next turn ends', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('session.tool.called', { sessionID: 'ses_a', id: 'tool-1', input: questionInput });
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('awaiting_input').length === 1);

      channel.push('session.tool.success', { sessionID: 'ses_a', id: 'tool-1' });
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(statusOf('job-a')).toBe('completed');
      expect(getPendingQuestionsForJob('job-a')).toEqual([]);
    });

    it('should treat a finished turn with an unanswered permission request as awaiting input', async () => {
      policy = {
        permissions: { ...DEFAULT_POLICY.permissions, networkAccess: 'ask-user' },
      };
      jobs.push(makeJob());
      startMonitor();
      await settle();

      const request = { sessionID: 'ses_a', id: 'perm-1', action: 'webfetch', message: 'Fetch docs' };
      client.permission.list.mockResolvedValue([request]);
      channel.push('permission.asked', request);
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('awaiting_input').length === 1);
      await settle();

      expect(client.permission.reply).not.toHaveBeenCalled();
      expect(statusOf('job-a')).toBe('running');
      expect(eventsOfType('complete')).toEqual([]);

      // The user answers the request elsewhere; the server no longer lists it.
      client.permission.list.mockResolvedValue([]);
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(statusOf('job-a')).toBe('completed');
    });

    it('should count a permission request as waiting until it is answered', async () => {
      policy = {
        permissions: { ...DEFAULT_POLICY.permissions, networkAccess: 'ask-user' },
      };
      jobs.push(makeJob());
      const started = startMonitor();
      await settle();

      channel.push('permission.asked', { sessionID: 'ses_a', id: 'perm-9', action: 'webfetch', message: 'Fetch docs' });
      await waitFor(() => started.getUnansweredPermissionCount('job-a') === 1);

      // Answered in the job's session (or by the relay's timeout).
      channel.push('permission.replied', { sessionID: 'ses_a', requestID: 'perm-9' });
      await waitFor(() => started.getUnansweredPermissionCount('job-a') === 0);
      expect(client.permission.reply).not.toHaveBeenCalled();
    });

    it('should complete normally after a permission request was answered by policy', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('permission.asked', {
        sessionID: 'ses_a',
        id: 'perm-1',
        action: 'edit',
        resources: ['/wt/job-a/src/index.ts'],
      });
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(eventsOfType('awaiting_input')).toEqual([]);
      expect(statusOf('job-a')).toBe('completed');
    });
  });

  describe('permission policy', () => {
    it('should auto-approve a file edit inside the worktree', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('permission.asked', {
        sessionID: 'ses_a',
        id: 'perm-1',
        action: 'edit',
        resources: ['/wt/job-a/src/index.ts'],
      });
      await waitFor(() => client.permission.reply.mock.calls.length === 1);

      expect(client.permission.reply).toHaveBeenCalledWith({
        sessionID: 'ses_a',
        requestID: 'perm-1',
        decision: 'once',
        message: 'Auto-approved by permission policy: File edit target is inside worktree',
      });
    });

    it('should deny what the policy denies', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('permission.asked', {
        sessionID: 'ses_a',
        id: 'perm-2',
        action: 'edit',
        resources: ['/etc/hosts'],
      });
      await waitFor(() => client.permission.reply.mock.calls.length === 1);

      expect(client.permission.reply).toHaveBeenCalledWith({
        sessionID: 'ses_a',
        requestID: 'perm-2',
        decision: 'reject',
        message: 'Denied by permission policy: File edit target is outside worktree',
      });
    });

    it('should answer a request only once when it arrives twice', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      const request = { sessionID: 'ses_a', id: 'perm-1', action: 'edit', resources: ['/wt/job-a/a.ts'] };
      channel.push('permission.asked', request);
      channel.push('permission.asked', request);
      await waitFor(() => client.permission.reply.mock.calls.length >= 1);
      await settle();

      expect(client.permission.reply).toHaveBeenCalledTimes(1);
    });

    it('should answer requests that were already pending when the job was first seen', async () => {
      jobs.push(makeJob());
      client.permission.list.mockResolvedValue([
        { id: 'perm-old', action: 'edit', resources: ['/wt/job-a/a.ts'] },
      ]);

      startMonitor();
      await waitFor(() => client.permission.reply.mock.calls.length === 1);

      expect(client.permission.list).toHaveBeenCalledWith({ sessionID: 'ses_a' });
      expect(client.permission.reply).toHaveBeenCalledWith(
        expect.objectContaining({ sessionID: 'ses_a', requestID: 'perm-old', decision: 'once' }),
      );
    });
  });

  describe('reconcile via session outcome', () => {
    it('should complete a job whose session already succeeded', async () => {
      jobs.push(makeJob());
      client.session.get.mockResolvedValue({ time: {}, outcome: 'succeeded' });

      startMonitor();
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(client.session.get).toHaveBeenCalledWith({ sessionID: 'ses_a' });
      expect(statusOf('job-a')).toBe('completed');
    });

    it('should fail a job whose session outcome is failed', async () => {
      jobs.push(makeJob());
      client.session.get.mockResolvedValue({ time: {}, outcome: 'failed' });

      startMonitor();
      await waitFor(() => eventsOfType('failed').length === 1);

      expect(statusOf('job-a')).toBe('failed');
      expect(jobs[0].failureReason).toBe('its session ended with an error');
      expect(eventsOfType('complete')).toEqual([]);
    });

    it('should fail a job whose session no longer exists', async () => {
      jobs.push(makeJob());
      client.session.get.mockRejectedValue(
        Object.assign(new Error('Session ses_a not found'), { _tag: 'SessionNotFoundError' }),
      );

      startMonitor();
      await waitFor(() => eventsOfType('failed').length === 1);

      expect(statusOf('job-a')).toBe('failed');
      expect(jobs[0].failureReason).toBe('its session no longer exists');
    });

    it('should leave a job running while its session has no outcome', async () => {
      jobs.push(makeJob());
      client.session.get.mockResolvedValue({ time: {} });

      startMonitor({ pollInterval: 60 });
      await waitFor(() => client.session.get.mock.calls.length >= 2);

      expect(statusOf('job-a')).toBe('running');
      expect(emitted).toEqual([]);
      expect(updateJobSpy).not.toHaveBeenCalled();
    });

    it('should fail a legacy running job that has no session', async () => {
      jobs.push(makeJob({ id: 'job-legacy', name: 'job-legacy', sessionID: undefined }));

      startMonitor();
      await waitFor(() => eventsOfType('failed').length === 1);

      expect(statusOf('job-legacy')).toBe('failed');
      expect(client.session.get).not.toHaveBeenCalled();
    });

    it('should keep the job running when its session cannot be read', async () => {
      jobs.push(makeJob());
      client.session.get.mockRejectedValue(new Error('connection reset'));

      startMonitor({ pollInterval: 60 });
      await waitFor(() => client.session.get.mock.calls.length >= 2);

      expect(statusOf('job-a')).toBe('running');
      expect(emitted).toEqual([]);
    });

    it('should not complete a succeeded session that still has a pending question', async () => {
      jobs.push(makeJob());
      client.session.get.mockResolvedValue({ time: {}, outcome: 'succeeded' });
      client.session.context.mockResolvedValue([
        {
          type: 'assistant',
          content: [
            {
              type: 'tool',
              name: 'question',
              id: 'tool-9',
              state: { status: 'running', input: { questions: [{ question: 'Proceed?' }] } },
            },
          ],
        },
      ]);

      startMonitor();
      await waitFor(() => eventsOfType('awaiting_input').length === 1);

      expect(eventsOfType('question')).toHaveLength(1);
      expect(statusOf('job-a')).toBe('running');
      expect(eventsOfType('complete')).toEqual([]);
    });

    it('should continue with other jobs when one job fails to reconcile', async () => {
      jobs.push(makeJob(), makeJob({ id: 'job-b', name: 'job-b', sessionID: 'ses_b', worktreePath: '/wt/job-b' }));
      client.session.get.mockImplementation(async ({ sessionID }) => {
        if (sessionID === 'ses_a') throw new Error('boom');
        return { time: {}, outcome: 'succeeded' };
      });

      startMonitor();
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(statusOf('job-a')).toBe('running');
      expect(statusOf('job-b')).toBe('completed');
    });
  });

  describe('agent reports', () => {
    function report(status: AgentReport['status'], overrides: Partial<AgentReport> = {}): AgentReport {
      return {
        jobId: 'job-a',
        jobName: 'job-a',
        status,
        message: `${status} message`,
        timestamp: '2026-01-01T00:00:00.000Z',
        ...overrides,
      };
    }

    it('should complete an idle job that reported completion even without a terminal event', async () => {
      jobs.push(makeJob());
      const completed = report('completed');
      reportsByJob.set('job-a', completed);
      // The turn-finished event was missed; the session says it is idle.
      client.session.get.mockResolvedValue({ time: { busy: 1, idle: 2 }, outcome: 'succeeded' });

      startMonitor();
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(statusOf('job-a')).toBe('completed');
      expect(eventsOfType('needs_review')).toEqual([]);
    });

    it('should not complete a job on its "completed" report while its turn is still running', async () => {
      jobs.push(makeJob());
      reportsByJob.set('job-a', report('completed'));
      // Busy: the agent reported completion and is still committing.
      client.session.get.mockResolvedValue({ time: { busy: Date.now(), idle: 2 }, outcome: 'succeeded' });

      startMonitor({ pollInterval: 60 });
      await waitFor(() => eventsOfType('agent_report').length >= 2);

      expect(statusOf('job-a')).toBe('running');
      expect(eventsOfType('complete')).toEqual([]);
      expect(eventsOfType('agent_report')[0].extra).toEqual(report('completed'));

      // The turn ends: now the report takes effect.
      client.session.get.mockResolvedValue({ time: { busy: 5, idle: 9 }, outcome: 'succeeded' });
      await waitFor(() => eventsOfType('complete').length === 1);
      expect(statusOf('job-a')).toBe('completed');
    });

    it('should not complete a job on its report when the session cannot be read', async () => {
      jobs.push(makeJob());
      reportsByJob.set('job-a', report('completed'));
      client.session.get.mockRejectedValue(new Error('connection reset'));

      startMonitor({ pollInterval: 60 });
      await waitFor(() => eventsOfType('agent_report').length >= 2);

      expect(statusOf('job-a')).toBe('running');
    });

    it('should complete and flag an idle job that reported needs_review', async () => {
      jobs.push(makeJob());
      const needsReview = report('needs_review');
      reportsByJob.set('job-a', needsReview);
      client.session.get.mockResolvedValue({ time: { busy: 1, idle: 2 }, outcome: 'succeeded' });

      startMonitor();
      await waitFor(() => eventsOfType('needs_review').length === 1);

      expect(statusOf('job-a')).toBe('completed');
      expect(eventsOfType('complete')).toHaveLength(1);
      const [review] = eventsOfType('needs_review');
      expect(review.job).toMatchObject({ id: 'job-a', status: 'completed' });
      expect(review.extra).toEqual(needsReview);
    });

    it('should emit blocked on every pass and keep the job running', async () => {
      jobs.push(makeJob());
      const blocked = report('blocked');
      reportsByJob.set('job-a', blocked);

      startMonitor({ pollInterval: 60 });
      await waitFor(() => eventsOfType('blocked').length >= 2);

      expect(statusOf('job-a')).toBe('running');
      expect(eventsOfType('blocked')[0].extra).toEqual(blocked);
      expect(eventsOfType('agent_report').length).toBeGreaterThanOrEqual(2);
      expect(eventsOfType('complete')).toEqual([]);
    });

    it('should emit only agent_report for progress reports', async () => {
      jobs.push(makeJob());
      reportsByJob.set('job-a', report('progress', { progress: 40 }));

      startMonitor();
      await waitFor(() => eventsOfType('agent_report').length === 1);
      await settle();

      expect(statusOf('job-a')).toBe('running');
      expect(emitted.map((entry) => entry.type)).toEqual(['agent_report']);
    });

    it('should flag needs_review when the turn ends on a needs_review report', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      const needsReview = report('needs_review');
      reportsByJob.set('job-a', needsReview);
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('needs_review').length === 1);

      expect(eventsOfType('complete')).toHaveLength(1);
      expect(eventsOfType('needs_review')[0].extra).toEqual(needsReview);
    });

    it('should survive a report that cannot be read', async () => {
      jobs.push(makeJob());
      vi.spyOn(reports, 'readReport').mockRejectedValue(new Error('EACCES'));

      startMonitor();
      await settle();
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(statusOf('job-a')).toBe('completed');
    });
  });

  describe('permission classification', () => {
    const askForEverything: PermissionPolicyConfig = {
      permissions: {
        fileEdit: { insideWorktree: 'ask-user', outsideWorktree: 'deny' },
        shellCommand: { insideWorktree: 'ask-user', outsideWorktree: 'deny' },
        networkAccess: 'ask-user',
        installPackages: 'ask-user',
        mcpTools: 'ask-user',
      },
    };

    // The relay behind "ask-user" used to approve these itself, so the policy
    // never got to ask anybody.
    it.each([
      ['an MCP tool', { action: 'mcp_tool', resources: ['github'] }],
      ['a file edit inside the worktree', { action: 'edit', resources: ['/wt/job-a/src/index.ts'] }],
      ['a shell command', { action: 'bash', resources: ['ls -la'] }],
    ])('should leave %s to the user when the policy says ask-user', async (_label, request) => {
      policy = askForEverything;
      jobs.push(makeJob());
      startMonitor();
      await settle();

      const asked = { sessionID: 'ses_a', id: 'perm-1', ...request };
      client.permission.list.mockResolvedValue([asked]);
      channel.push('permission.asked', asked);
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('awaiting_input').length === 1);

      expect(client.permission.reply).not.toHaveBeenCalled();
      expect(statusOf('job-a')).toBe('running');
    });

    it('should ask the user about a package install under the default policy', async () => {
      // Default: shell commands are approved, package installs are asked about.
      jobs.push(makeJob());
      startMonitor();
      await settle();

      const asked = { sessionID: 'ses_a', id: 'perm-1', action: 'bash', resources: ['bun add left-pad'] };
      client.permission.list.mockResolvedValue([asked]);
      channel.push('permission.asked', asked);
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('awaiting_input').length === 1);

      expect(client.permission.reply).not.toHaveBeenCalled();
    });

    it.each([
      ['a command with arguments that name outside paths', 'rm -rf /etc/hosts'],
      ['a path-like command without spaces', './gradlew'],
      ['a relative script path', 'scripts/test.sh'],
      ['an absolute binary', '/usr/bin/make'],
    ])('should decide %s by the shell rule, never by a path taken from the command', async (_label, command) => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('permission.asked', { sessionID: 'ses_a', id: 'perm-1', action: 'bash', resources: [command] });
      await waitFor(() => client.permission.reply.mock.calls.length === 1);

      // shellCommand.insideWorktree of the default policy: the same answer for
      // every command line, whatever its text looks like.
      expect(client.permission.reply).toHaveBeenCalledWith({
        sessionID: 'ses_a',
        requestID: 'perm-1',
        decision: 'once',
        message: 'Auto-approved by permission policy: Shell command target is inside worktree',
      });
    });

    it("should resolve a relative file path against the job's worktree, not the server's directory", async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.push('permission.asked', { sessionID: 'ses_a', id: 'perm-in', action: 'edit', resources: ['src/index.ts'] });
      channel.push('permission.asked', { sessionID: 'ses_a', id: 'perm-out', action: 'edit', resources: ['../other/file.ts'] });
      await waitFor(() => client.permission.reply.mock.calls.length === 2);

      expect(client.permission.reply).toHaveBeenCalledWith(
        expect.objectContaining({ requestID: 'perm-in', decision: 'once' }),
      );
      expect(client.permission.reply).toHaveBeenCalledWith(
        expect.objectContaining({ requestID: 'perm-out', decision: 'reject' }),
      );
    });
  });

  describe('server restart', () => {
    const idleInterrupted = { time: { busy: 1, idle: 2 }, outcome: 'interrupted' };

    it('should tell a job that was cut off by a restart to continue, once', async () => {
      jobs.push(makeJob());
      client.session.get.mockResolvedValue(idleInterrupted);

      startMonitor({ pollInterval: 60, resumeGrace: 60_000 });
      await waitFor(() => client.session.prompt.mock.calls.length === 1);
      await waitFor(() => client.session.get.mock.calls.length >= 4);

      expect(client.session.prompt).toHaveBeenCalledTimes(1);
      expect(client.session.prompt).toHaveBeenCalledWith({ sessionID: 'ses_a', text: RESTART_PROMPT });
      expect(statusOf('job-a')).toBe('running');
      expect(jobs[0].restartResumedAt).toEqual(expect.any(String));
      expect(eventsOfType('failed')).toEqual([]);
    });

    it('should resume a job whose turn was cut off without recording an outcome', async () => {
      // A server killed mid-turn leaves the session "busy" forever: busy with
      // no idle time and no outcome, last written before this process started.
      jobs.push(makeJob());
      client.session.get.mockResolvedValue({ time: { busy: 1, updated: 2 } });

      startMonitor({ pollInterval: 60, resumeGrace: 60_000 });
      await waitFor(() => client.session.prompt.mock.calls.length === 1);

      expect(client.session.prompt).toHaveBeenCalledWith({ sessionID: 'ses_a', text: RESTART_PROMPT });
      expect(statusOf('job-a')).toBe('running');
      expect(eventsOfType('failed')).toEqual([]);
    });

    it('should let the resumed job finish normally', async () => {
      jobs.push(makeJob());
      client.session.get.mockResolvedValue(idleInterrupted);

      startMonitor();
      await waitFor(() => client.session.prompt.mock.calls.length === 1);

      channel.push('session.execution.started', { sessionID: 'ses_a' });
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(statusOf('job-a')).toBe('completed');
    });

    it('should fail a resumed job that never starts again', async () => {
      jobs.push(makeJob());
      client.session.get.mockResolvedValue(idleInterrupted);

      startMonitor({ pollInterval: 60, resumeGrace: 50 });
      await waitFor(() => eventsOfType('failed').length === 1);

      expect(client.session.prompt).toHaveBeenCalledTimes(1);
      expect(statusOf('job-a')).toBe('failed');
      expect(jobs[0].failureReason).toBe('its session was interrupted');
    });

    it('should resume a job again after another restart', async () => {
      // Resumed by the monitor of a previous server run.
      jobs.push(makeJob({ restartResumedAt: new Date(Date.now() - 30_000).toISOString() }));
      client.session.get.mockResolvedValue(idleInterrupted);

      startMonitor();
      await waitFor(() => client.session.prompt.mock.calls.length === 1);

      expect(statusOf('job-a')).toBe('running');
    });

    it('should retry telling the job to continue when the prompt fails', async () => {
      jobs.push(makeJob());
      client.session.get.mockResolvedValue(idleInterrupted);
      client.session.prompt.mockRejectedValueOnce(new Error('server still starting'));

      startMonitor({ pollInterval: 60 });
      await waitFor(() => client.session.prompt.mock.calls.length === 2);

      expect(statusOf('job-a')).toBe('running');
      expect(jobs[0].restartResumedAt).toEqual(expect.any(String));
    });

    it('should resume a job whose shutdown interruption it saw itself', async () => {
      jobs.push(makeJob());
      client.session.get.mockResolvedValue({ time: {} });
      startMonitor({ pollInterval: 60 });
      await waitFor(() => client.session.get.mock.calls.length >= 1);

      channel.push('session.execution.interrupted', { sessionID: 'ses_a', reason: 'shutdown' });
      client.session.get.mockResolvedValue(idleInterrupted);
      await waitFor(() => client.session.prompt.mock.calls.length === 1);

      expect(client.session.prompt).toHaveBeenCalledWith({ sessionID: 'ses_a', text: RESTART_PROMPT });
      expect(statusOf('job-a')).toBe('running');
    });

    it('should fail a job found interrupted later without a shutdown, instead of resuming it', async () => {
      jobs.push(makeJob());
      client.session.get.mockResolvedValue({ time: {} });
      startMonitor({ pollInterval: 60 });
      await waitFor(() => client.session.get.mock.calls.length >= 2);

      // Interrupted while the server kept running, and the event was missed.
      client.session.get.mockResolvedValue(idleInterrupted);
      await waitFor(() => eventsOfType('failed').length === 1);

      expect(client.session.prompt).not.toHaveBeenCalled();
      expect(statusOf('job-a')).toBe('failed');
    });
  });

  describe('background work', () => {
    afterEach(() => {
      clearBackgroundWork('/wt/job-a');
    });

    it('should not take an idle turn for the end of the job while its own background work runs', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      // Written by the plugin instance in the job's worktree when the session goes idle.
      runInProject('/wt/job-a', () => recordBackgroundWork('ses_a', 1));
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await settle();

      expect(statusOf('job-a')).toBe('running');
      expect(emitted).toEqual([]);

      // The background work finished and woke the session for a last turn.
      runInProject('/wt/job-a', () => recordBackgroundWork('ses_a', 0));
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);
    });

    it('should take an agent that reported completion at its word despite background work', async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      // A dev server left running must not keep the job open forever.
      runInProject('/wt/job-a', () => recordBackgroundWork('ses_a', 1));
      reportsByJob.set('job-a', {
        jobId: 'job-a',
        jobName: 'job-a',
        status: 'completed',
        message: 'done',
        timestamp: '2026-01-01T00:00:00.000Z',
      });
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);
    });

    it("should not be held up by another job's background work", async () => {
      jobs.push(makeJob());
      startMonitor();
      await settle();

      runInProject('/wt/job-b', () => recordBackgroundWork('ses_b', 2));
      try {
        channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
        await waitFor(() => eventsOfType('complete').length === 1);
      } finally {
        clearBackgroundWork('/wt/job-b');
      }
    });
  });

  describe('uncommitted changes', () => {
    it('should ask a job once to commit work it left uncommitted, and keep it running', async () => {
      jobs.push(makeJob());
      uncommitted = ['src/new.ts', 'README.md'];
      startMonitor();
      await settle();

      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => client.session.prompt.mock.calls.length === 1);
      await settle();

      expect(client.session.prompt).toHaveBeenCalledWith({
        sessionID: 'ses_a',
        text: buildCommitPrompt(['src/new.ts', 'README.md']),
      });
      expect(findUncommittedSpy).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: '/wt/job-a' }));
      expect(statusOf('job-a')).toBe('running');
      expect(jobs[0].commitPromptedAt).toEqual(expect.any(String));
      expect(eventsOfType('complete')).toEqual([]);
    });

    it('should complete the job cleanly once it committed', async () => {
      jobs.push(makeJob());
      uncommitted = ['src/new.ts'];
      startMonitor();
      await settle();

      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => client.session.prompt.mock.calls.length === 1);

      // The job's next turn: it commits, and the turn ends.
      uncommitted = [];
      channel.push('session.execution.started', { sessionID: 'ses_a' });
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(statusOf('job-a')).toBe('completed');
      expect(jobs[0].uncommittedChanges).toBeUndefined();
      expect(eventsOfType('needs_review')).toEqual([]);
    });

    it('should complete a job that still has uncommitted changes after being asked, flagged for review', async () => {
      jobs.push(makeJob());
      uncommitted = ['src/new.ts'];
      startMonitor();
      await settle();

      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => client.session.prompt.mock.calls.length === 1);

      // The job's next turn ends and the file is still not committed.
      channel.push('session.execution.started', { sessionID: 'ses_a' });
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('needs_review').length === 1);

      expect(client.session.prompt).toHaveBeenCalledTimes(1);
      expect(statusOf('job-a')).toBe('completed');
      expect(jobs[0].uncommittedChanges).toEqual(['src/new.ts']);
      expect(eventsOfType('complete')[0].job).toMatchObject({ uncommittedChanges: ['src/new.ts'] });
      expect(eventsOfType('needs_review')[0].job).toMatchObject({
        status: 'completed',
        uncommittedChanges: ['src/new.ts'],
      });
    });

    it('should not take late signs of the old turn for the end of the turn it just asked for', async () => {
      jobs.push(makeJob());
      uncommitted = ['src/new.ts'];
      // The session's recorded outcome has not moved on yet either.
      client.session.get.mockResolvedValue({ time: { busy: 1, idle: 2 }, outcome: 'succeeded' });
      startMonitor({ pollInterval: 60, resumeGrace: 60_000 });
      await waitFor(() => client.session.prompt.mock.calls.length === 1);

      // One finished turn is announced by several events, and by the reconcile
      // pass. All of them still describe the turn before the commit prompt.
      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      channel.push('session.status', { sessionID: 'ses_a', status: { type: 'idle' } });
      channel.push('session.idle', { sessionID: 'ses_a' });
      await waitFor(() => client.session.get.mock.calls.length >= 4);

      expect(client.session.prompt).toHaveBeenCalledTimes(1);
      expect(statusOf('job-a')).toBe('running');
      expect(eventsOfType('complete')).toEqual([]);
    });

    it('should take an idle session at face value again when the asked-for turn never starts', async () => {
      jobs.push(makeJob());
      uncommitted = ['src/new.ts'];
      client.session.get.mockResolvedValue({ time: { busy: 1, idle: 2 }, outcome: 'succeeded' });
      startMonitor({ pollInterval: 60, resumeGrace: 50 });

      await waitFor(() => eventsOfType('needs_review').length === 1);

      expect(client.session.prompt).toHaveBeenCalledTimes(1);
      expect(statusOf('job-a')).toBe('completed');
      expect(jobs[0].uncommittedChanges).toEqual(['src/new.ts']);
    });

    it('should not ask when autoCommit is off, and flag the job right away', async () => {
      vi.spyOn(configMod, 'loadConfig').mockImplementation(async () => ({
        pollInterval: 10000,
        worktreeBasePath: '/tmp/mc-worktrees',
        autoCommit: false,
        defaultPermissionPolicy: policy,
      }));
      jobs.push(makeJob());
      uncommitted = ['notes.md'];
      startMonitor();
      await settle();

      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('needs_review').length === 1);

      expect(client.session.prompt).not.toHaveBeenCalled();
      expect(jobs[0].uncommittedChanges).toEqual(['notes.md']);
    });

    it('should complete the job, flagged, when it cannot be asked', async () => {
      jobs.push(makeJob());
      uncommitted = ['src/new.ts'];
      client.session.prompt.mockRejectedValue(new Error('session busy'));
      startMonitor();
      await settle();

      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('needs_review').length === 1);

      expect(jobs[0].uncommittedChanges).toEqual(['src/new.ts']);
    });

    it('should complete the job when its worktree cannot be inspected', async () => {
      jobs.push(makeJob());
      findUncommittedSpy.mockRejectedValue(new Error('Cannot check worktree status at /wt/job-a'));
      startMonitor();
      await settle();

      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(jobs[0].uncommittedChanges).toBeUndefined();
    });
  });

  describe('reconnect', () => {
    it('should resubscribe when the stream ends and keep handling events', async () => {
      const second = new EventChannel();
      install(createFakeClient([channel, second]));
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.end();
      await waitFor(() => client.event.subscribe.mock.calls.length === 2);

      second.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);

      expect(statusOf('job-a')).toBe('completed');
    });

    it('should resubscribe when the stream errors', async () => {
      const second = new EventChannel();
      install(createFakeClient([channel, second]));
      jobs.push(makeJob());
      startMonitor();
      await settle();

      channel.fail(new Error('socket hang up'));
      await waitFor(() => client.event.subscribe.mock.calls.length === 2);

      second.push('session.execution.failed', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('failed').length === 1);

      expect(statusOf('job-a')).toBe('failed');
    });

    it('should resubscribe when subscribing itself throws', async () => {
      const fake = createFakeClient([channel]);
      fake.event.subscribe.mockImplementationOnce(() => {
        throw new Error('server restarting');
      });
      install(fake);
      jobs.push(makeJob());

      startMonitor();
      await waitFor(() => client.event.subscribe.mock.calls.length === 2);

      channel.push('session.execution.succeeded', { sessionID: 'ses_a' });
      await waitFor(() => eventsOfType('complete').length === 1);
    });

    it('should not resubscribe after stop', async () => {
      const started = startMonitor();
      await settle();

      started.stop();
      channel.end();
      await settle(300);

      expect(client.event.subscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('activity', () => {
    it('should accumulate tool activity for the job', async () => {
      jobs.push(makeJob());
      const started = startMonitor();
      await settle();

      channel.push('session.tool.called', { sessionID: 'ses_a', id: 't1', input: { command: 'bun test' } });
      channel.push('session.tool.success', { sessionID: 'ses_a', id: 't1' });
      await waitFor(() => started.getEventAccumulator('job-a')?.eventCount === 2);

      expect(started.getEventAccumulator('job-a')).toMatchObject({
        currentTool: 'streaming',
        eventCount: 2,
        filesEdited: [],
      });
      expect(eventsOfType('question')).toEqual([]);
    });

    it('should attribute file changes to the job by worktree path', async () => {
      jobs.push(makeJob(), makeJob({ id: 'job-b', name: 'job-b', sessionID: 'ses_b', worktreePath: '/wt/job-b' }));
      const started = startMonitor();
      await settle();

      channel.push('filesystem.changed', { file: '/wt/job-b/src/new.ts', event: 'add' });
      channel.push('filesystem.changed', { file: '/wt/job-b/src/gone.ts', event: 'unlink' });
      channel.push('filesystem.changed', { file: '/somewhere/else.ts', event: 'change' });
      await waitFor(() => started.getEventAccumulator('job-b')?.eventCount === 1);
      await settle();

      expect(started.getEventAccumulator('job-b')).toMatchObject({
        filesEdited: ['/wt/job-b/src/new.ts'],
        currentFile: '/wt/job-b/src/new.ts',
        eventCount: 1,
      });
      expect(started.getEventAccumulator('job-a')).toBeUndefined();
    });

    it('should announce a change only when the visible activity changes', async () => {
      const emitChanged = vi.spyOn(rpcEvents, 'emitChanged').mockImplementation(() => {});
      jobs.push(makeJob());
      const started = startMonitor();
      await settle();
      emitChanged.mockClear();

      channel.push('session.tool.called', { sessionID: 'ses_a', id: 't1', input: { command: 'bun test' } });
      await waitFor(() => started.getEventAccumulator('job-a')?.eventCount === 1);
      const afterFirst = emitChanged.mock.calls.filter(([reason]) => reason === 'activity').length;
      expect(afterFirst).toBe(1);

      // Same tool state again: the accumulator counts it, clients are not told.
      channel.push('session.tool.success', { sessionID: 'ses_a', id: 't1' });
      await waitFor(() => started.getEventAccumulator('job-a')?.eventCount === 2);
      expect(emitChanged.mock.calls.filter(([reason]) => reason === 'activity').length).toBe(afterFirst);
    });

    it('should return undefined for a job with no activity', () => {
      expect(new JobMonitor().getEventAccumulator('nope')).toBeUndefined();
    });
  });
});
