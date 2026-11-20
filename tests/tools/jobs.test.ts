import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as jobRuntime from '../../src/lib/job-runtime';

const { mc_jobs } = await import('../../src/tools/jobs');

let mockLoadJobState: Mock;
let mockGetJobUsage: Mock;

const mockContext = {
  sessionID: 'test-session',
  messageID: 'test-message',
  agent: 'test-agent',
  directory: '/test/dir',
  worktree: '/test/worktree',
  abort: new AbortController().signal,
  metadata: vi.fn(),
  ask: vi.fn(),
} as any;

describe('mc_jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadJobState = vi.spyOn(jobState, 'loadJobState').mockImplementation(() => ({ version: 1, jobs: [], updatedAt: new Date().toISOString() } as any));
    mockGetJobUsage = vi.spyOn(jobRuntime, 'getJobUsage').mockResolvedValue({
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
    }) as unknown as Mock;
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_jobs.description).toBe(
        'List all Mission Control jobs with status',
      );
    });

    it('should have optional status arg', () => {
      expect(mc_jobs.input.shape.status).toBeDefined();
    });
  });

  describe('empty state', () => {
    it('should return empty state message when no jobs exist', async () => {
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [],
        updatedAt: new Date().toISOString(),
      });

      const result = await mc_jobs.execute({}, mockContext);

      expect(result.content).toContain('Mission Control Jobs');
      expect(result.content).toContain('No jobs found');
    });
  });

  describe('job listing', () => {
    it('should list running jobs', async () => {
      const now = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'feature-auth',
            branch: 'mc/feature-auth',
            status: 'running',
            prompt: 'Add OAuth support',
            mode: 'plan',
            createdAt: now,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-feature-auth',
            placement: 'session',
          } as Job,
        ],
        updatedAt: now,
      });

      const result = await mc_jobs.execute({}, mockContext);

      expect(result.content).toContain('Running (1)');
      expect(result.content).toContain('feature-auth');
      expect(result.content).toContain('Add OAuth support');
      expect(result.content).toContain('mc/feature-auth');
    });

    it('should list completed jobs', async () => {
      const createdAt = new Date(Date.now() - 3600000).toISOString();
      const completedAt = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'refactor-api',
            branch: 'mc/refactor-api',
            status: 'completed',
            prompt: 'Refactor API endpoints',
            mode: 'ralph',
            createdAt,
            completedAt,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-refactor-api',
            placement: 'session',
          } as Job,
        ],
        updatedAt: completedAt,
      });

      const result = await mc_jobs.execute({}, mockContext);

      expect(result.content).toContain('Completed (1)');
      expect(result.content).toContain('refactor-api');
      expect(result.content).toContain('✓');
    });

    it('should list failed jobs', async () => {
      const now = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'fix-bug-123',
            branch: 'mc/fix-bug-123',
            status: 'failed',
            prompt: 'Fix login redirect issue',
            mode: 'vanilla',
            createdAt: now,
            exitCode: 1,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-fix-bug-123',
            placement: 'session',
          } as Job,
        ],
        updatedAt: now,
      });

      const result = await mc_jobs.execute({}, mockContext);

      expect(result.content).toContain('Failed (1)');
      expect(result.content).toContain('fix-bug-123');
      expect(result.content).toContain('✗');
    });

    it('should group jobs by status', async () => {
      const now = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'feature-auth',
            branch: 'mc/feature-auth',
            status: 'running',
            prompt: 'Add OAuth',
            mode: 'plan',
            createdAt: now,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-feature-auth',
            placement: 'session',
          } as Job,
          {
            id: 'job-2',
            name: 'refactor-api',
            branch: 'mc/refactor-api',
            status: 'completed',
            prompt: 'Refactor API',
            mode: 'ralph',
            createdAt: now,
            completedAt: now,
            worktreePath: '/tmp/wt2',
            tmuxTarget: 'mc-refactor-api',
            placement: 'session',
          } as Job,
        ],
        updatedAt: now,
      });

      const result = await mc_jobs.execute({}, mockContext);

      expect(result.content).toContain('Running (1)');
      expect(result.content).toContain('Completed (1)');
      expect(result.content).toContain('feature-auth');
      expect(result.content).toContain('refactor-api');
    });
  });

  describe('status filtering', () => {
    it('should filter by running status', async () => {
      const now = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'feature-auth',
            branch: 'mc/feature-auth',
            status: 'running',
            prompt: 'Add OAuth',
            mode: 'plan',
            createdAt: now,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-feature-auth',
            placement: 'session',
          } as Job,
          {
            id: 'job-2',
            name: 'refactor-api',
            branch: 'mc/refactor-api',
            status: 'completed',
            prompt: 'Refactor API',
            mode: 'ralph',
            createdAt: now,
            completedAt: now,
            worktreePath: '/tmp/wt2',
            tmuxTarget: 'mc-refactor-api',
            placement: 'session',
          } as Job,
        ],
        updatedAt: now,
      });

      const result = await mc_jobs.execute({ status: 'running' }, mockContext);

      expect(result.content).toContain('Running (1)');
      expect(result.content).toContain('feature-auth');
      expect(result.content).not.toContain('refactor-api');
    });

    it('should filter by completed status', async () => {
      const now = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'feature-auth',
            branch: 'mc/feature-auth',
            status: 'running',
            prompt: 'Add OAuth',
            mode: 'plan',
            createdAt: now,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-feature-auth',
            placement: 'session',
          } as Job,
          {
            id: 'job-2',
            name: 'refactor-api',
            branch: 'mc/refactor-api',
            status: 'completed',
            prompt: 'Refactor API',
            mode: 'ralph',
            createdAt: now,
            completedAt: now,
            worktreePath: '/tmp/wt2',
            tmuxTarget: 'mc-refactor-api',
            placement: 'session',
          } as Job,
        ],
        updatedAt: now,
      });

      const result = await mc_jobs.execute(
        { status: 'completed' },
        mockContext,
      );

      expect(result.content).toContain('Completed (1)');
      expect(result.content).toContain('refactor-api');
      expect(result.content).not.toContain('feature-auth');
    });

    it('should filter by failed status', async () => {
      const now = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'feature-auth',
            branch: 'mc/feature-auth',
            status: 'running',
            prompt: 'Add OAuth',
            mode: 'plan',
            createdAt: now,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-feature-auth',
            placement: 'session',
          } as Job,
          {
            id: 'job-2',
            name: 'fix-bug',
            branch: 'mc/fix-bug',
            status: 'failed',
            prompt: 'Fix bug',
            mode: 'vanilla',
            createdAt: now,
            exitCode: 1,
            worktreePath: '/tmp/wt2',
            tmuxTarget: 'mc-fix-bug',
            placement: 'session',
          } as Job,
        ],
        updatedAt: now,
      });

      const result = await mc_jobs.execute({ status: 'failed' }, mockContext);

      expect(result.content).toContain('Failed (1)');
      expect(result.content).toContain('fix-bug');
      expect(result.content).not.toContain('feature-auth');
    });

    it('should show all jobs when status is all', async () => {
      const now = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'feature-auth',
            branch: 'mc/feature-auth',
            status: 'running',
            prompt: 'Add OAuth',
            mode: 'plan',
            createdAt: now,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-feature-auth',
            placement: 'session',
          } as Job,
          {
            id: 'job-2',
            name: 'refactor-api',
            branch: 'mc/refactor-api',
            status: 'completed',
            prompt: 'Refactor API',
            mode: 'ralph',
            createdAt: now,
            completedAt: now,
            worktreePath: '/tmp/wt2',
            tmuxTarget: 'mc-refactor-api',
            placement: 'session',
          } as Job,
        ],
        updatedAt: now,
      });

      const result = await mc_jobs.execute({ status: 'all' }, mockContext);

      expect(result.content).toContain('Running (1)');
      expect(result.content).toContain('Completed (1)');
      expect(result.content).toContain('feature-auth');
      expect(result.content).toContain('refactor-api');
    });
  });

  describe('prompt truncation', () => {
    it('should truncate long prompts to ~50 chars', async () => {
      const now = new Date().toISOString();
      const longPrompt =
        'This is a very long prompt that should be truncated to approximately fifty characters';
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'test-job',
            branch: 'mc/test-job',
            status: 'running',
            prompt: longPrompt,
            mode: 'vanilla',
            createdAt: now,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-test-job',
            placement: 'session',
          } as Job,
        ],
        updatedAt: now,
      });

      const result = await mc_jobs.execute({}, mockContext);

      expect(result.content).toContain('This is a very long prompt that should be trunc...');
      expect(result.content).not.toContain(longPrompt);
    });

    it('should not truncate short prompts', async () => {
      const now = new Date().toISOString();
      const shortPrompt = 'Short prompt';
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'test-job',
            branch: 'mc/test-job',
            status: 'running',
            prompt: shortPrompt,
            mode: 'vanilla',
            createdAt: now,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-test-job',
            placement: 'session',
          } as Job,
        ],
        updatedAt: now,
      });

      const result = await mc_jobs.execute({}, mockContext);

      expect(result.content).toContain(shortPrompt);
    });
  });

  describe('output formatting', () => {
    it('should include job name, status, branch, session, agent and model', async () => {
      const now = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 4,
        jobs: [
          {
            id: 'job-1',
            name: 'feature-auth',
            branch: 'mc/feature-auth',
            status: 'running',
            prompt: 'Add OAuth support',
            createdAt: now,
            worktreePath: '/tmp/wt1',
            sessionID: 'ses_auth',
            agent: 'build',
            model: 'openai/gpt-5',
          } as Job,
        ],
        updatedAt: now,
      });

      const result = await mc_jobs.execute({});

      expect(result.content).toContain('feature-auth');
      expect(result.content).toContain('[running]');
      expect(result.content).toContain('Branch: mc/feature-auth | Started:');
      expect(result.content).toContain('Session: ses_auth | Agent: build | Model: openai/gpt-5');
      expect(result.content).not.toContain('Mode:');
    });

    it('should show cost and tokens for running jobs only', async () => {
      const now = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 4,
        jobs: [
          {
            id: 'job-1',
            name: 'running-job',
            branch: 'mc/running-job',
            status: 'running',
            prompt: 'Work',
            createdAt: now,
            worktreePath: '/tmp/wt1',
            sessionID: 'ses_running',
          } as Job,
          {
            id: 'job-2',
            name: 'done-job',
            branch: 'mc/done-job',
            status: 'completed',
            prompt: 'Work',
            createdAt: now,
            completedAt: now,
            worktreePath: '/tmp/wt2',
            sessionID: 'ses_done',
          } as Job,
        ],
        updatedAt: now,
      });
      mockGetJobUsage.mockResolvedValue({ cost: 0.25, inputTokens: 5000, outputTokens: 700 });

      const result = await mc_jobs.execute({});

      expect(mockGetJobUsage).toHaveBeenCalledTimes(1);
      expect(mockGetJobUsage).toHaveBeenCalledWith('ses_running');
      expect(result.content).toContain('Cost: $0.2500 | Tokens: 5000 in / 700 out');
      expect(result.content).toContain('Session: ses_done');
    });

    it('should omit usage when it cannot be read', async () => {
      const now = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 4,
        jobs: [
          {
            id: 'job-1',
            name: 'running-job',
            branch: 'mc/running-job',
            status: 'running',
            prompt: 'Work',
            createdAt: now,
            worktreePath: '/tmp/wt1',
            sessionID: 'ses_running',
          } as Job,
        ],
        updatedAt: now,
      });
      mockGetJobUsage.mockRejectedValue(new Error('session not found'));

      const result = await mc_jobs.execute({});

      expect(result.content).toContain('running-job [running]');
      expect(result.content).not.toContain('Cost:');
    });

    it('should omit the session line for a job without session details', async () => {
      const now = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 4,
        jobs: [
          {
            id: 'job-1',
            name: 'legacy-job',
            branch: 'mc/legacy-job',
            status: 'stopped',
            prompt: 'Work',
            createdAt: now,
            worktreePath: '/tmp/wt1',
          } as Job,
        ],
        updatedAt: now,
      });

      const result = await mc_jobs.execute({ status: 'all' });

      expect(result.content).toContain('legacy-job [stopped]');
      expect(result.content).not.toContain('Session:');
      expect(mockGetJobUsage).not.toHaveBeenCalled();
    });

    it('should show duration for running jobs', async () => {
      const createdAt = new Date(Date.now() - 3600000).toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'feature-auth',
            branch: 'mc/feature-auth',
            status: 'running',
            prompt: 'Add OAuth',
            mode: 'plan',
            createdAt,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-feature-auth',
            placement: 'session',
          } as Job,
        ],
        updatedAt: createdAt,
      });

      const result = await mc_jobs.execute({}, mockContext);

      expect(result.content).toContain('Started:');
    });

    it('should show completion time for completed jobs', async () => {
      const createdAt = new Date(Date.now() - 7200000).toISOString();
      const completedAt = new Date(Date.now() - 3600000).toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'refactor-api',
            branch: 'mc/refactor-api',
            status: 'completed',
            prompt: 'Refactor API',
            mode: 'ralph',
            createdAt,
            completedAt,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-refactor-api',
            placement: 'session',
          } as Job,
        ],
        updatedAt: completedAt,
      });

      const result = await mc_jobs.execute({}, mockContext);

      expect(result.content).toContain('Completed:');
    });

    it('should include status indicators', async () => {
      const now = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'running-job',
            branch: 'mc/running-job',
            status: 'running',
            prompt: 'Running',
            mode: 'vanilla',
            createdAt: now,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-running-job',
            placement: 'session',
          } as Job,
          {
            id: 'job-2',
            name: 'completed-job',
            branch: 'mc/completed-job',
            status: 'completed',
            prompt: 'Completed',
            mode: 'vanilla',
            createdAt: now,
            completedAt: now,
            worktreePath: '/tmp/wt2',
            tmuxTarget: 'mc-completed-job',
            placement: 'session',
          } as Job,
          {
            id: 'job-3',
            name: 'failed-job',
            branch: 'mc/failed-job',
            status: 'failed',
            prompt: 'Failed',
            mode: 'vanilla',
            createdAt: now,
            exitCode: 1,
            worktreePath: '/tmp/wt3',
            tmuxTarget: 'mc-failed-job',
            placement: 'session',
          } as Job,
        ],
        updatedAt: now,
      });

      const result = await mc_jobs.execute({}, mockContext);

      expect(result.content).toContain('▶');
      expect(result.content).toContain('✓');
      expect(result.content).toContain('✗');
    });
  });

  describe('default behavior', () => {
    it('should default to all status when not specified', async () => {
      const now = new Date().toISOString();
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'feature-auth',
            branch: 'mc/feature-auth',
            status: 'running',
            prompt: 'Add OAuth',
            mode: 'plan',
            createdAt: now,
            worktreePath: '/tmp/wt1',
            tmuxTarget: 'mc-feature-auth',
            placement: 'session',
          } as Job,
          {
            id: 'job-2',
            name: 'refactor-api',
            branch: 'mc/refactor-api',
            status: 'completed',
            prompt: 'Refactor API',
            mode: 'ralph',
            createdAt: now,
            completedAt: now,
            worktreePath: '/tmp/wt2',
            tmuxTarget: 'mc-refactor-api',
            placement: 'session',
          } as Job,
        ],
        updatedAt: now,
      });

      const result = await mc_jobs.execute({}, mockContext);

      expect(result.content).toContain('Running (1)');
      expect(result.content).toContain('Completed (1)');
    });
  });
});
