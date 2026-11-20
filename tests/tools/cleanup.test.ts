import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as worktree from '../../src/lib/worktree';
import * as jobRuntime from '../../src/lib/job-runtime';
import * as planState from '../../src/lib/plan-state';
import * as worktreeStatus from '../../src/lib/worktree-status';
import * as git from '../../src/lib/git';
import type { PlanSpec } from '../../src/lib/plan-types';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let mockGetJobByName: Mock;
let mockRemoveJob: Mock;
let mockGetRunningJobs: Mock;
let mockLoadJobState: Mock;
let mockRemoveWorktree: Mock;
let mockStopJobSession: Mock;
let mockRemoveJobSession: Mock;
let mockWarn: Mock;
let mockLoadPlan: Mock;
let mockFindUncommitted: Mock;

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
    status: 'stopped',
    prompt: 'Test prompt',
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
    mockStopJobSession = vi.spyOn(jobRuntime, 'stopJobSession').mockImplementation(() => Promise.resolve() as any);
    mockRemoveJobSession = vi.spyOn(jobRuntime, 'removeJobSession').mockImplementation(() => Promise.resolve() as any);
    mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No plan, and worktrees with nothing uncommitted, unless a test says otherwise.
    mockLoadPlan = vi.spyOn(planState, 'loadPlan').mockResolvedValue(null) as unknown as Mock;
    mockFindUncommitted = vi.spyOn(worktreeStatus, 'findUncommittedChanges').mockResolvedValue([]) as unknown as Mock;
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
      expect(mc_cleanup.input.shape.name).toBeDefined();
    });

    it('should have optional all arg', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      expect(mc_cleanup.input.shape.all).toBeDefined();
    });

    it('should have optional deleteBranch arg', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      expect(mc_cleanup.input.shape.deleteBranch).toBeDefined();
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

      expect(result.content).toContain('Cleanup Results');
      expect(result.content).toContain('✓ Cleaned up job "test-job" (stopped)');
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

      expect(result.content).toContain('✓ Cleaned up job "test-job" (completed)');
    });

    it('should cleanup failed job successfully', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const failedJob = createMockJob({ status: 'failed' });
      mockGetJobByName.mockResolvedValue(failedJob);
      mockRemoveWorktree.mockResolvedValue(undefined);
      mockRemoveJob.mockResolvedValue(undefined);

      const result = await mc_cleanup.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('✓ Cleaned up job "test-job" (failed)');
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

      expect(result.content).toBe('No non-running jobs to cleanup.');
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

      expect(result.content).toContain('✓ Cleaned up job "job-1" (stopped)');
      expect(result.content).toContain('✓ Cleaned up job "job-2" (completed)');
      expect(result.content).not.toContain('job-3');
      expect(mockRemoveJob).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('should handle worktree removal failure', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      // The worktree directory still exists, so the failure is real.
      const job = createMockJob({ worktreePath: process.cwd() });
      mockGetJobByName.mockResolvedValue(job);
      mockRemoveWorktree.mockRejectedValue(new Error('Permission denied'));

      await expect(mc_cleanup.execute({ name: 'test-job' }, mockContext)).rejects.toThrow(
        'Failed to cleanup job "test-job"',
      );
    });

    it('should clean up a job whose worktree directory is already gone', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      // mc_plan_cancel removes worktrees but keeps the job records.
      const job = createMockJob({ worktreePath: '/tmp/mc-missing-worktree-for-cleanup-test' });
      mockGetJobByName.mockResolvedValue(job);
      mockRemoveWorktree.mockRejectedValue(new Error('Failed to remove worktree at /tmp/...'));

      const result = await mc_cleanup.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('Cleaned up job "test-job"');
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

      expect(result.content).toContain('✓ Cleaned up job "test-job"');
      expect(mockRemoveJob).toHaveBeenCalled();
    });
  });

  describe('job sessions', () => {
    it('should stop and remove the session of a cleaned job', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const job = createMockJob({ status: 'completed', sessionID: 'ses_done' });
      mockGetJobByName.mockResolvedValue(job);
      mockRemoveWorktree.mockResolvedValue(undefined);
      mockRemoveJob.mockResolvedValue(undefined);

      const result = await mc_cleanup.execute({ name: 'test-job' });

      expect(mockStopJobSession).toHaveBeenCalledWith('ses_done');
      expect(mockRemoveJobSession).toHaveBeenCalledWith('ses_done');
      expect(mockRemoveWorktree).toHaveBeenCalledWith(job.worktreePath, true);
      expect(mockRemoveJob).toHaveBeenCalledWith(job.id);
      expect(result.content).toContain('✓ Cleaned up job "test-job" (completed)');
    });

    it('should remove the session before the worktree', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      mockGetJobByName.mockResolvedValue(createMockJob({ sessionID: 'ses_done' }));
      const order: string[] = [];
      mockRemoveJobSession.mockImplementation(async () => {
        order.push('session');
      });
      mockRemoveWorktree.mockImplementation(async () => {
        order.push('worktree');
      });
      mockRemoveJob.mockResolvedValue(undefined);

      await mc_cleanup.execute({ name: 'test-job' });

      expect(order).toEqual(['session', 'worktree']);
    });

    it('should still clean up when the session no longer exists', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const job = createMockJob({ sessionID: 'ses_gone' });
      mockGetJobByName.mockResolvedValue(job);
      mockStopJobSession.mockRejectedValue(new Error('session not found'));
      mockRemoveJobSession.mockRejectedValue(new Error('session not found'));
      mockRemoveWorktree.mockResolvedValue(undefined);
      mockRemoveJob.mockResolvedValue(undefined);

      const result = await mc_cleanup.execute({ name: 'test-job' });

      expect(result.content).toContain('✓ Cleaned up job "test-job" (stopped)');
      expect(result.content).toContain('Summary: 1 cleaned, 0 failed');
      expect(mockRemoveWorktree).toHaveBeenCalledWith(job.worktreePath, true);
      expect(mockRemoveJob).toHaveBeenCalledWith(job.id);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('Could not remove session ses_gone'),
        expect.any(Error),
      );
    });

    it('should not touch the runtime for a job without a session', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockRemoveWorktree.mockResolvedValue(undefined);
      mockRemoveJob.mockResolvedValue(undefined);

      await mc_cleanup.execute({ name: 'test-job' });

      expect(mockStopJobSession).not.toHaveBeenCalled();
      expect(mockRemoveJobSession).not.toHaveBeenCalled();
    });
  });

  describe('uncommitted changes', () => {
    let worktreePath: string;

    beforeEach(() => {
      // The check only applies to a worktree that still exists.
      worktreePath = mkdtempSync(join(tmpdir(), 'mc-cleanup-dirty-'));
    });

    afterEach(() => {
      rmSync(worktreePath, { recursive: true, force: true });
    });

    it('should refuse to remove a worktree with uncommitted changes, and change nothing', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const job = createMockJob({ status: 'completed', worktreePath, sessionID: 'ses_job' });
      mockGetJobByName.mockResolvedValue(job);
      mockFindUncommitted.mockResolvedValue(['src/new.ts', 'README.md']);

      await expect(mc_cleanup.execute({ name: 'test-job' })).rejects.toThrow(
        /uncommitted changes that would be lost: src\/new\.ts, README\.md.*force: true/s,
      );

      expect(mockFindUncommitted).toHaveBeenCalledWith(job);
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
      expect(mockRemoveJobSession).not.toHaveBeenCalled();
      expect(mockRemoveJob).not.toHaveBeenCalled();
    });

    it('should remove it anyway with force', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const job = createMockJob({ status: 'completed', worktreePath });
      mockGetJobByName.mockResolvedValue(job);
      mockFindUncommitted.mockResolvedValue(['src/new.ts']);

      const result = await mc_cleanup.execute({ name: 'test-job', force: true });

      expect(result.content).toContain('✓ Cleaned up job "test-job" (completed)');
      expect(mockFindUncommitted).not.toHaveBeenCalled();
      expect(mockRemoveWorktree).toHaveBeenCalledWith(worktreePath, true);
      expect(mockRemoveJob).toHaveBeenCalledWith(job.id);
    });

    it('should refuse when the worktree cannot be checked', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      mockGetJobByName.mockResolvedValue(createMockJob({ status: 'completed', worktreePath }));
      mockFindUncommitted.mockRejectedValue(new Error('not a git repository'));

      await expect(mc_cleanup.execute({ name: 'test-job' })).rejects.toThrow('could not be checked');
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
    });

    it('with "all", should skip dirty worktrees, report them, and clean the rest', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const clean = createMockJob({ id: 'clean-id', name: 'clean', status: 'completed' });
      const dirty = createMockJob({ id: 'dirty-id', name: 'dirty', status: 'completed', worktreePath });
      mockLoadJobState.mockResolvedValue({ version: 4, jobs: [clean, dirty], updatedAt: new Date().toISOString() });
      mockFindUncommitted.mockResolvedValue(['notes.md']);

      const result = await mc_cleanup.execute({ all: true });

      expect(result.content).toContain('✓ Cleaned up job "clean" (completed)');
      expect(result.content).toContain('Skipped:');
      expect(result.content).toContain('- "dirty": its worktree has uncommitted changes that would be lost: notes.md');
      expect(result.content).toContain('Summary: 1 cleaned, 0 failed, 1 skipped');
      expect(mockRemoveJob).toHaveBeenCalledTimes(1);
      expect(mockRemoveJob).toHaveBeenCalledWith('clean-id');
    });

    it('should not count what Mission Control itself placed in the worktree', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      mockFindUncommitted.mockRestore();
      // git reports a symlinked node_modules, a copied .env, Hindsight's files
      // and the .opencode link as untracked. None of them is the job's work.
      const gitSpy = vi.spyOn(git, 'gitCommand').mockResolvedValue({
        stdout: '?? node_modules\0?? .env\0?? .hindsight/\0?? .opencode\0',
        stderr: '',
        exitCode: 0,
      });
      try {
        const job = createMockJob({
          status: 'completed',
          worktreePath,
          setupArtifacts: ['.env', '.opencode', 'node_modules'],
        });
        mockGetJobByName.mockResolvedValue(job);

        const result = await mc_cleanup.execute({ name: 'test-job' });

        expect(result.content).toContain('✓ Cleaned up job "test-job" (completed)');
      } finally {
        gitSpy.mockRestore();
      }
    });
  });

  describe('jobs of an active plan', () => {
    function makePlan(status: PlanSpec['status']): PlanSpec {
      return {
        id: 'plan-1',
        name: 'Feature Sprint',
        mode: 'supervisor',
        status,
        jobs: [],
        integrationBranch: 'mc/integration-plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      };
    }

    it('with "all", should skip jobs the plan still needs and say why', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const planJob = createMockJob({
        id: 'plan-job-id',
        name: 'plan-job',
        status: 'completed',
        planId: 'plan-1',
        worktreePath: '/tmp/mc-worktrees/plan-job',
      });
      const standalone = createMockJob({ id: 'solo-id', name: 'solo', status: 'completed' });
      const otherPlanJob = createMockJob({ id: 'old-id', name: 'old-plan-job', status: 'completed', planId: 'plan-0' });
      mockLoadJobState.mockResolvedValue({
        version: 4,
        jobs: [planJob, standalone, otherPlanJob],
        updatedAt: new Date().toISOString(),
      });
      mockLoadPlan.mockResolvedValue(makePlan('paused'));

      // Even forced: "all" never reaches into an active plan.
      const result = await mc_cleanup.execute({ all: true, deleteBranch: true, force: true });

      expect(result.content).toContain('✓ Cleaned up job "solo" (completed) and deleted branch');
      expect(result.content).toContain('✓ Cleaned up job "old-plan-job" (completed) and deleted branch');
      expect(result.content).toContain('- "plan-job": it belongs to the active plan "Feature Sprint" (paused)');
      expect(mockRemoveJob).not.toHaveBeenCalledWith('plan-job-id');
      expect(mockRemoveWorktree).not.toHaveBeenCalledWith(planJob.worktreePath, true);
    });

    it('should say so when everything was skipped', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      mockLoadJobState.mockResolvedValue({
        version: 4,
        jobs: [createMockJob({ name: 'plan-job', status: 'completed', planId: 'plan-1' })],
        updatedAt: new Date().toISOString(),
      });
      mockLoadPlan.mockResolvedValue(makePlan('running'));

      const result = await mc_cleanup.execute({ all: true });

      expect(result.content).toContain('No non-running jobs to cleanup.');
      expect(result.content).toContain('- "plan-job": it belongs to the active plan');
      expect(mockRemoveJob).not.toHaveBeenCalled();
    });

    it('should refuse a named plan job without force', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      mockGetJobByName.mockResolvedValue(createMockJob({ status: 'completed', planId: 'plan-1' }));
      mockLoadPlan.mockResolvedValue(makePlan('paused'));

      await expect(mc_cleanup.execute({ name: 'test-job', deleteBranch: true })).rejects.toThrow(
        /belongs to the active plan "Feature Sprint".*mc_plan_cancel.*force: true/s,
      );
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
      expect(mockRemoveJob).not.toHaveBeenCalled();
    });

    it('should remove a named plan job with force', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const job = createMockJob({ status: 'failed', planId: 'plan-1' });
      mockGetJobByName.mockResolvedValue(job);
      mockLoadPlan.mockResolvedValue(makePlan('paused'));

      const result = await mc_cleanup.execute({ name: 'test-job', force: true });

      expect(result.content).toContain('✓ Cleaned up job "test-job" (failed)');
      expect(mockRemoveJob).toHaveBeenCalledWith(job.id);
    });

    it.each(['completed', 'failed', 'canceled'] as const)(
      'should clean up the jobs of a plan that is %s',
      async (status) => {
        const { mc_cleanup } = await import('../../src/tools/cleanup');
        const job = createMockJob({ status: 'completed', planId: 'plan-1' });
        mockLoadJobState.mockResolvedValue({ version: 4, jobs: [job], updatedAt: new Date().toISOString() });
        mockLoadPlan.mockResolvedValue(makePlan(status));

        const result = await mc_cleanup.execute({ all: true });

        expect(result.content).toContain('✓ Cleaned up job "test-job" (completed)');
        expect(result.content).not.toContain('Skipped');
      },
    );

    it('should still clean up when the plan file cannot be read', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      mockGetJobByName.mockResolvedValue(createMockJob({ status: 'completed', planId: 'plan-1' }));
      mockLoadPlan.mockRejectedValue(new Error('Invalid plan state'));

      const result = await mc_cleanup.execute({ name: 'test-job' });

      expect(result.content).toContain('✓ Cleaned up job "test-job" (completed)');
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

      expect(result.content).toContain('Summary: 1 cleaned, 0 failed');
    });

    it('should show summary with failed cleanups', async () => {
      const { mc_cleanup } = await import('../../src/tools/cleanup');
      const job = createMockJob({ worktreePath: process.cwd() });
      mockGetJobByName.mockResolvedValue(job);
      mockRemoveWorktree.mockRejectedValue(new Error('Failed'));

      await expect(mc_cleanup.execute({ name: 'test-job' }, mockContext)).rejects.toThrow();
    });
  });
});
