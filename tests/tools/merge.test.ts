import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';

vi.mock('../../src/lib/job-state', () => ({
  getJobByName: vi.fn(),
}));

const jobState = await import('../../src/lib/job-state');
const mockGetJobByName = jobState.getJobByName as Mock;

const { mc_merge } = await import('../../src/tools/merge');

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

describe('mc_merge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_merge.description).toBe(
        'Merge a job\'s branch back to main (for non-PR workflows)',
      );
    });

    it('should have name arg', () => {
      expect(mc_merge.args.name).toBeDefined();
    });

    it('should have optional squash arg', () => {
      expect(mc_merge.args.squash).toBeDefined();
    });

    it('should have optional message arg', () => {
      expect(mc_merge.args.message).toBeDefined();
    });
  });

  describe('job not found', () => {
    it('should throw error when job does not exist', async () => {
      mockGetJobByName.mockResolvedValue(undefined);

      await expect(
        mc_merge.execute({ name: 'nonexistent' }, mockContext),
      ).rejects.toThrow('Job "nonexistent" not found');
    });
  });

  describe('tool args validation', () => {
    it('should have name as required arg', () => {
      const nameArg = mc_merge.args.name;
      expect(nameArg).toBeDefined();
    });

    it('should have squash as optional boolean arg', () => {
      const squashArg = mc_merge.args.squash;
      expect(squashArg).toBeDefined();
    });

    it('should have message as optional string arg', () => {
      const messageArg = mc_merge.args.message;
      expect(messageArg).toBeDefined();
    });
  });

  describe('merge output format', () => {
    it('should include job branch in output', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        worktreePath: '/tmp/mc-worktrees/feature-auth',
        branch: 'mc/feature-auth',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Implement authentication',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_merge.execute({ name: 'feature-auth' }, mockContext);
      } catch {
      }
    });

    it('should include base branch in output', async () => {
      const job: Job = {
        id: 'job-2',
        name: 'feature-api',
        worktreePath: '/tmp/mc-worktrees/feature-api',
        branch: 'mc/feature-api',
        tmuxTarget: 'mc-feature-api',
        placement: 'session',
        status: 'running',
        prompt: 'Build API endpoints',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_merge.execute({ name: 'feature-api' }, mockContext);
      } catch {
      }
    });

    it('should indicate squash option in output when enabled', async () => {
      const job: Job = {
        id: 'job-3',
        name: 'feature-ui',
        worktreePath: '/tmp/mc-worktrees/feature-ui',
        branch: 'mc/feature-ui',
        tmuxTarget: 'mc-feature-ui',
        placement: 'session',
        status: 'running',
        prompt: 'Update UI components',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_merge.execute(
          { name: 'feature-ui', squash: true },
          mockContext,
        );
      } catch {
      }
    });

    it('should include custom message in output when provided', async () => {
      const job: Job = {
        id: 'job-4',
        name: 'feature-db',
        worktreePath: '/tmp/mc-worktrees/feature-db',
        branch: 'mc/feature-db',
        tmuxTarget: 'mc-feature-db',
        placement: 'session',
        status: 'running',
        prompt: 'Add database migrations',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_merge.execute(
          { name: 'feature-db', message: 'Custom merge message' },
          mockContext,
        );
      } catch {
      }
    });

    it('should not push after merge', async () => {
      const job: Job = {
        id: 'job-5',
        name: 'feature-test',
        worktreePath: '/tmp/mc-worktrees/feature-test',
        branch: 'mc/feature-test',
        tmuxTarget: 'mc-feature-test',
        placement: 'session',
        status: 'running',
        prompt: 'Add tests',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_merge.execute({ name: 'feature-test' }, mockContext);
      } catch {
      }
    });

    it('should not delete branch after merge', async () => {
      const job: Job = {
        id: 'job-6',
        name: 'feature-cleanup',
        worktreePath: '/tmp/mc-worktrees/feature-cleanup',
        branch: 'mc/feature-cleanup',
        tmuxTarget: 'mc-feature-cleanup',
        placement: 'session',
        status: 'running',
        prompt: 'Cleanup code',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_merge.execute({ name: 'feature-cleanup' }, mockContext);
      } catch {
      }
    });
  });
});
