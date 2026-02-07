import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as worktree from '../../src/lib/worktree';
import * as jobState from '../../src/lib/job-state';

const { getWorktreeContext } = await import('../../src/hooks/awareness');

let mockIsInManagedWorktree: Mock;
let mockLoadJobState: Mock;

describe('getWorktreeContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInManagedWorktree = vi.spyOn(worktree, 'isInManagedWorktree').mockImplementation(() => ({ isManaged: false } as any));
    mockLoadJobState = vi.spyOn(jobState, 'loadJobState').mockImplementation(() => ({ version: 1, jobs: [], updatedAt: new Date().toISOString() } as any));
  });

  describe('not in managed worktree', () => {
    it('should return isInJob: false when not in managed worktree', async () => {
      mockIsInManagedWorktree.mockResolvedValue({
        isManaged: false,
      });

      const context = await getWorktreeContext();

      expect(context).toEqual({ isInJob: false });
      expect(mockLoadJobState).not.toHaveBeenCalled();
    });
  });

  describe('in managed worktree', () => {
    it('should return job context when in managed worktree with matching job', async () => {
      const worktreePath = '/home/user/.local/share/opencode-mission-control/project/feature-auth';
      const now = new Date().toISOString();

      mockIsInManagedWorktree.mockResolvedValue({
        isManaged: true,
        worktreePath,
      });

      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'feature-auth',
            worktreePath,
            branch: 'mc/feature-auth',
            tmuxTarget: 'mc-feature-auth',
            placement: 'session',
            status: 'running',
            prompt: 'Add OAuth support',
            mode: 'plan',
            createdAt: now,
          } as Job,
        ],
        updatedAt: now,
      });

      const context = await getWorktreeContext();

      expect(context).toEqual({
        isInJob: true,
        jobName: 'feature-auth',
        jobPrompt: 'Add OAuth support',
        mode: 'plan',
      });
    });

    it('should return isInJob: true with undefined fields when no matching job', async () => {
      const worktreePath = '/home/user/.local/share/opencode-mission-control/project/feature-auth';
      const now = new Date().toISOString();

      mockIsInManagedWorktree.mockResolvedValue({
        isManaged: true,
        worktreePath,
      });

      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'other-job',
            worktreePath: '/different/path',
            branch: 'mc/other-job',
            tmuxTarget: 'mc-other-job',
            placement: 'session',
            status: 'running',
            prompt: 'Other task',
            mode: 'vanilla',
            createdAt: now,
          } as Job,
        ],
        updatedAt: now,
      });

      const context = await getWorktreeContext();

      expect(context).toEqual({
        isInJob: true,
        jobName: undefined,
        jobPrompt: undefined,
        mode: undefined,
      });
    });

    it('should handle empty job list', async () => {
      const worktreePath = '/home/user/.local/share/opencode-mission-control/project/feature-auth';

      mockIsInManagedWorktree.mockResolvedValue({
        isManaged: true,
        worktreePath,
      });

      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [],
        updatedAt: new Date().toISOString(),
      });

      const context = await getWorktreeContext();

      expect(context).toEqual({
        isInJob: true,
        jobName: undefined,
        jobPrompt: undefined,
        mode: undefined,
      });
    });

    it('should return correct mode for different execution modes', async () => {
      const worktreePath = '/home/user/.local/share/opencode-mission-control/project/ralph-job';
      const now = new Date().toISOString();

      mockIsInManagedWorktree.mockResolvedValue({
        isManaged: true,
        worktreePath,
      });

      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'ralph-job',
            worktreePath,
            branch: 'mc/ralph-job',
            tmuxTarget: 'mc-ralph-job',
            placement: 'session',
            status: 'running',
            prompt: 'Complex refactoring task',
            mode: 'ralph',
            createdAt: now,
          } as Job,
        ],
        updatedAt: now,
      });

      const context = await getWorktreeContext();

      expect(context.mode).toBe('ralph');
    });

    it('should handle multiple jobs and find correct one by worktreePath', async () => {
      const targetWorktreePath = '/home/user/.local/share/opencode-mission-control/project/target-job';
      const now = new Date().toISOString();

      mockIsInManagedWorktree.mockResolvedValue({
        isManaged: true,
        worktreePath: targetWorktreePath,
      });

      mockLoadJobState.mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'job-1',
            worktreePath: '/home/user/.local/share/opencode-mission-control/project/job-1',
            branch: 'mc/job-1',
            tmuxTarget: 'mc-job-1',
            placement: 'session',
            status: 'running',
            prompt: 'Task 1',
            mode: 'vanilla',
            createdAt: now,
          } as Job,
          {
            id: 'job-2',
            name: 'target-job',
            worktreePath: targetWorktreePath,
            branch: 'mc/target-job',
            tmuxTarget: 'mc-target-job',
            placement: 'session',
            status: 'running',
            prompt: 'Target task',
            mode: 'plan',
            createdAt: now,
          } as Job,
          {
            id: 'job-3',
            name: 'job-3',
            worktreePath: '/home/user/.local/share/opencode-mission-control/project/job-3',
            branch: 'mc/job-3',
            tmuxTarget: 'mc-job-3',
            placement: 'session',
            status: 'running',
            prompt: 'Task 3',
            mode: 'ulw',
            createdAt: now,
          } as Job,
        ],
        updatedAt: now,
      });

      const context = await getWorktreeContext();

      expect(context).toEqual({
        isInJob: true,
        jobName: 'target-job',
        jobPrompt: 'Target task',
        mode: 'plan',
      });
    });
  });
});
