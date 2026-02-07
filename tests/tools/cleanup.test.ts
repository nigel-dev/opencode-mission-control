import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as worktree from '../../src/lib/worktree';

let mockGetJobByName: Mock;
let mockRemoveJob: Mock;
let mockGetRunningJobs: Mock;
let mockLoadJobState: Mock;
let mockRemoveWorktree: Mock;

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

function createMockJob(overrides?: Partial<Job>): Job {
  return {
    id: 'test-job-id',
    name: 'test-job',
    worktreePath: '/tmp/mc-worktrees/test-job',
    branch: 'mc/test-job',
    tmuxTarget: 'mc-test-job',
    placement: 'session',
    status: 'stopped',
    prompt: 'Test prompt',
    mode: 'vanilla',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    ...overrides,
  };
}

describe('mc_cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockImplementation(() => undefined as any);
    mockRemoveJob = vi.spyOn(jobState, 'removeJob').mockImplementation(() => undefined as any);
    mockGetRunningJobs = vi.spyOn(jobState, 'getRunningJobs').mockImplementation(() => [] as any);
    mockLoadJobState = vi.spyOn(jobState, 'loadJobState').mockImplementation(() => ({ version: 1, jobs: [], updatedAt: new Date().toISOString() } as any));
    mockRemoveWorktree = vi.spyOn(worktree, 'removeWorktree').mockImplementation(() => undefined as any);
  });

  describe('tool definition', () => {
    it('should have correct description', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      expect(mc_cleanup.description).toBe(
        'Remove completed/stopped jobs and their worktrees',
      );
    });

    it('should have optional name arg', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      expect(mc_cleanup.args.name).toBeDefined();
    });

    it('should have optional all arg', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      expect(mc_cleanup.args.all).toBeDefined();
    });

    it('should have optional deleteBranch arg', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      expect(mc_cleanup.args.deleteBranch).toBeDefined();
    });
  });

  describe('argument validation', () => {
    it('should throw error when neither name nor all specified', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');

      await expect(mc_cleanup.execute({}, mockContext)).rejects.toThrow(
        'Must specify either "name" or "all" argument',
      );
    });

    it('should throw error when both name and all specified', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');

      await expect(
        mc_cleanup.execute({ name: 'test', all: true }, mockContext),
      ).rejects.toThrow('Cannot specify both "name" and "all" arguments');
    });
  });

  describe('cleanup by name', () => {
    it('should throw error when job not found', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      mockGetJobByName.mockResolvedValue(undefined);

      await expect(mc_cleanup.execute({ name: 'nonexistent' }, mockContext)).rejects.toThrow(
        'Job "nonexistent" not found',
      );
    });

    it('should throw error when trying to cleanup running job', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      mockGetJobByName.mockResolvedValue(
        createMockJob({ status: 'running' }),
      );

      await expect(mc_cleanup.execute({ name: 'test-job' }, mockContext)).rejects.toThrow(
        'Cannot cleanup running job "test-job". Use mc_kill to stop it first.',
      );
    });

    it('should cleanup stopped job successfully', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const stoppedJob = createMockJob({ status: 'stopped' });
      mockGetJobByName.mockResolvedValue(stoppedJob);
      mockRemoveWorktree.mockResolvedValue(undefined);
      mockRemoveJob.mockResolvedValue(undefined);

      const result = await mc_cleanup.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Cleanup Results');
      expect(result).toContain('✓ Cleaned up job "test-job" (stopped)');
      expect(mockRemoveWorktree).toHaveBeenCalledWith(
        stoppedJob.worktreePath,
        true,
      );
      expect(mockRemoveJob).toHaveBeenCalledWith(stoppedJob.id);
    });

    it('should cleanup completed job successfully', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const completedJob = createMockJob({ status: 'completed' });
      mockGetJobByName.mockResolvedValue(completedJob);
      mockRemoveWorktree.mockResolvedValue(undefined);
      mockRemoveJob.mockResolvedValue(undefined);

      const result = await mc_cleanup.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('✓ Cleaned up job "test-job" (completed)');
    });

    it('should cleanup failed job successfully', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const failedJob = createMockJob({ status: 'failed' });
      mockGetJobByName.mockResolvedValue(failedJob);
      mockRemoveWorktree.mockResolvedValue(undefined);
      mockRemoveJob.mockResolvedValue(undefined);

      const result = await mc_cleanup.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('✓ Cleaned up job "test-job" (failed)');
    });
  });

  describe('cleanup all non-running jobs', () => {
    it('should return message when no non-running jobs exist', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [createMockJob({ status: 'running' })],
        updatedAt: new Date().toISOString(),
      });

      const result = await mc_cleanup.execute({ all: true }, mockContext);

      expect(result).toBe('No non-running jobs to cleanup.');
    });

    it('should cleanup all non-running jobs', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const stoppedJob1 = createMockJob({ id: 'job-1', name: 'job-1', status: 'stopped' });
      const stoppedJob2 = createMockJob({ id: 'job-2', name: 'job-2', status: 'completed' });
      const runningJob = createMockJob({ id: 'job-3', name: 'job-3', status: 'running' });

      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [stoppedJob1, stoppedJob2, runningJob],
        updatedAt: new Date().toISOString(),
      });
      mockRemoveWorktree.mockResolvedValue(undefined);
      mockRemoveJob.mockResolvedValue(undefined);

      const result = await mc_cleanup.execute({ all: true }, mockContext);

      expect(result).toContain('✓ Cleaned up job "job-1" (stopped)');
      expect(result).toContain('✓ Cleaned up job "job-2" (completed)');
      expect(result).not.toContain('job-3');
      expect(mockRemoveJob).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('should handle worktree removal failure', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const job = createMockJob();
      mockGetJobByName.mockResolvedValue(job);
      mockRemoveWorktree.mockRejectedValue(new Error('Permission denied'));

      await expect(mc_cleanup.execute({ name: 'test-job' }, mockContext)).rejects.toThrow(
        'Failed to cleanup job "test-job"',
      );
    });

    it('should continue if worktree already removed', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const job = createMockJob();
      mockGetJobByName.mockResolvedValue(job);
      mockRemoveWorktree.mockRejectedValue(
        new Error('Worktree does not exist'),
      );
      mockRemoveJob.mockResolvedValue(undefined);

      const result = await mc_cleanup.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('✓ Cleaned up job "test-job"');
      expect(mockRemoveJob).toHaveBeenCalled();
    });
  });

  describe('output formatting', () => {
    it('should show summary with successful cleanups', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const job = createMockJob();
      mockGetJobByName.mockResolvedValue(job);
      mockRemoveWorktree.mockResolvedValue(undefined);
      mockRemoveJob.mockResolvedValue(undefined);

      const result = await mc_cleanup.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Summary: 1 cleaned, 0 failed');
    });

    it('should show summary with failed cleanups', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const job = createMockJob();
      mockGetJobByName.mockResolvedValue(job);
      mockRemoveWorktree.mockRejectedValue(new Error('Failed'));

      await expect(mc_cleanup.execute({ name: 'test-job' }, mockContext)).rejects.toThrow();
    });
  });
});
