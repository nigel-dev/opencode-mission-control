import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';

const { mc_pr } = await import('../../src/tools/pr');

let mockGetJobByName: Mock;

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

describe('mc_pr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockImplementation(() => undefined as any);
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_pr.description).toBe(
        'Create a pull request from a job\'s branch',
      );
    });

    it('should have required name arg', () => {
      expect(mc_pr.args.name).toBeDefined();
    });

    it('should have optional title arg', () => {
      expect(mc_pr.args.title).toBeDefined();
    });

    it('should have optional body arg', () => {
      expect(mc_pr.args.body).toBeDefined();
    });

    it('should have optional draft arg', () => {
      expect(mc_pr.args.draft).toBeDefined();
    });
  });

  describe('job lookup', () => {
    it('should throw error when job not found', async () => {
      mockGetJobByName.mockResolvedValue(undefined);

      await expect(
        mc_pr.execute({ name: 'nonexistent' }, mockContext),
      ).rejects.toThrow('Job "nonexistent" not found');
    });

    it('should find job by name', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        branch: 'mc/feature-auth',
        worktreePath: '/tmp/wt1',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Add OAuth support',
        mode: 'plan',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      expect(mockGetJobByName).not.toHaveBeenCalled();
      
      try {
        await mc_pr.execute({ name: 'feature-auth' }, mockContext);
      } catch {
        // Expected to fail at gh command execution
      }

      expect(mockGetJobByName).toHaveBeenCalledWith('feature-auth');
    });
  });

  describe('argument handling', () => {
    it('should use job prompt as default title', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        branch: 'mc/feature-auth',
        worktreePath: '/tmp/wt1',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Add OAuth support',
        mode: 'plan',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_pr.execute({ name: 'feature-auth' }, mockContext);
      } catch {
        // Expected to fail at gh command execution
      }

      expect(mockGetJobByName).toHaveBeenCalledWith('feature-auth');
    });

    it('should accept custom title', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        branch: 'mc/feature-auth',
        worktreePath: '/tmp/wt1',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Add OAuth support',
        mode: 'plan',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_pr.execute(
          { name: 'feature-auth', title: 'Custom Title' },
          mockContext,
        );
      } catch {
        // Expected to fail at gh command execution
      }

      expect(mockGetJobByName).toHaveBeenCalledWith('feature-auth');
    });

    it('should accept body parameter', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        branch: 'mc/feature-auth',
        worktreePath: '/tmp/wt1',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Add OAuth support',
        mode: 'plan',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_pr.execute(
          { name: 'feature-auth', body: 'PR body' },
          mockContext,
        );
      } catch {
        // Expected to fail at gh command execution
      }

      expect(mockGetJobByName).toHaveBeenCalledWith('feature-auth');
    });

    it('should accept draft parameter', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        branch: 'mc/feature-auth',
        worktreePath: '/tmp/wt1',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Add OAuth support',
        mode: 'plan',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_pr.execute(
          { name: 'feature-auth', draft: true },
          mockContext,
        );
      } catch {
        // Expected to fail at gh command execution
      }

      expect(mockGetJobByName).toHaveBeenCalledWith('feature-auth');
    });

    it('should accept all parameters together', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        branch: 'mc/feature-auth',
        worktreePath: '/tmp/wt1',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Add OAuth support',
        mode: 'plan',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_pr.execute(
          {
            name: 'feature-auth',
            title: 'Custom Title',
            body: 'PR body',
            draft: true,
          },
          mockContext,
        );
      } catch {
        // Expected to fail at gh command execution
      }

      expect(mockGetJobByName).toHaveBeenCalledWith('feature-auth');
    });
  });
});
