import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as worktree from '../../src/lib/worktree';

const { mc_sync } = await import('../../src/tools/sync');

let mockGetJobByName: Mock;
let mockSyncWorktree: Mock;

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
    status: 'running',
    prompt: 'Test prompt',
    mode: 'vanilla',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    ...overrides,
  };
}

describe('mc_sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockImplementation(() => undefined as any);
    mockSyncWorktree = vi.spyOn(worktree, 'syncWorktree').mockImplementation(() => undefined as any);
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_sync.description).toBe('Sync a job\'s branch with the base branch');
    });

    it('should have required arg: name', () => {
      expect(mc_sync.args.name).toBeDefined();
    });

    it('should have optional arg: strategy', () => {
      expect(mc_sync.args.strategy).toBeDefined();
    });
  });

  describe('job lookup', () => {
    it('should throw error when job not found', async () => {
      mockGetJobByName.mockResolvedValue(undefined);

      await expect(mc_sync.execute({ name: 'nonexistent' }, mockContext)).rejects.toThrow(
        'Job "nonexistent" not found',
      );
    });

    it('should call getJobByName with correct name', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockSyncWorktree.mockResolvedValue({ success: true });

      await mc_sync.execute({ name: 'my-job' }, mockContext);

      expect(mockGetJobByName).toHaveBeenCalledWith('my-job');
    });
  });

  describe('sync strategy', () => {
    beforeEach(() => {
      mockGetJobByName.mockResolvedValue(createMockJob());
    });

    it('should use rebase strategy by default', async () => {
      mockSyncWorktree.mockResolvedValue({ success: true });

      await mc_sync.execute({ name: 'test-job' }, mockContext);

      expect(mockSyncWorktree).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job', 'rebase', undefined, undefined,
      );
    });

    it('should use specified rebase strategy', async () => {
      mockSyncWorktree.mockResolvedValue({ success: true });

      await mc_sync.execute({ name: 'test-job', strategy: 'rebase' }, mockContext);

      expect(mockSyncWorktree).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job', 'rebase', undefined, undefined,
      );
    });

    it('should use specified merge strategy', async () => {
      mockSyncWorktree.mockResolvedValue({ success: true });

      await mc_sync.execute({ name: 'test-job', strategy: 'merge' }, mockContext);

      expect(mockSyncWorktree).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job', 'merge', undefined, undefined,
      );
    });
  });

  describe('successful sync', () => {
    beforeEach(() => {
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockSyncWorktree.mockResolvedValue({ success: true });
    });

    it('should return success message for rebase', async () => {
      const result = await mc_sync.execute({ name: 'test-job', strategy: 'rebase' }, mockContext);

      expect(result).toContain('Successfully synced job "test-job"');
      expect(result).toContain('rebase');
    });

    it('should return success message for merge', async () => {
      const result = await mc_sync.execute({ name: 'test-job', strategy: 'merge' }, mockContext);

      expect(result).toContain('Successfully synced job "test-job"');
      expect(result).toContain('merge');
    });

    it('should return success message with default strategy', async () => {
      const result = await mc_sync.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Successfully synced job "test-job"');
      expect(result).toContain('rebase');
    });
  });

  describe('sync with conflicts', () => {
    beforeEach(() => {
      mockGetJobByName.mockResolvedValue(createMockJob());
    });

    it('should report conflicts when sync fails', async () => {
      mockSyncWorktree.mockResolvedValue({
        success: false,
        conflicts: ['src/file1.ts', 'src/file2.ts'],
      });

      const result = await mc_sync.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Sync failed for job "test-job"');
      expect(result).toContain('Conflicts:');
      expect(result).toContain('src/file1.ts');
      expect(result).toContain('src/file2.ts');
    });

    it('should handle empty conflicts array', async () => {
      mockSyncWorktree.mockResolvedValue({
        success: false,
        conflicts: [],
      });

      const result = await mc_sync.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Sync failed for job "test-job"');
      expect(result).toContain('Conflicts:');
    });

    it('should handle missing conflicts field', async () => {
      mockSyncWorktree.mockResolvedValue({
        success: false,
      });

      const result = await mc_sync.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Sync failed for job "test-job"');
      expect(result).toContain('(no conflict details available)');
    });

    it('should suggest manual resolution', async () => {
      mockSyncWorktree.mockResolvedValue({
        success: false,
        conflicts: ['src/file.ts'],
      });

      const result = await mc_sync.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Resolve conflicts manually and try again');
    });
  });

  describe('source parameter', () => {
    beforeEach(() => {
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockSyncWorktree.mockResolvedValue({ success: true });
    });

    it('should have optional arg: source', () => {
      expect(mc_sync.args.source).toBeDefined();
    });

    it('should pass source=local to syncWorktree', async () => {
      await mc_sync.execute({ name: 'test-job', source: 'local' }, mockContext);

      expect(mockSyncWorktree).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job', 'rebase', undefined, 'local',
      );
    });

    it('should pass source=origin to syncWorktree', async () => {
      await mc_sync.execute({ name: 'test-job', source: 'origin' }, mockContext);

      expect(mockSyncWorktree).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job', 'rebase', undefined, 'origin',
      );
    });

    it('should pass baseBranch from job along with source', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob({ baseBranch: 'develop' }));

      await mc_sync.execute({ name: 'test-job', source: 'local' }, mockContext);

      expect(mockSyncWorktree).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job', 'rebase', 'develop', 'local',
      );
    });

    it('should pass baseBranch without source', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob({ baseBranch: 'develop' }));

      await mc_sync.execute({ name: 'test-job' }, mockContext);

      expect(mockSyncWorktree).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job', 'rebase', 'develop', undefined,
      );
    });
  });

  describe('different job names', () => {
    it('should work with different job names', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob({ name: 'feature-branch' }));
      mockSyncWorktree.mockResolvedValue({ success: true });

      const result = await mc_sync.execute({ name: 'feature-branch' }, mockContext);

      expect(result).toContain('feature-branch');
      expect(mockGetJobByName).toHaveBeenCalledWith('feature-branch');
    });
  });

  describe('edge cases', () => {
    it('should handle job with special characters in name', async () => {
      const jobName = 'test-job-123_special';
      mockGetJobByName.mockResolvedValue(createMockJob({ name: jobName }));
      mockSyncWorktree.mockResolvedValue({ success: true });

      const result = await mc_sync.execute({ name: jobName }, mockContext);

      expect(result).toContain(jobName);
    });

    it('should pass correct worktree path to syncWorktree', async () => {
      const worktreePath = '/custom/path/to/worktree';
      mockGetJobByName.mockResolvedValue(createMockJob({ worktreePath }));
      mockSyncWorktree.mockResolvedValue({ success: true });

      await mc_sync.execute({ name: 'test-job' }, mockContext);

      expect(mockSyncWorktree).toHaveBeenCalledWith(worktreePath, 'rebase', undefined, undefined);
    });
  });
});
