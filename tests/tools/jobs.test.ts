import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';

vi.mock('../../src/lib/job-state', () => ({
  loadJobState: vi.fn(),
}));

const jobState = await import('../../src/lib/job-state');
const mockLoadJobState = jobState.loadJobState as Mock;

const { mc_jobs } = await import('../../src/tools/jobs');

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
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_jobs.description).toBe(
        'List all Mission Control jobs with status',
      );
    });

    it('should have optional status arg', () => {
      expect(mc_jobs.args.status).toBeDefined();
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

      expect(result).toContain('Mission Control Jobs');
      expect(result).toContain('No jobs found');
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

      expect(result).toContain('Running (1)');
      expect(result).toContain('feature-auth');
      expect(result).toContain('Add OAuth support');
      expect(result).toContain('mc/feature-auth');
      expect(result).toContain('plan');
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

      expect(result).toContain('Completed (1)');
      expect(result).toContain('refactor-api');
      expect(result).toContain('✓');
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

      expect(result).toContain('Failed (1)');
      expect(result).toContain('fix-bug-123');
      expect(result).toContain('✗');
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

      expect(result).toContain('Running (1)');
      expect(result).toContain('Completed (1)');
      expect(result).toContain('feature-auth');
      expect(result).toContain('refactor-api');
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

      expect(result).toContain('Running (1)');
      expect(result).toContain('feature-auth');
      expect(result).not.toContain('refactor-api');
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

      expect(result).toContain('Completed (1)');
      expect(result).toContain('refactor-api');
      expect(result).not.toContain('feature-auth');
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

      expect(result).toContain('Failed (1)');
      expect(result).toContain('fix-bug');
      expect(result).not.toContain('feature-auth');
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

      expect(result).toContain('Running (1)');
      expect(result).toContain('Completed (1)');
      expect(result).toContain('feature-auth');
      expect(result).toContain('refactor-api');
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

      expect(result).toContain('This is a very long prompt that should be trunc...');
      expect(result).not.toContain(longPrompt);
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

      expect(result).toContain(shortPrompt);
    });
  });

  describe('output formatting', () => {
    it('should include job name, status, branch, and mode', async () => {
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

      expect(result).toContain('feature-auth');
      expect(result).toContain('[running]');
      expect(result).toContain('mc/feature-auth');
      expect(result).toContain('Mode: plan');
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

      expect(result).toContain('Started:');
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

      expect(result).toContain('Completed:');
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

      expect(result).toContain('▶');
      expect(result).toContain('✓');
      expect(result).toContain('✗');
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

      expect(result).toContain('Running (1)');
      expect(result).toContain('Completed (1)');
    });
  });
});
