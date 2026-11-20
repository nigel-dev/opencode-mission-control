import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  assertToolPermission,
  captureJobSession,
  clearBackgroundWork,
  getJobOutcome,
  getJobUsage,
  getRuntimeClient,
  hasBackgroundWork,
  hasRuntimeClient,
  isJobSession,
  isSessionMissing,
  jobSessionTitle,
  parseModel,
  promptJobSession,
  recordBackgroundWork,
  registerJobSession,
  removeJobSession,
  setRuntimeClient,
  startJobSession,
  stopJobSession,
  type RuntimeClient,
} from '../../src/lib/job-runtime';
import { runInProject } from '../../src/lib/project-context';

function createFakeClient() {
  const session = {
    create: vi.fn(async (_input: unknown) => ({ id: 'ses_new' })),
    prompt: vi.fn(async (_input: unknown) => undefined),
    interrupt: vi.fn(async (_input: unknown) => undefined),
    remove: vi.fn(async (_input: unknown) => undefined),
    get: vi.fn(async (_input: unknown): Promise<Record<string, unknown>> => ({ id: 'ses_new' })),
    context: vi.fn(async (_input: unknown): Promise<unknown[]> => []),
  };
  const permission = {
    assert: vi.fn(async (_input: unknown) => undefined),
  };
  return { session, permission };
}

type FakeClient = ReturnType<typeof createFakeClient>;

function install(client: FakeClient): void {
  setRuntimeClient(client as unknown as RuntimeClient);
}

describe('job-runtime', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = createFakeClient();
    install(client);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    setRuntimeClient(null);
    vi.restoreAllMocks();
  });

  describe('runtime client', () => {
    it('returns the installed client', () => {
      expect(hasRuntimeClient()).toBe(true);
      expect(getRuntimeClient()).toBe(client as unknown as RuntimeClient);
    });

    it('throws a clear error when no client is installed', () => {
      setRuntimeClient(null);

      expect(hasRuntimeClient()).toBe(false);
      expect(() => getRuntimeClient()).toThrow('Mission Control is not initialized for this project');
    });

    it('keeps one client per project directory', () => {
      const other = createFakeClient();

      runInProject('/projects/other', () => {
        expect(hasRuntimeClient()).toBe(false);
        install(other);
        expect(getRuntimeClient()).toBe(other as unknown as RuntimeClient);
      });

      expect(getRuntimeClient()).toBe(client as unknown as RuntimeClient);

      runInProject('/projects/other', () => {
        setRuntimeClient(null);
        expect(hasRuntimeClient()).toBe(false);
      });
      expect(hasRuntimeClient()).toBe(true);
    });
  });

  describe('parseModel', () => {
    it('parses provider/model', () => {
      expect(parseModel('anthropic/claude-sonnet-4')).toEqual({
        providerID: 'anthropic',
        id: 'claude-sonnet-4',
      });
    });

    it('parses a variant', () => {
      expect(parseModel('openai/gpt-5#high')).toEqual({
        providerID: 'openai',
        id: 'gpt-5',
        variant: 'high',
      });
    });

    it('keeps slashes in the model id', () => {
      expect(parseModel('openrouter/anthropic/claude-sonnet-4')).toEqual({
        providerID: 'openrouter',
        id: 'anthropic/claude-sonnet-4',
      });
    });

    it('returns undefined for missing or malformed input', () => {
      expect(parseModel(undefined)).toBeUndefined();
      expect(parseModel('')).toBeUndefined();
      expect(parseModel('no-slash')).toBeUndefined();
      expect(parseModel('/model')).toBeUndefined();
      expect(parseModel('provider/')).toBeUndefined();
    });
  });

  describe('startJobSession', () => {
    it('creates the session in the worktree and sends the prompt', async () => {
      const sessionID = await startJobSession({
        jobId: 'job-1',
        jobName: 'feature-auth',
        worktreePath: '/tmp/wt/feature-auth',
        prompt: 'Add OAuth',
        agent: 'build',
        model: { providerID: 'anthropic', id: 'claude-sonnet-4' },
        planId: 'plan-1',
        launchSessionID: 'ses_launcher',
      });

      expect(sessionID).toBe('ses_new');
      expect(client.session.create).toHaveBeenCalledTimes(1);
      expect(client.session.create).toHaveBeenCalledWith({
        location: { directory: '/tmp/wt/feature-auth' },
        title: '[MC] feature-auth',
        agent: 'build',
        model: { providerID: 'anthropic', id: 'claude-sonnet-4' },
        metadata: {
          missionControl: {
            jobId: 'job-1',
            jobName: 'feature-auth',
            planId: 'plan-1',
            launchSessionID: 'ses_launcher',
          },
        },
      });
      expect(client.session.prompt).toHaveBeenCalledWith({ sessionID: 'ses_new', text: 'Add OAuth' });
    });

    it('omits plan and launch session metadata when not given', async () => {
      await startJobSession({
        jobId: 'job-1',
        jobName: 'solo',
        worktreePath: '/tmp/wt/solo',
        prompt: 'Do it',
      });

      expect(client.session.create).toHaveBeenCalledWith({
        location: { directory: '/tmp/wt/solo' },
        title: '[MC] solo',
        agent: undefined,
        model: undefined,
        metadata: { missionControl: { jobId: 'job-1', jobName: 'solo' } },
      });
    });

    it('registers the new session as a job session', async () => {
      expect(isJobSession('ses_new')).toBe(false);

      await startJobSession({ jobId: 'j', jobName: 'n', worktreePath: '/tmp/wt/n', prompt: 'p' });

      expect(isJobSession('ses_new')).toBe(true);
    });

    it('removes the session and throws when the prompt fails', async () => {
      client.session.prompt.mockRejectedValue(new Error('model unavailable'));

      await expect(
        startJobSession({ jobId: 'j', jobName: 'n', worktreePath: '/tmp/wt/n', prompt: 'p' }),
      ).rejects.toThrow('Failed to send prompt to job session: model unavailable');

      expect(client.session.remove).toHaveBeenCalledWith({ sessionID: 'ses_new' });
    });

    it('still reports the prompt failure when removing the session also fails', async () => {
      client.session.prompt.mockRejectedValue(new Error('model unavailable'));
      client.session.remove.mockRejectedValue(new Error('remove failed'));

      await expect(
        startJobSession({ jobId: 'j', jobName: 'n', worktreePath: '/tmp/wt/n', prompt: 'p' }),
      ).rejects.toThrow('Failed to send prompt to job session: model unavailable');
    });

    it('propagates a failure to create the session without prompting', async () => {
      client.session.create.mockRejectedValue(new Error('no such agent'));

      await expect(
        startJobSession({ jobId: 'j', jobName: 'n', worktreePath: '/tmp/wt/n', prompt: 'p' }),
      ).rejects.toThrow('no such agent');

      expect(client.session.prompt).not.toHaveBeenCalled();
      expect(client.session.remove).not.toHaveBeenCalled();
    });
  });

  describe('job session registry', () => {
    it('remembers registered sessions per project', () => {
      registerJobSession('ses_a');

      expect(isJobSession('ses_a')).toBe(true);
      expect(isJobSession('ses_b')).toBe(false);
      runInProject('/projects/other', () => {
        expect(isJobSession('ses_a')).toBe(false);
      });
    });

    it('forgets sessions when the client is cleared', () => {
      registerJobSession('ses_a');

      setRuntimeClient(null);

      expect(isJobSession('ses_a')).toBe(false);
    });
  });

  describe('session control', () => {
    it('promptJobSession sends a follow-up prompt', async () => {
      await promptJobSession('ses_1', 'continue');

      expect(client.session.prompt).toHaveBeenCalledWith({ sessionID: 'ses_1', text: 'continue' });
    });

    it('stopJobSession interrupts without resuming queued work', async () => {
      await stopJobSession('ses_1');

      expect(client.session.interrupt).toHaveBeenCalledWith({ sessionID: 'ses_1', resume: false });
    });

    it('removeJobSession deletes the session', async () => {
      await removeJobSession('ses_1');

      expect(client.session.remove).toHaveBeenCalledWith({ sessionID: 'ses_1' });
    });

    it('propagates runtime errors', async () => {
      client.session.interrupt.mockRejectedValue(new Error('session not found'));

      await expect(stopJobSession('ses_missing')).rejects.toThrow('session not found');
    });
  });

  describe('getJobOutcome', () => {
    it('reports running when the session has no outcome yet', async () => {
      client.session.get.mockResolvedValue({ id: 'ses_1', time: {} });

      expect(await getJobOutcome('ses_1')).toBe('running');
      expect(client.session.get).toHaveBeenCalledWith({ sessionID: 'ses_1' });
    });

    it('reports running while a follow-up turn is busy, despite the previous outcome', async () => {
      client.session.get.mockResolvedValue({
        id: 'ses_1',
        outcome: 'succeeded',
        time: { busy: 200, idle: 100, updated: 250 },
      });

      // The server process started before the turn's last write.
      expect(await getJobOutcome('ses_1', 150)).toBe('running');
    });

    it('reports interrupted for a busy turn last written before this server process started', async () => {
      // The server was killed mid-turn: the session never recorded an outcome.
      client.session.get.mockResolvedValue({
        id: 'ses_1',
        time: { busy: 200, updated: 300 },
      });

      expect(await getJobOutcome('ses_1', 1_000)).toBe('interrupted');
    });

    it('compares against the real process start time by default', async () => {
      const now = Date.now();
      client.session.get.mockResolvedValue({ id: 'ses_1', time: { busy: now, updated: now } });
      expect(await getJobOutcome('ses_1')).toBe('running');

      client.session.get.mockResolvedValue({ id: 'ses_1', time: { busy: 1, updated: 2 } });
      expect(await getJobOutcome('ses_1')).toBe('interrupted');
    });

    it.each(['succeeded', 'failed', 'interrupted'] as const)('reports %s', async (outcome) => {
      client.session.get.mockResolvedValue({ id: 'ses_1', time: {}, outcome });

      expect(await getJobOutcome('ses_1')).toBe(outcome);
    });
  });

  describe('getJobUsage', () => {
    it('sums cached tokens into input and reasoning into output', async () => {
      client.session.get.mockResolvedValue({
        id: 'ses_1',
        cost: 0.42,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 30 } },
      });

      expect(await getJobUsage('ses_1')).toEqual({
        cost: 0.42,
        inputTokens: 1130,
        outputTokens: 25,
      });
    });
  });

  describe('captureJobSession', () => {
    const transcript = [
      { type: 'user', text: 'Add OAuth' },
      {
        type: 'assistant',
        content: [
          { type: 'text', text: 'Looking at the code.\nFound the entry point.' },
          { type: 'tool', name: 'bash', state: { status: 'completed', input: { command: 'bun test' } } },
          { type: 'tool', name: 'todo', state: { status: 'running', input: {} } },
          { type: 'reasoning', text: 'hidden' },
        ],
      },
      { type: 'system', text: 'ignored' },
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        error: { message: 'rate limited' },
      },
    ];

    it('renders user prompts, assistant text, tool calls and errors', async () => {
      client.session.context.mockResolvedValue(transcript);

      const output = await captureJobSession('ses_1');

      expect(client.session.context).toHaveBeenCalledWith({ sessionID: 'ses_1' });
      expect(output).toBe(
        [
          '> Add OAuth',
          'Looking at the code.',
          'Found the entry point.',
          '[bash bun test] completed',
          '[todo] running',
          'Done.',
          '[error] rate limited',
        ].join('\n'),
      );
    });

    it('returns only the last N lines', async () => {
      client.session.context.mockResolvedValue(transcript);

      const output = await captureJobSession('ses_1', 2);

      expect(output).toBe('Done.\n[error] rate limited');
    });

    it('truncates long tool input', async () => {
      const longCommand = 'x'.repeat(200);
      client.session.context.mockResolvedValue([
        {
          type: 'assistant',
          content: [
            { type: 'tool', name: 'bash', state: { status: 'completed', input: { command: longCommand } } },
          ],
        },
      ]);

      const output = await captureJobSession('ses_1');

      expect(output).toBe(`[bash ${'x'.repeat(117)}...] completed`);
    });

    it('returns an empty string for an empty session', async () => {
      client.session.context.mockResolvedValue([]);

      expect(await captureJobSession('ses_1')).toBe('');
    });
  });

  describe('assertToolPermission', () => {
    it("evaluates the calling session's permission rules for the action and resources", async () => {
      await assertToolPermission(
        { sessionID: 'ses_caller', agent: 'build', messageID: 'msg_1', id: 'call_1' },
        'shell',
        ['bun install', 'make setup'],
      );

      expect(client.permission.assert).toHaveBeenCalledTimes(1);
      expect(client.permission.assert).toHaveBeenCalledWith({
        sessionID: 'ses_caller',
        agent: 'build',
        action: 'shell',
        resources: ['bun install', 'make setup'],
        source: { type: 'tool', messageID: 'msg_1', id: 'call_1' },
      });
    });

    it('leaves out the optional parts the tool context does not carry', async () => {
      await assertToolPermission({ sessionID: 'ses_caller' }, 'mission-control.pr', ['mc/feature']);

      expect(client.permission.assert).toHaveBeenCalledWith({
        sessionID: 'ses_caller',
        action: 'mission-control.pr',
        resources: ['mc/feature'],
      });
    });

    it('asks nothing for a call without a session (the dashboard, slash commands)', async () => {
      await assertToolPermission(undefined, 'shell', ['bun install']);
      await assertToolPermission({}, 'shell', ['bun install']);

      expect(client.permission.assert).not.toHaveBeenCalled();
    });

    it('lets a denial through unchanged, so the host can end the step', async () => {
      const denial = new Error('The user rejected permission to use this specific tool call.');
      client.permission.assert.mockRejectedValue(denial);

      await expect(assertToolPermission({ sessionID: 'ses_caller' }, 'shell', ['rm -rf ~'])).rejects.toBe(denial);
    });

    it('fails closed when the project has no runtime client', async () => {
      setRuntimeClient(null);

      await expect(assertToolPermission({ sessionID: 'ses_caller' }, 'shell', ['ls'])).rejects.toThrow(
        'not initialized',
      );
    });
  });

  describe('background work', () => {
    const WORKTREE = '/tmp/mc-runtime-worktree';

    afterEach(() => {
      clearBackgroundWork(WORKTREE);
    });

    it('is recorded by the worktree instance and read by path and session', () => {
      runInProject(WORKTREE, () => recordBackgroundWork('ses_job', 2));

      expect(hasBackgroundWork(WORKTREE, 'ses_job')).toBe(true);
      expect(hasBackgroundWork(WORKTREE, 'ses_other')).toBe(false);
      expect(hasBackgroundWork('/tmp/mc-runtime-other-worktree', 'ses_job')).toBe(false);
    });

    it('is cleared when the session goes idle with nothing left running', () => {
      runInProject(WORKTREE, () => recordBackgroundWork('ses_job', 1));
      runInProject(WORKTREE, () => recordBackgroundWork('ses_job', 0));

      expect(hasBackgroundWork(WORKTREE, 'ses_job')).toBe(false);
    });

    it('is forgotten when the job is cleaned up', () => {
      runInProject(WORKTREE, () => recordBackgroundWork('ses_job', 1));
      clearBackgroundWork(WORKTREE);

      expect(hasBackgroundWork(WORKTREE, 'ses_job')).toBe(false);
    });

    it('ignores work recorded by a previous server process', () => {
      // The work died with that process; only a marker from this one counts.
      runInProject(WORKTREE, () => recordBackgroundWork('ses_job', 1));
      const uptime = vi.spyOn(process, 'uptime').mockReturnValue(process.uptime() - 60);

      expect(hasBackgroundWork(WORKTREE, 'ses_job')).toBe(false);
      uptime.mockRestore();
      expect(hasBackgroundWork(WORKTREE, 'ses_job')).toBe(true);
    });
  });

  describe('isSessionMissing', () => {
    it('recognizes the not-found error of the session API', () => {
      expect(isSessionMissing({ _tag: 'SessionNotFoundError', sessionID: 'ses_x' })).toBe(true);
      expect(isSessionMissing(Object.assign(new Error('gone'), { name: 'SessionNotFoundError' }))).toBe(true);
      expect(isSessionMissing(new Error('Session ses_x not found'))).toBe(true);
    });

    it('does not take other failures for a missing session', () => {
      expect(isSessionMissing(new Error('connection reset'))).toBe(false);
      expect(isSessionMissing({ _tag: 'MessageNotFoundError' })).toBe(false);
      expect(isSessionMissing(new Error('model not found'))).toBe(false);
      expect(isSessionMissing(undefined)).toBe(false);
      expect(isSessionMissing('session not found')).toBe(false);
    });
  });

  describe('jobSessionTitle', () => {
    it('prefixes the job name', () => {
      expect(jobSessionTitle('feature-auth')).toBe('[MC] feature-auth');
    });
  });
});
