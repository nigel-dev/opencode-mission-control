import { mock } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job, JobState } from '../../src/lib/job-state';
import type { RuntimeClient } from '../../src/lib/job-runtime';

if (process.env.MC_WORKFLOWS_ISOLATED !== '1') {
  describe('Workflow integration suite', () => {
    it('runs in an isolated subprocess', () => {
      const result = spawnSync(
        'bun',
        ['test', 'tests/integration/z-workflows.test.ts'],
        {
          cwd: process.cwd(),
          env: { ...process.env, MC_WORKFLOWS_ISOLATED: '1' },
          encoding: 'utf8',
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [result.stdout, result.stderr].filter(Boolean).join('\n'),
        );
      }

      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');

      expect(output).toContain('23 pass');
      expect(output).toContain('0 fail');
    }, 120000);
  });
} else {

// ============================================================================
// Mock the state, git and config layers. The job runtime itself is real and
// talks to a fake OpenCode client, so launches go through real sessions calls.
// ============================================================================

mock.module('../../src/lib/job-state', () => {
  // In-memory job store for integration testing
  let jobs: Job[] = [];

  return {
    loadJobState: vi.fn(async (): Promise<JobState> => ({
      version: 4,
      jobs: [...jobs],
      updatedAt: new Date().toISOString(),
    })),
    saveJobState: vi.fn(async (state: JobState) => {
      jobs = [...state.jobs];
    }),
    addJob: vi.fn(async (job: Job) => {
      jobs.push(job);
    }),
    getJobByName: vi.fn(async (name: string) => {
      return jobs.find((j) => j.name === name);
    }),
    getJob: vi.fn(async (id: string) => {
      return jobs.find((j) => j.id === id);
    }),
    updateJob: vi.fn(async (id: string, updates: Partial<Job>) => {
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx === -1) throw new Error(`Job with id ${id} not found`);
      jobs[idx] = { ...jobs[idx], ...updates };
    }),
    removeJob: vi.fn(async (id: string) => {
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx === -1) throw new Error(`Job with id ${id} not found`);
      jobs.splice(idx, 1);
    }),
    getRunningJobs: vi.fn(async () => {
      return jobs.filter((j) => j.status === 'running');
    }),
    // Expose for test cleanup
    _resetJobs: () => {
      jobs = [];
    },
    _getJobs: () => [...jobs],
  };
});

mock.module('../../src/lib/worktree', () => ({
  createWorktree: vi.fn(async (opts: { branch: string }) => {
    const sanitized = opts.branch.replace(/\//g, '-');
    return `/tmp/mc-worktrees/${sanitized}`;
  }),
  removeWorktree: vi.fn(async () => {}),
  isInManagedWorktree: vi.fn(async (path: string) => ({
    isManaged: path.startsWith('/tmp/mc-worktrees'),
    worktreePath: path,
  })),
}));

const BASE_CONFIG = {
  pollInterval: 10000,
  worktreeBasePath: '/tmp/mc-worktrees',
};

mock.module('../../src/lib/config', () => ({
  loadConfig: vi.fn(async () => ({ ...BASE_CONFIG })),
}));

mock.module('../../src/lib/worktree-setup', () => ({
  resolvePostCreateHook: vi.fn((_globalConfig: unknown, perJob?: { symlinkDirs?: string[]; copyFiles?: string[]; commands?: string[] }) => ({
    symlinkDirs: ['.opencode', ...(perJob?.symlinkDirs ?? [])],
    copyFiles: perJob?.copyFiles ?? [],
    commands: perJob?.commands ?? [],
  })),
  describeCommandWarnings: vi.fn(() => []),
}));

mock.module('crypto', () => {
  let counter = 0;
  return {
    randomUUID: vi.fn(() => `test-uuid-${++counter}`),
  };
});

// ============================================================================
// Import modules after mocks
// ============================================================================

const jobState = await import('../../src/lib/job-state');
const worktree = await import('../../src/lib/worktree');
const configMod = await import('../../src/lib/config');
const { setRuntimeClient } = await import('../../src/lib/job-runtime');
const planState = await import('../../src/lib/plan-state');

const { mc_launch } = await import('../../src/tools/launch');
const { mc_status } = await import('../../src/tools/status');
const { mc_capture } = await import('../../src/tools/capture');
const { mc_kill } = await import('../../src/tools/kill');
const { mc_cleanup } = await import('../../src/tools/cleanup');
const { mc_jobs } = await import('../../src/tools/jobs');
const { mc_attach } = await import('../../src/tools/attach');
const { mc_pr } = await import('../../src/tools/pr');

// Keep mocked module instances for this file, then stop global module mocking
// so other test files can import real implementations.
mock.restore();

// ============================================================================
// Fake OpenCode server: sessions live in memory
// ============================================================================

interface FakeSession {
  id: string;
  directory: string;
  title: string;
  agent?: string;
  model?: { providerID: string; id: string; variant?: string };
  prompts: string[];
  interrupted: boolean;
  output: string;
}

const sessions = new Map<string, FakeSession>();
let sessionCounter = 0;
let failNextPrompt: Error | null = null;

function requireSession(sessionID: string): FakeSession {
  const session = sessions.get(sessionID);
  if (!session) {
    throw new Error(`session not found: ${sessionID}`);
  }
  return session;
}

const fakeClient = {
  session: {
    async create(input: {
      location: { directory: string };
      title: string;
      agent?: string;
      model?: FakeSession['model'];
    }) {
      const id = `ses_${++sessionCounter}`;
      sessions.set(id, {
        id,
        directory: input.location.directory,
        title: input.title,
        agent: input.agent,
        model: input.model,
        prompts: [],
        interrupted: false,
        output: 'opencode> Working on task...\nFile modified: src/auth.ts\nTests passing: 5/5',
      });
      return { id };
    },
    async prompt(input: { sessionID: string; text: string }) {
      if (failNextPrompt) {
        const error = failNextPrompt;
        failNextPrompt = null;
        throw error;
      }
      requireSession(input.sessionID).prompts.push(input.text);
    },
    async interrupt(input: { sessionID: string }) {
      requireSession(input.sessionID).interrupted = true;
    },
    async remove(input: { sessionID: string }) {
      requireSession(input.sessionID);
      sessions.delete(input.sessionID);
    },
    async get(input: { sessionID: string }) {
      requireSession(input.sessionID);
      return {
        id: input.sessionID,
        cost: 0.1,
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      };
    },
    async context(input: { sessionID: string }) {
      const session = requireSession(input.sessionID);
      return [
        ...session.prompts.map((text) => ({ type: 'user', text })),
        { type: 'assistant', content: [{ type: 'text', text: session.output }] },
      ];
    },
  },
  permission: {
    async assert(input: { sessionID: string; action: string; resources: string[] }) {
      permissionAsserts.push(input);
    },
  },
};

const permissionAsserts: Array<{ sessionID: string; action: string; resources: string[] }> = [];
const spawnedCommands: string[][] = [];
let spawnExitCode = 1;

setRuntimeClient(fakeClient as unknown as RuntimeClient);

// ============================================================================
// Typed mock references
// ============================================================================

const mockCreateWorktree = worktree.createWorktree as Mock;
const mockRemoveWorktree = worktree.removeWorktree as Mock;
const mockLoadConfig = configMod.loadConfig as Mock;
const resetJobs = (jobState as unknown as { _resetJobs: () => void })._resetJobs;
const getJobs = (jobState as unknown as { _getJobs: () => Job[] })._getJobs;

const toolContext = { sessionID: 'test-session' };

function resetWorld(): void {
  vi.clearAllMocks();
  resetJobs();
  sessions.clear();
  failNextPrompt = null;
  permissionAsserts.length = 0;
  spawnedCommands.length = 0;
  spawnExitCode = 1;
  // No plan in these workflows; cleanup must not read the developer's real plan file.
  vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);
  // mc_pr runs `git push` and `gh pr create`. A test must never reach the real
  // ones: every spawned command is recorded and answered here.
  vi.spyOn(Bun, 'spawn').mockImplementation(((command: string[]) => {
    spawnedCommands.push(command);
    const output = spawnExitCode === 0 ? 'https://github.com/acme/repo/pull/1\n' : '';
    return {
      stdout: new Response(output).body!,
      stderr: new Response(spawnExitCode === 0 ? '' : 'not available in tests').body!,
      exited: Promise.resolve(spawnExitCode),
    };
  }) as never);

  // Re-setup default mock implementations after clearAllMocks
  mockCreateWorktree.mockImplementation(async (opts: { branch: string }) => {
    const sanitized = opts.branch.replace(/\//g, '-');
    return `/tmp/mc-worktrees/${sanitized}`;
  });
  mockRemoveWorktree.mockResolvedValue(undefined);
  mockLoadConfig.mockResolvedValue({ ...BASE_CONFIG });
  (worktree.isInManagedWorktree as Mock).mockResolvedValue({
    isManaged: true,
    worktreePath: '/tmp/mc-worktrees/test',
  });
}

function sessionOf(jobName: string): FakeSession {
  const job = getJobs().find((candidate) => candidate.name === jobName);
  if (!job?.sessionID) {
    throw new Error(`job ${jobName} has no session`);
  }
  return requireSession(job.sessionID);
}

// ============================================================================
// Workflow 1: Launch -> Status -> Capture -> Kill -> Cleanup
// ============================================================================

describe('Workflow 1: Basic lifecycle (Launch -> Status -> Capture -> Kill -> Cleanup)', () => {
  beforeEach(resetWorld);

  it('should complete full lifecycle: launch -> status -> capture -> kill -> cleanup', async () => {
    // ---- Step 1: Launch a job ----
    const launchResult = await mc_launch.execute(
      { name: 'auth-job', prompt: 'Add authentication' },
      toolContext,
    );

    expect(launchResult.content).toContain('Job "auth-job" launched successfully');
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'mc/auth-job',
        postCreate: expect.objectContaining({
          symlinkDirs: expect.arrayContaining(['.opencode']),
        }),
      }),
    );

    // Verify job is in state, backed by a session in its worktree
    const jobs = getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      name: 'auth-job',
      status: 'running',
      branch: 'mc/auth-job',
      worktreePath: '/tmp/mc-worktrees/mc-auth-job',
      prompt: 'Add authentication',
      launchSessionID: 'test-session',
    });
    const sessionID = jobs[0].sessionID as string;
    expect(launchResult.content).toContain(`Session:   ${sessionID}`);

    const session = requireSession(sessionID);
    expect(session.directory).toBe('/tmp/mc-worktrees/mc-auth-job');
    expect(session.title).toBe('[MC] auth-job');
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0].startsWith('Add authentication')).toBe(true);
    expect(session.prompts[0]).toContain('mc_report(status: "completed"');
    expect(session.prompts[0]).toContain('you MUST commit your changes');

    // ---- Step 2: Check status ----
    const statusResult = await mc_status.execute({ name: 'auth-job' });

    expect(statusResult.content).toContain('Job: auth-job');
    expect(statusResult.content).toContain('Status: running');
    expect(statusResult.content).toContain('Branch: mc/auth-job');
    expect(statusResult.content).toContain(`Session: ${sessionID}`);
    expect(statusResult.content).toContain('Cost: $0.1000');
    expect(statusResult.content).toContain('Tests passing: 5/5');

    // ---- Step 3: Capture output ----
    const captureResult = await mc_capture.execute({ name: 'auth-job', lines: 2 });

    expect(captureResult.content).toBe('File modified: src/auth.ts\nTests passing: 5/5');

    // ---- Step 4: Kill the job ----
    const killResult = await mc_kill.execute({ name: 'auth-job' });

    expect(killResult.content).toContain('Job "auth-job" stopped successfully');
    expect(session.interrupted).toBe(true);

    // Verify job is now stopped in state
    const jobsAfterKill = getJobs();
    expect(jobsAfterKill[0].status).toBe('stopped');
    expect(jobsAfterKill[0].completedAt).toBeDefined();

    // ---- Step 5: Cleanup the job ----
    const cleanupResult = await mc_cleanup.execute({ name: 'auth-job' });

    expect(cleanupResult.content).toContain('Cleaned up job "auth-job"');
    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      '/tmp/mc-worktrees/mc-auth-job',
      true,
    );
    expect(sessions.has(sessionID)).toBe(false);

    // Verify job is removed from state
    expect(getJobs()).toHaveLength(0);
  });

  it('should track job across status checks at different points', async () => {
    await mc_launch.execute({ name: 'tracking-test', prompt: 'Track me' }, toolContext);

    const status1 = await mc_status.execute({ name: 'tracking-test' });
    expect(status1.content).toContain('Status: running');

    await mc_kill.execute({ name: 'tracking-test' });

    const status2 = await mc_status.execute({ name: 'tracking-test' });
    expect(status2.content).toContain('Status: stopped');
    // Usage is only shown while the job is running.
    expect(status2.content).not.toContain('Cost:');
  });

  it('should prevent duplicate job names across lifecycle', async () => {
    await mc_launch.execute({ name: 'unique-job', prompt: 'First launch' }, toolContext);

    await expect(
      mc_launch.execute({ name: 'unique-job', prompt: 'Duplicate attempt' }, toolContext),
    ).rejects.toThrow('Job "unique-job" already exists');
    expect(sessions.size).toBe(1);

    await mc_kill.execute({ name: 'unique-job' });
    await mc_cleanup.execute({ name: 'unique-job' });

    const result = await mc_launch.execute(
      { name: 'unique-job', prompt: 'Second launch' },
      toolContext,
    );
    expect(result.content).toContain('Job "unique-job" launched successfully');
    expect(sessionOf('unique-job').prompts[0].startsWith('Second launch')).toBe(true);
  });

  it('should not cleanup a running job', async () => {
    await mc_launch.execute({ name: 'still-running', prompt: 'Running task' }, toolContext);

    await expect(mc_cleanup.execute({ name: 'still-running' })).rejects.toThrow(
      'Cannot cleanup running job',
    );
    expect(sessionOf('still-running').interrupted).toBe(false);
  });

  it('should leave nothing behind when the session cannot be started', async () => {
    failNextPrompt = new Error('model unavailable');

    await expect(
      mc_launch.execute({ name: 'broken-job', prompt: 'Never runs' }, toolContext),
    ).rejects.toThrow('Failed to launch job "broken-job"');

    expect(getJobs()).toHaveLength(0);
    expect(sessions.size).toBe(0);
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/tmp/mc-worktrees/mc-broken-job', true);
  });
});

// ============================================================================
// Workflow 2: Agent and model selection
// ============================================================================

describe('Workflow 2: Agent and model selection', () => {
  beforeEach(resetWorld);

  it('should run the job with the requested agent and model', async () => {
    const result = await mc_launch.execute(
      {
        name: 'review-job',
        prompt: 'Review the auth module',
        agent: 'reviewer',
        model: 'anthropic/claude-sonnet-4#high',
      },
      toolContext,
    );

    const session = sessionOf('review-job');
    expect(session.agent).toBe('reviewer');
    expect(session.model).toEqual({ providerID: 'anthropic', id: 'claude-sonnet-4', variant: 'high' });

    expect(result.content).toContain('Agent:     reviewer');
    expect(result.content).toContain('Model:     anthropic/claude-sonnet-4#high');

    const jobsResult = await mc_jobs.execute({});
    expect(jobsResult.content).toContain('Agent: reviewer | Model: anthropic/claude-sonnet-4#high');
  });

  it('should fall back to the configured default agent and model', async () => {
    mockLoadConfig.mockResolvedValue({
      ...BASE_CONFIG,
      defaultAgent: 'build',
      defaultModel: 'openai/gpt-5',
    });

    await mc_launch.execute({ name: 'default-job', prompt: 'Use defaults' }, toolContext);

    const session = sessionOf('default-job');
    expect(session.agent).toBe('build');
    expect(session.model).toEqual({ providerID: 'openai', id: 'gpt-5' });
    expect(getJobs()[0]).toMatchObject({ agent: 'build', model: 'openai/gpt-5' });
  });

  it('should reject a malformed model before creating anything', async () => {
    await expect(
      mc_launch.execute({ name: 'bad-model', prompt: 'Nope', model: 'sonnet' }, toolContext),
    ).rejects.toThrow('Invalid model "sonnet"');

    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(sessions.size).toBe(0);
    expect(getJobs()).toHaveLength(0);
  });

  it("should explain how to open the job's session", async () => {
    await mc_launch.execute({ name: 'attach-job', prompt: 'Attach to me' }, toolContext);
    const session = sessionOf('attach-job');

    const result = await mc_attach.execute({ name: 'attach-job' });

    expect(result.content).toContain('[MC] attach-job');
    expect(result.content).toContain(
      `cd /tmp/mc-worktrees/mc-attach-job && opencode --session ${session.id}`,
    );
  });
});

// ============================================================================
// Workflow 3: Launch -> PR -> Cleanup
// ============================================================================

describe('Workflow 3: Launch -> PR -> Cleanup', () => {
  beforeEach(resetWorld);

  it('should launch a job and then create a PR from its branch', async () => {
    const launchResult = await mc_launch.execute(
      { name: 'pr-job', prompt: 'Add new feature for PR' },
      toolContext,
    );
    expect(launchResult.content).toContain('Job "pr-job" launched successfully');

    expect(getJobs()[0].branch).toBe('mc/pr-job');

    // git and gh are answered by the stub in resetWorld; here they succeed.
    spawnExitCode = 0;
    const prResult = await mc_pr.execute(
      {
        name: 'pr-job',
        title: 'Add new feature',
        body: 'This PR adds authentication',
        draft: true,
      },
      toolContext,
    );

    expect(jobState.getJobByName).toHaveBeenCalledWith('pr-job');
    expect(prResult.content).toBe('https://github.com/acme/repo/pull/1');
    // Publishing was held to the calling session's permission first.
    expect(permissionAsserts).toEqual([
      { sessionID: 'test-session', action: 'mission-control.pr', resources: ['mc/pr-job'] },
    ]);
    expect(spawnedCommands.map((command) => command.slice(0, 3).join(' '))).toEqual([
      'git push origin',
      'gh pr create',
    ]);
    expect(spawnedCommands[0]).toEqual(['git', 'push', 'origin', 'mc/pr-job']);
  });

  it("should hold a launch's custom setup commands to the calling session's shell permission", async () => {
    await mc_launch.execute(
      { name: 'setup-job', prompt: 'Do the work', commands: ['bun install', 'make setup'] },
      toolContext,
    );

    expect(permissionAsserts).toEqual([
      { sessionID: 'test-session', action: 'shell', resources: ['bun install', 'make setup'] },
    ]);
    expect(getJobs()).toHaveLength(1);
  });

  it('should fail PR creation when job does not exist', async () => {
    await expect(
      mc_pr.execute({ name: 'nonexistent-job', title: 'PR' }, toolContext),
    ).rejects.toThrow('Job "nonexistent-job" not found');
  });

  it('should use job prompt as default PR title', async () => {
    await mc_launch.execute(
      { name: 'default-title-job', prompt: 'Implement OAuth2 login' },
      toolContext,
    );

    // The stored prompt is the task itself, without the reporting rules.
    expect(getJobs()[0].prompt).toBe('Implement OAuth2 login');

    try {
      await mc_pr.execute({ name: 'default-title-job' }, toolContext);
    } catch (error) {
      // Expected: gh CLI not available in test
      expect(error).toBeDefined();
    }
    expect(jobState.getJobByName).toHaveBeenCalledWith('default-title-job');
  });

  it('should handle full workflow: launch -> kill -> cleanup after PR', async () => {
    await mc_launch.execute({ name: 'full-pr-flow', prompt: 'Complete feature' }, toolContext);

    try {
      await mc_pr.execute({ name: 'full-pr-flow', title: 'Complete feature PR' }, toolContext);
    } catch (error) {
      // Expected: gh CLI not available in test
      expect(error).toBeDefined();
    }

    await mc_kill.execute({ name: 'full-pr-flow' });

    const cleanupResult = await mc_cleanup.execute({ name: 'full-pr-flow' });
    expect(cleanupResult.content).toContain('Cleaned up job "full-pr-flow"');
    expect(getJobs()).toHaveLength(0);
    expect(sessions.size).toBe(0);
  });
});

// ============================================================================
// Workflow 4: Multiple jobs in parallel
// ============================================================================

describe('Workflow 4: Multiple jobs in parallel', () => {
  beforeEach(resetWorld);

  it('should launch multiple jobs and track all of them', async () => {
    await mc_launch.execute({ name: 'job-auth', prompt: 'Add authentication' }, toolContext);
    await mc_launch.execute({ name: 'job-api', prompt: 'Build API endpoints' }, toolContext);
    await mc_launch.execute({ name: 'job-ui', prompt: 'Create UI components' }, toolContext);

    const jobs = getJobs();
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.name).sort()).toEqual(['job-api', 'job-auth', 'job-ui']);

    // Each should have its own worktree and its own session
    expect(new Set(jobs.map((j) => j.worktreePath)).size).toBe(3);
    expect(new Set(jobs.map((j) => j.sessionID)).size).toBe(3);
    for (const job of jobs) {
      expect(requireSession(job.sessionID as string).directory).toBe(job.worktreePath);
    }
  });

  it('should list all jobs via mc_jobs', async () => {
    await mc_launch.execute({ name: 'list-job-1', prompt: 'Task 1' }, toolContext);
    await mc_launch.execute({ name: 'list-job-2', prompt: 'Task 2' }, toolContext);

    const jobsResult = await mc_jobs.execute({});

    expect(jobsResult.content).toContain('Mission Control Jobs');
    expect(jobsResult.content).toContain('list-job-1');
    expect(jobsResult.content).toContain('list-job-2');
    expect(jobsResult.content).toContain('Running (2)');
    expect(jobsResult.content).toContain(`Session: ${sessionOf('list-job-1').id}`);
    expect(jobsResult.content).toContain('Cost: $0.1000 | Tokens: 100 in / 10 out');
  });

  it('should independently manage job statuses', async () => {
    await mc_launch.execute({ name: 'ind-job-a', prompt: 'Task A' }, toolContext);
    await mc_launch.execute({ name: 'ind-job-b', prompt: 'Task B' }, toolContext);
    await mc_launch.execute({ name: 'ind-job-c', prompt: 'Task C' }, toolContext);

    // Kill only job B
    await mc_kill.execute({ name: 'ind-job-b' });

    const jobs = getJobs();
    expect(jobs.find((j) => j.name === 'ind-job-a')!.status).toBe('running');
    expect(jobs.find((j) => j.name === 'ind-job-b')!.status).toBe('stopped');
    expect(jobs.find((j) => j.name === 'ind-job-c')!.status).toBe('running');

    expect(sessionOf('ind-job-a').interrupted).toBe(false);
    expect(sessionOf('ind-job-b').interrupted).toBe(true);
    expect(sessionOf('ind-job-c').interrupted).toBe(false);
  });

  it('should get status for each individual job', async () => {
    await mc_launch.execute({ name: 'status-job-1', prompt: 'First task' }, toolContext);
    await mc_launch.execute({ name: 'status-job-2', prompt: 'Second task' }, toolContext);

    const status1 = await mc_status.execute({ name: 'status-job-1' });
    const status2 = await mc_status.execute({ name: 'status-job-2' });

    expect(status1.content).toContain('Job: status-job-1');
    expect(status1.content).toContain('Branch: mc/status-job-1');
    expect(status1.content).toContain(`Session: ${sessionOf('status-job-1').id}`);
    expect(status2.content).toContain('Job: status-job-2');
    expect(status2.content).toContain('Branch: mc/status-job-2');
    expect(status2.content).toContain(`Session: ${sessionOf('status-job-2').id}`);
  });

  it('should capture output from specific jobs', async () => {
    await mc_launch.execute({ name: 'capture-a', prompt: 'Job A' }, toolContext);
    await mc_launch.execute({ name: 'capture-b', prompt: 'Job B' }, toolContext);
    sessionOf('capture-a').output = 'Output from job A';
    sessionOf('capture-b').output = 'Output from job B';

    const outputA = await mc_capture.execute({ name: 'capture-a', lines: 1 });
    const outputB = await mc_capture.execute({ name: 'capture-b', lines: 1 });

    expect(outputA.content).toBe('Output from job A');
    expect(outputB.content).toBe('Output from job B');
  });

  it('should cleanup all non-running jobs at once', async () => {
    await mc_launch.execute({ name: 'batch-1', prompt: 'Task 1' }, toolContext);
    await mc_launch.execute({ name: 'batch-2', prompt: 'Task 2' }, toolContext);
    await mc_launch.execute({ name: 'batch-3', prompt: 'Task 3' }, toolContext);
    const keptSession = sessionOf('batch-2').id;

    await mc_kill.execute({ name: 'batch-1' });
    await mc_kill.execute({ name: 'batch-3' });

    const cleanupResult = await mc_cleanup.execute({ all: true });

    expect(cleanupResult.content).toContain('Cleaned up job "batch-1"');
    expect(cleanupResult.content).toContain('Cleaned up job "batch-3"');
    expect(cleanupResult.content).toContain('2 cleaned');

    // Only the running job and its session should remain
    const remainingJobs = getJobs();
    expect(remainingJobs).toHaveLength(1);
    expect(remainingJobs[0].name).toBe('batch-2');
    expect(remainingJobs[0].status).toBe('running');
    expect([...sessions.keys()]).toEqual([keptSession]);
  });

  it('should handle launching jobs in parallel (concurrent launches)', async () => {
    const launches = await Promise.all([
      mc_launch.execute({ name: 'parallel-1', prompt: 'Parallel task 1' }, toolContext),
      mc_launch.execute({ name: 'parallel-2', prompt: 'Parallel task 2' }, toolContext),
      mc_launch.execute({ name: 'parallel-3', prompt: 'Parallel task 3' }, toolContext),
    ]);

    expect(launches).toHaveLength(3);
    launches.forEach((result) => {
      expect(result.content).toContain('launched successfully');
    });

    const jobs = getJobs();
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.status === 'running')).toBe(true);
    expect(new Set(jobs.map((j) => j.sessionID)).size).toBe(3);
  });

  it('should filter jobs by status in mc_jobs', async () => {
    await mc_launch.execute({ name: 'filter-running', prompt: 'Running' }, toolContext);
    await mc_launch.execute({ name: 'filter-stopped', prompt: 'Will stop' }, toolContext);

    await mc_kill.execute({ name: 'filter-stopped' });

    const runningResult = await mc_jobs.execute({ status: 'running' });
    expect(runningResult.content).toContain('filter-running');
    expect(runningResult.content).not.toContain('filter-stopped');
  });

  it('should kill and cleanup all jobs sequentially', async () => {
    const jobNames = ['cleanup-a', 'cleanup-b', 'cleanup-c'];

    for (const name of jobNames) {
      await mc_launch.execute({ name, prompt: `Task ${name}` }, toolContext);
    }
    expect(getJobs()).toHaveLength(3);
    expect(sessions.size).toBe(3);

    for (const name of jobNames) {
      await mc_kill.execute({ name });
    }
    expect(getJobs().every((j) => j.status === 'stopped')).toBe(true);

    const result = await mc_cleanup.execute({ all: true });
    expect(result.content).toContain('3 cleaned');
    expect(getJobs()).toHaveLength(0);
    expect(sessions.size).toBe(0);
  });
});
}
