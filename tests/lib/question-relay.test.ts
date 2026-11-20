import { mock, describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  buildTaskSummary,
  buildQuestionPrompt,
  QuestionRelay,
  addPendingQuestion,
  removePendingQuestion,
  getPendingQuestionsForJob,
  clearPendingQuestionsForJob,
  type PendingQuestion,
  type PermissionRequest,
} from '../../src/lib/question-relay';
import { setRuntimeClient, type RuntimeClient } from '../../src/lib/job-runtime';
import type { Job } from '../../src/lib/job-state';
import { clearSharedNotifyCallback, setSharedNotifyCallback } from '../../src/lib/notify';
import { setRpcEventEmitter } from '../../src/lib/rpc-events';

describe('buildTaskSummary', () => {
  it('should return the full prompt if under 120 chars', () => {
    const prompt = 'Fix the login bug';
    expect(buildTaskSummary(prompt)).toBe(prompt);
  });

  it('should truncate and add ellipsis if over 120 chars', () => {
    const prompt = 'A'.repeat(150);
    const result = buildTaskSummary(prompt);
    expect(result.length).toBe(120);
    expect(result.endsWith('...')).toBe(true);
  });

  it('should handle exactly 120 chars without truncation', () => {
    const prompt = 'A'.repeat(120);
    expect(buildTaskSummary(prompt)).toBe(prompt);
  });
});

describe('buildQuestionPrompt', () => {
  it('should include job name and task summary', () => {
    const context = {
      jobName: 'fix-auth',
      taskSummary: 'Fix the authentication bug',
    };

    const prompt = buildQuestionPrompt(context);

    expect(prompt).toContain('fix-auth');
    expect(prompt).toContain('Fix the authentication bug');
  });

  it('should include current file when provided', () => {
    const context = {
      jobName: 'fix-auth',
      taskSummary: 'Fix the authentication bug',
      currentFile: 'src/auth.ts',
    };

    const prompt = buildQuestionPrompt(context);

    expect(prompt).toContain('src/auth.ts');
  });

  it('should include permission request details', () => {
    const context = {
      jobName: 'fix-auth',
      taskSummary: 'Fix the authentication bug',
      permissionRequest: {
        id: 'perm-1',
        type: 'file_operation' as const,
        path: '/etc/config',
        description: 'Edit system config',
      },
    };

    const prompt = buildQuestionPrompt(context);

    expect(prompt).toContain('file_operation');
    expect(prompt).toContain('/etc/config');
    expect(prompt).toContain('Edit system config');
  });

  it('should include all options', () => {
    const context = {
      jobName: 'fix-auth',
      taskSummary: 'Fix the authentication bug',
    };

    const prompt = buildQuestionPrompt(context);

    expect(prompt).toContain('mc_attach(name: "fix-auth")');
    expect(prompt).toContain('denied');
  });
});

describe('QuestionRelay', () => {
  describe('configuration', () => {
    it('should accept custom timeout configuration', () => {
      const customRelay = new QuestionRelay({
        autoResponseTimeoutMs: 60000,
        defaultResponse: 'custom response',
      });

      expect(customRelay).toBeDefined();
    });
  });
});

describe('QuestionRelay with the runtime client', () => {
  const job: Job = {
    id: 'job-rt',
    name: 'Runtime Job',
    worktreePath: '/home/user/project',
    branch: 'mc/runtime-job',
    status: 'running',
    prompt: 'Fix the authentication bug',
    createdAt: new Date().toISOString(),
    launchSessionID: 'ses_launcher',
    sessionID: 'ses_job',
  };

  let relay: QuestionRelay;
  let reply: ReturnType<typeof mock>;
  let attention: ReturnType<typeof mock>;
  let notify: ReturnType<typeof mock>;

  beforeEach(() => {
    reply = mock(async () => undefined);
    attention = mock(async () => undefined);
    notify = mock(() => undefined);
    setRuntimeClient({ permission: { reply } } as unknown as RuntimeClient);
    setRpcEventEmitter({
      changed: async () => undefined,
      attention,
      open: async () => undefined,
      output: async () => undefined,
    });
    setSharedNotifyCallback(notify);
    relay = new QuestionRelay({ autoResponseTimeoutMs: 30, defaultResponse: 'nobody answered' });
    spyOn(console, 'warn').mockImplementation(() => {});
    spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    setRuntimeClient(null);
    setRpcEventEmitter(null);
    clearSharedNotifyCallback();
    mock.restore();
  });

  // The policy decided "ask-user" before the relay is called. The relay used
  // to second-guess that and approve these on the spot.
  it.each<[string, PermissionRequest]>([
    ['an MCP tool', { id: 'perm-1', type: 'mcp', description: 'Execute MCP tool' }],
    [
      'a file edit inside the worktree',
      { id: 'perm-1', type: 'file_operation', path: '/home/user/project/src/file.ts', description: 'Edit file' },
    ],
    ['a shell command', { id: 'perm-1', type: 'shell_command', command: 'bun add left-pad', description: 'Run: bun add left-pad' }],
    ['a network request', { id: 'perm-1', type: 'network', description: 'Fetch https://example.com' }],
  ])('never approves %s that the policy sent to the user', async (_label, permission) => {
    await relay.handlePermissionRequest(job, permission);

    expect(reply).not.toHaveBeenCalled();
  });

  it('relays the request to the launching session', async () => {
    await relay.handlePermissionRequest(
      job,
      { id: 'perm-2', type: 'shell_command', command: 'bun add left-pad', description: 'Run: bun add left-pad' },
      'src/index.ts',
    );

    expect(notify).toHaveBeenCalledTimes(1);
    const [message, sessionID] = notify.mock.calls[0];
    expect(sessionID).toBe('ses_launcher');
    expect(message).toContain('Runtime Job');
    expect(message).toContain('Command: bun add left-pad');
    expect(message).toContain('Current file: src/index.ts');
  });

  it('tells connected clients about the request', async () => {
    await relay.handlePermissionRequest(job, {
      id: 'perm-3',
      type: 'network',
      description: 'Fetch https://example.com',
    });

    expect(attention).toHaveBeenCalledTimes(1);
    expect(attention).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'question',
        jobName: 'Runtime Job',
        sessionID: 'ses_job',
        message: expect.stringContaining('Fetch https://example.com'),
      }),
    );
  });

  it('still tells clients when the job has no launching session', async () => {
    // A job launched from the TUI dashboard: there is nobody to relay to.
    // (The denial on timeout is armed by the permission gate in the job's own
    // location; see job-permissions.)
    const dashboardJob = { ...job, launchSessionID: undefined };

    await relay.handlePermissionRequest(dashboardJob, {
      id: 'perm-4',
      type: 'network',
      description: 'Fetch https://example.com',
    });

    expect(notify).not.toHaveBeenCalled();
    expect(attention).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it('does nothing for a job without a session', async () => {
    await relay.handlePermissionRequest({ ...job, sessionID: undefined }, {
      id: 'perm-5',
      type: 'network',
      description: 'Fetch https://example.com',
    });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(reply).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(attention).not.toHaveBeenCalled();
  });

  it('respondToPermission should approve with the given message', async () => {
    await relay.respondToPermission(job, 'perm-2', true, 'Auto-approved by permission policy: test');

    expect(reply).toHaveBeenCalledWith({
      sessionID: 'ses_job',
      requestID: 'perm-2',
      decision: 'once',
      message: 'Auto-approved by permission policy: test',
    });
  });

  it('respondToPermission should reject when not approved', async () => {
    await relay.respondToPermission(job, 'perm-3', false);

    expect(reply).toHaveBeenCalledWith({
      sessionID: 'ses_job',
      requestID: 'perm-3',
      decision: 'reject',
      message: 'Denied',
    });
  });

  it('respondToPermission should do nothing for a job without a session', async () => {
    await relay.respondToPermission({ ...job, sessionID: undefined }, 'perm-4', true);

    expect(reply).not.toHaveBeenCalled();
  });

  it('respondToPermission should surface reply failures', async () => {
    reply.mockImplementation(async () => {
      throw new Error('session not found');
    });

    await expect(relay.respondToPermission(job, 'perm-5', true)).rejects.toThrow('session not found');
  });
});

describe('pending questions', () => {
  const question: PendingQuestion = {
    jobId: 'job-q',
    jobName: 'Question Job',
    taskSummary: 'Pick a database',
    partId: 'tool-1',
    callID: 'tool-1',
    sessionID: 'ses_question',
    question: 'Which database?',
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
    detectedAt: 1,
  };

  let formList: ReturnType<typeof mock>;
  let formReply: ReturnType<typeof mock>;
  let prompt: ReturnType<typeof mock>;

  beforeEach(() => {
    formList = mock(async () => []);
    formReply = mock(async () => undefined);
    prompt = mock(async () => undefined);
    setRuntimeClient({
      session: { form: { list: formList, reply: formReply }, prompt },
    } as unknown as RuntimeClient);
    clearPendingQuestionsForJob('job-q');
  });

  afterEach(() => {
    clearPendingQuestionsForJob('job-q');
    setRuntimeClient(null);
  });

  it('should store a question once and find it by job', () => {
    expect(addPendingQuestion(question)).toBe(true);
    expect(addPendingQuestion(question)).toBe(false);

    expect(getPendingQuestionsForJob('job-q')).toEqual([question]);
    expect(getPendingQuestionsForJob('other-job')).toEqual([]);
  });

  it('should remove a question by part', () => {
    addPendingQuestion(question);

    expect(removePendingQuestion('job-q', 'tool-1')).toBe(true);
    expect(removePendingQuestion('job-q', 'tool-1')).toBe(false);
    expect(getPendingQuestionsForJob('job-q')).toEqual([]);
  });
});
