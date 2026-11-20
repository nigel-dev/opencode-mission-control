import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import type { MCConfig } from '../../src/lib/config';
import * as jobState from '../../src/lib/job-state';
import * as worktree from '../../src/lib/worktree';
import * as configMod from '../../src/lib/config';
import * as jobRuntime from '../../src/lib/job-runtime';
import * as modelTracker from '../../src/lib/model-tracker';
import * as reports from '../../src/lib/reports';
import * as git from '../../src/lib/git';

const {
  launchJob,
  buildJobPrompt,
  MC_REPORT_SUFFIX,
  AUTO_COMMIT_SUFFIX,
} = await import('../../src/lib/job-launcher');

let mockLoadJobState: Mock;
let mockAddJob: Mock;
let mockRemoveJob: Mock;
let mockCreateWorktree: Mock;
let mockRemoveWorktree: Mock;
let mockLoadConfig: Mock;
let mockStartJobSession: Mock;
let mockRemoveJobSession: Mock;
let mockGetCurrentModel: Mock;
let mockRemoveReport: Mock;

const WORKTREE = '/tmp/mc-worktrees/feature-auth';

function makeConfig(overrides: Partial<MCConfig> = {}): MCConfig {
  return {
    pollInterval: 10000,
    worktreeBasePath: '/tmp/mc-worktrees',
    autoCommit: true,
    ...overrides,
  };
}

function makeExistingJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'old-job-id',
    name: 'feature-auth',
    worktreePath: WORKTREE,
    branch: 'mc/feature-auth',
    status: 'completed',
    prompt: 'Old prompt',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function setJobs(jobs: Job[]): void {
  mockLoadJobState.mockResolvedValue({ version: 4, jobs, updatedAt: new Date().toISOString() });
}

describe('job-launcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The branch checked out in the project when a standalone job launches.
    vi.spyOn(git, 'gitCommand').mockResolvedValue({ stdout: 'work-branch', stderr: '', exitCode: 0 });
    mockLoadJobState = vi.spyOn(jobState, 'loadJobState') as unknown as Mock;
    setJobs([]);
    mockAddJob = vi.spyOn(jobState, 'addJob').mockResolvedValue(undefined) as unknown as Mock;
    mockRemoveJob = vi.spyOn(jobState, 'removeJob').mockResolvedValue(undefined) as unknown as Mock;
    mockCreateWorktree = vi.spyOn(worktree, 'createWorktree').mockResolvedValue(WORKTREE) as unknown as Mock;
    mockRemoveWorktree = vi.spyOn(worktree, 'removeWorktree').mockResolvedValue(undefined) as unknown as Mock;
    mockLoadConfig = vi.spyOn(configMod, 'loadConfig').mockResolvedValue(makeConfig()) as unknown as Mock;
    mockStartJobSession = vi.spyOn(jobRuntime, 'startJobSession').mockResolvedValue('ses_job') as unknown as Mock;
    mockRemoveJobSession = vi.spyOn(jobRuntime, 'removeJobSession').mockResolvedValue(undefined) as unknown as Mock;
    mockGetCurrentModel = vi.spyOn(modelTracker, 'getCurrentModel').mockReturnValue(undefined) as unknown as Mock;
    mockRemoveReport = vi.spyOn(reports, 'removeReport').mockResolvedValue(undefined) as unknown as Mock;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildJobPrompt', () => {
    it('appends the report rules and the auto-commit instruction by default', () => {
      expect(buildJobPrompt('Do it')).toBe(`Do it${MC_REPORT_SUFFIX}${AUTO_COMMIT_SUFFIX}`);
      expect(buildJobPrompt('Do it', true)).toBe(`Do it${MC_REPORT_SUFFIX}${AUTO_COMMIT_SUFFIX}`);
    });

    it('omits the auto-commit instruction when autoCommit is false', () => {
      expect(buildJobPrompt('Do it', false)).toBe(`Do it${MC_REPORT_SUFFIX}`);
    });

    it('tells the agent which paths Mission Control placed in the worktree and must not be committed', () => {
      const prompt = buildJobPrompt('Do it', true, ['.env', 'node_modules']);

      expect(prompt.startsWith(`Do it${MC_REPORT_SUFFIX}${AUTO_COMMIT_SUFFIX}`)).toBe(true);
      expect(prompt).toContain('Never stage or commit them: .env, node_modules.');
      expect(buildJobPrompt('Do it', true)).toBe(`Do it${MC_REPORT_SUFFIX}${AUTO_COMMIT_SUFFIX}`);
    });

    it('tells the agent to commit before it reports completion', () => {
      expect(AUTO_COMMIT_SUFFIX).toContain('BEFORE you report completion');
    });

    it('tells the agent to report completion through mc_report', () => {
      expect(MC_REPORT_SUFFIX).toContain('mc_report(status: "completed"');
      expect(AUTO_COMMIT_SUFFIX).toContain('you MUST commit your changes');
    });
  });

  describe('successful launch', () => {
    it('creates the worktree, starts the session and records the job', async () => {
      const job = await launchJob({
        name: 'feature-auth',
        prompt: 'Add OAuth',
        launchSessionID: 'ses_launcher',
      });

      expect(mockCreateWorktree).toHaveBeenCalledWith({
        branch: 'mc/feature-auth',
        postCreate: expect.anything(),
        startPoint: undefined,
      });
      expect(mockStartJobSession).toHaveBeenCalledWith({
        jobId: job.id,
        jobName: 'feature-auth',
        worktreePath: WORKTREE,
        prompt: buildJobPrompt('Add OAuth', true, ['.opencode']),
        agent: undefined,
        model: undefined,
        planId: undefined,
        launchSessionID: 'ses_launcher',
      });
      expect(mockAddJob).toHaveBeenCalledTimes(1);
      expect(mockAddJob).toHaveBeenCalledWith(job);
      expect(job).toEqual({
        id: expect.any(String),
        name: 'feature-auth',
        worktreePath: WORKTREE,
        branch: 'mc/feature-auth',
        // No explicit base: the job records the branch it forked from.
        baseBranch: 'work-branch',
        status: 'running',
        prompt: 'Add OAuth',
        createdAt: expect.any(String),
        planId: undefined,
        launchSessionID: 'ses_launcher',
        sessionID: 'ses_job',
        agent: undefined,
        model: undefined,
        // What Mission Control itself placed in the worktree.
        setupArtifacts: ['.opencode'],
      });
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
      expect(mockRemoveJobSession).not.toHaveBeenCalled();
    });

    it('runs the steps in order: worktree, session, job record', async () => {
      const order: string[] = [];
      mockCreateWorktree.mockImplementation(async () => {
        order.push('worktree');
        return WORKTREE;
      });
      mockStartJobSession.mockImplementation(async () => {
        order.push('session');
        return 'ses_job';
      });
      mockAddJob.mockImplementation(async () => {
        order.push('job');
      });

      await launchJob({ name: 'feature-auth', prompt: 'Add OAuth' });

      expect(order).toEqual(['worktree', 'session', 'job']);
    });

    it('uses a custom branch and records the base branch', async () => {
      const job = await launchJob({
        name: 'feature-auth',
        prompt: 'Add OAuth',
        branch: 'feat/oauth',
        baseBranch: 'develop',
      });

      expect(mockCreateWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ branch: 'feat/oauth', startPoint: 'develop' }),
      );
      expect(job.branch).toBe('feat/oauth');
      expect(job.baseBranch).toBe('develop');
    });

    it('branches from startPoint without recording it as the base branch', async () => {
      const job = await launchJob({
        name: 'feature-auth',
        prompt: 'Add OAuth',
        startPoint: 'abc1234',
        planId: 'plan-1',
      });

      expect(mockCreateWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ startPoint: 'abc1234' }),
      );
      expect(job.baseBranch).toBeUndefined();
      expect(job.planId).toBe('plan-1');
      expect(mockStartJobSession).toHaveBeenCalledWith(expect.objectContaining({ planId: 'plan-1' }));
    });

    it('merges per-launch setup with the configured worktree setup', async () => {
      mockLoadConfig.mockResolvedValue(
        makeConfig({ worktreeSetup: { copyFiles: ['.env'], commands: ['bun install'] } }),
      );

      await launchJob({
        name: 'feature-auth',
        prompt: 'Add OAuth',
        copyFiles: ['.env.local'],
        symlinkDirs: ['node_modules'],
        commands: ['bun run build'],
      });

      const postCreate = mockCreateWorktree.mock.calls[0][0].postCreate;
      expect(postCreate.copyFiles).toEqual(expect.arrayContaining(['.env', '.env.local']));
      expect(postCreate.symlinkDirs).toEqual(expect.arrayContaining(['node_modules']));
      expect(postCreate.commands).toEqual(expect.arrayContaining(['bun install', 'bun run build']));
    });

    it('omits the auto-commit instruction when autoCommit is disabled', async () => {
      mockLoadConfig.mockResolvedValue(makeConfig({ autoCommit: false }));

      await launchJob({ name: 'feature-auth', prompt: 'Add OAuth' });

      expect(mockStartJobSession).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: buildJobPrompt('Add OAuth', false, ['.opencode']) }),
      );
    });

    it('uses a provided config instead of loading one', async () => {
      await launchJob({
        name: 'feature-auth',
        prompt: 'Add OAuth',
        config: makeConfig({ defaultAgent: 'plan-agent' }),
      });

      expect(mockLoadConfig).not.toHaveBeenCalled();
      expect(mockStartJobSession).toHaveBeenCalledWith(expect.objectContaining({ agent: 'plan-agent' }));
    });
  });

  describe('model resolution', () => {
    it('prefers the explicit model', async () => {
      mockLoadConfig.mockResolvedValue(makeConfig({ defaultModel: 'openai/gpt-5' }));
      mockGetCurrentModel.mockReturnValue('google/gemini-pro');

      const job = await launchJob({
        name: 'feature-auth',
        prompt: 'p',
        model: 'anthropic/claude-sonnet-4#high',
        launchSessionID: 'ses_launcher',
      });

      expect(mockStartJobSession).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { providerID: 'anthropic', id: 'claude-sonnet-4', variant: 'high' },
        }),
      );
      expect(job.model).toBe('anthropic/claude-sonnet-4#high');
    });

    it('falls back to config.defaultModel', async () => {
      mockLoadConfig.mockResolvedValue(makeConfig({ defaultModel: 'openai/gpt-5' }));
      mockGetCurrentModel.mockReturnValue('google/gemini-pro');

      const job = await launchJob({ name: 'feature-auth', prompt: 'p', launchSessionID: 'ses_launcher' });

      expect(mockStartJobSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: { providerID: 'openai', id: 'gpt-5' } }),
      );
      expect(job.model).toBe('openai/gpt-5');
    });

    it("falls back to the launching session's current model", async () => {
      mockGetCurrentModel.mockReturnValue('google/gemini-pro');

      const job = await launchJob({ name: 'feature-auth', prompt: 'p', launchSessionID: 'ses_launcher' });

      expect(mockGetCurrentModel).toHaveBeenCalledWith('ses_launcher');
      expect(mockStartJobSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: { providerID: 'google', id: 'gemini-pro' } }),
      );
      expect(job.model).toBe('google/gemini-pro');
    });

    it('leaves the model to the session default when nothing is known', async () => {
      const job = await launchJob({ name: 'feature-auth', prompt: 'p' });

      expect(mockStartJobSession).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
      expect(job.model).toBeUndefined();
    });

    it('rejects a malformed model before creating anything', async () => {
      await expect(
        launchJob({ name: 'feature-auth', prompt: 'p', model: 'claude-sonnet' }),
      ).rejects.toThrow('Invalid model "claude-sonnet" for job "feature-auth"');

      expect(mockCreateWorktree).not.toHaveBeenCalled();
      expect(mockStartJobSession).not.toHaveBeenCalled();
      expect(mockAddJob).not.toHaveBeenCalled();
    });
  });

  describe('agent resolution', () => {
    it('prefers the explicit agent', async () => {
      mockLoadConfig.mockResolvedValue(makeConfig({ defaultAgent: 'build' }));

      const job = await launchJob({ name: 'feature-auth', prompt: 'p', agent: 'reviewer' });

      expect(mockStartJobSession).toHaveBeenCalledWith(expect.objectContaining({ agent: 'reviewer' }));
      expect(job.agent).toBe('reviewer');
    });

    it('falls back to config.defaultAgent', async () => {
      mockLoadConfig.mockResolvedValue(makeConfig({ defaultAgent: 'build' }));

      const job = await launchJob({ name: 'feature-auth', prompt: 'p' });

      expect(mockStartJobSession).toHaveBeenCalledWith(expect.objectContaining({ agent: 'build' }));
      expect(job.agent).toBe('build');
    });

    it('leaves the agent to the session default when none is configured', async () => {
      const job = await launchJob({ name: 'feature-auth', prompt: 'p' });

      expect(mockStartJobSession).toHaveBeenCalledWith(expect.objectContaining({ agent: undefined }));
      expect(job.agent).toBeUndefined();
    });
  });

  describe('name validation', () => {
    it.each(['', '  ', 'has space', '../escape', 'a/b', '-leading-dash', 'semi;colon', 'ends.lock', 'dot..dot'])(
      'rejects the name %p before creating anything',
      async (name) => {
        await expect(launchJob({ name, prompt: 'x' })).rejects.toThrow('Invalid job name');

        expect(mockCreateWorktree).not.toHaveBeenCalled();
        expect(mockStartJobSession).not.toHaveBeenCalled();
        expect(mockAddJob).not.toHaveBeenCalled();
      },
    );

    it('accepts letters, digits, dots, dashes and underscores', async () => {
      await expect(launchJob({ name: 'Fix_login-2.1', prompt: 'x' })).resolves.toMatchObject({ name: 'Fix_login-2.1' });
    });
  });

  describe('setup artifacts', () => {
    it('records the copied files and symlinked directories on the job', async () => {
      const job = await launchJob({
        name: 'feature-auth',
        prompt: 'x',
        copyFiles: ['.env'],
        symlinkDirs: ['node_modules'],
        config: makeConfig({ worktreeSetup: { copyFiles: ['.env.local'] } }),
      });

      expect(job.setupArtifacts).toEqual(['.env.local', '.env', '.opencode', 'node_modules']);
    });

    it('keeps the artifacts of the run it replaces when it reuses a worktree', async () => {
      setJobs([makeExistingJob({ setupArtifacts: ['.opencode', 'node_modules'] })]);

      const job = await launchJob({
        name: 'feature-auth',
        prompt: 'x',
        worktreePath: WORKTREE,
        replaceFinished: true,
      });

      expect(job.setupArtifacts).toEqual(['.opencode', 'node_modules']);
    });
  });

  describe('name uniqueness', () => {
    it('rejects a name that is already used', async () => {
      setJobs([makeExistingJob({ status: 'completed' })]);

      await expect(launchJob({ name: 'feature-auth', prompt: 'p' })).rejects.toThrow(
        'Job "feature-auth" already exists (status: completed). Use a different name or cleanup the existing job first.',
      );

      expect(mockCreateWorktree).not.toHaveBeenCalled();
      expect(mockStartJobSession).not.toHaveBeenCalled();
    });

    it('with replaceFinished, replaces finished jobs of the same name and their reports', async () => {
      setJobs([
        makeExistingJob({ id: 'old-1', status: 'completed' }),
        makeExistingJob({ id: 'other', name: 'unrelated', status: 'completed' }),
      ]);

      const job = await launchJob({ name: 'feature-auth', prompt: 'p', replaceFinished: true });

      expect(mockRemoveReport).toHaveBeenCalledTimes(1);
      expect(mockRemoveReport).toHaveBeenCalledWith('old-1');
      expect(mockRemoveJob).toHaveBeenCalledTimes(1);
      expect(mockRemoveJob).toHaveBeenCalledWith('old-1');
      expect(mockAddJob).toHaveBeenCalledWith(job);
    });

    it('with replaceFinished, still rejects when a job of the same name is running', async () => {
      setJobs([makeExistingJob({ status: 'running' })]);

      await expect(
        launchJob({ name: 'feature-auth', prompt: 'p', replaceFinished: true }),
      ).rejects.toThrow('Job "feature-auth" already exists (status: running)');

      expect(mockCreateWorktree).not.toHaveBeenCalled();
      expect(mockRemoveJob).not.toHaveBeenCalled();
    });
  });

  describe('existing worktree', () => {
    it('reuses the given worktree instead of creating one', async () => {
      const job = await launchJob({
        name: 'feature-auth',
        prompt: 'Fix it',
        branch: 'mc/plan/abcd1234/feature-auth',
        worktreePath: '/tmp/existing-wt',
      });

      expect(mockCreateWorktree).not.toHaveBeenCalled();
      expect(mockStartJobSession).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: '/tmp/existing-wt' }),
      );
      expect(job.worktreePath).toBe('/tmp/existing-wt');
      expect(job.branch).toBe('mc/plan/abcd1234/feature-auth');
    });

    it('never removes a reused worktree when the launch fails', async () => {
      mockStartJobSession.mockRejectedValue(new Error('boom'));

      await expect(
        launchJob({ name: 'feature-auth', prompt: 'Fix it', worktreePath: '/tmp/existing-wt' }),
      ).rejects.toThrow('Failed to launch job "feature-auth": boom');

      expect(mockRemoveWorktree).not.toHaveBeenCalled();
    });
  });

  describe('cleanup on failure', () => {
    it('does not start a session when the worktree cannot be created', async () => {
      mockCreateWorktree.mockRejectedValue(new Error('branch already checked out'));

      await expect(launchJob({ name: 'feature-auth', prompt: 'p' })).rejects.toThrow(
        'Failed to create worktree for branch "mc/feature-auth": branch already checked out',
      );

      expect(mockStartJobSession).not.toHaveBeenCalled();
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
      expect(mockAddJob).not.toHaveBeenCalled();
    });

    it('removes the worktree when the session cannot be started', async () => {
      mockStartJobSession.mockRejectedValue(new Error('Failed to send prompt to job session: nope'));

      await expect(launchJob({ name: 'feature-auth', prompt: 'p' })).rejects.toThrow(
        'Failed to launch job "feature-auth": Failed to send prompt to job session: nope',
      );

      expect(mockRemoveWorktree).toHaveBeenCalledWith(WORKTREE, true);
      expect(mockRemoveJobSession).not.toHaveBeenCalled();
      expect(mockAddJob).not.toHaveBeenCalled();
    });

    it('removes the session and the worktree when the job cannot be recorded', async () => {
      mockAddJob.mockRejectedValue(new Error('disk full'));

      await expect(launchJob({ name: 'feature-auth', prompt: 'p' })).rejects.toThrow(
        'Failed to launch job "feature-auth": disk full',
      );

      expect(mockRemoveJobSession).toHaveBeenCalledWith('ses_job');
      expect(mockRemoveWorktree).toHaveBeenCalledWith(WORKTREE, true);
    });

    it('reports the original error even when cleanup fails too', async () => {
      mockAddJob.mockRejectedValue(new Error('disk full'));
      mockRemoveJobSession.mockRejectedValue(new Error('session gone'));
      mockRemoveWorktree.mockRejectedValue(new Error('worktree locked'));

      await expect(launchJob({ name: 'feature-auth', prompt: 'p' })).rejects.toThrow(
        'Failed to launch job "feature-auth": disk full',
      );

      expect(mockRemoveJobSession).toHaveBeenCalledWith('ses_job');
      expect(mockRemoveWorktree).toHaveBeenCalledWith(WORKTREE, true);
    });
  });
});
