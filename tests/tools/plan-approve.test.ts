import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as planState from '../../src/lib/plan-state';
import * as orchestrator from '../../src/lib/orchestrator';
import * as config from '../../src/lib/config';
import * as monitor from '../../src/lib/monitor';
import * as integration from '../../src/lib/integration';
import * as worktreeSetup from '../../src/lib/worktree-setup';

const { mc_plan_approve } = await import('../../src/tools/plan-approve');

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

describe('mc_plan_approve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    });
    vi.spyOn(monitor, 'JobMonitor').mockImplementation(
      () => ({ start: vi.fn(), on: vi.fn(), off: vi.fn() }) as any,
    );
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_plan_approve.description).toContain('copilot');
    });
  });

  describe('no active plan', () => {
    it('should throw error when no plan exists', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);

      await expect(
        mc_plan_approve.execute({}, mockContext),
      ).rejects.toThrow('No active plan to approve');
    });
  });

  describe('non-pending plan', () => {
    it('should throw error when plan is not pending', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Test Plan',
        mode: 'copilot',
        status: 'running',
        jobs: [],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      });

      await expect(
        mc_plan_approve.execute({}, mockContext),
      ).rejects.toThrow('not pending');
    });
  });

  describe('retry validation', () => {
    it('should reset a failed job to ready_to_merge when retry is provided', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Retry Plan',
        mode: 'autopilot',
        status: 'paused',
        checkpoint: 'on_error',
        jobs: [
          { id: 'j1', name: 'good-job', prompt: 'do good', status: 'merged' },
          { id: 'j2', name: 'bad-job', prompt: 'do bad', status: 'failed', error: 'test failure' },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      const mockSavePlan = vi.spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const mockUpdatePlanJob = vi.spyOn(planState, 'updatePlanJob').mockResolvedValue(undefined);
      const mockResumePlan = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(orchestrator, 'Orchestrator').mockImplementation(
        () =>
          ({
            resumePlan: mockResumePlan,
            setPlanModelSnapshot: vi.fn(),
          }) as any,
      );

      const result = await mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'bad-job' }, mockContext);

      expect(mockUpdatePlanJob).toHaveBeenCalledWith('plan-1', 'bad-job', { status: 'ready_to_merge', error: undefined });
      expect(result).toContain('bad-job');
      expect(result).toContain('ready_to_merge');
      expect(result).toContain('resuming');
      expect(mockSavePlan).toHaveBeenCalled();
      expect(mockResumePlan).toHaveBeenCalled();
    });

    it('should allow retry of needs_rebase jobs', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Test Plan',
        mode: 'supervisor',
        status: 'paused',
        checkpoint: 'on_error',
        jobs: [
          { id: 'j1', name: 'conflicting-job', prompt: 'do stuff', status: 'needs_rebase', error: 'merge conflict detected' },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      });

      const mockUpdatePlanJob = vi.spyOn(planState, 'updatePlanJob').mockResolvedValue(undefined);
      const mockSavePlan = vi.spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const mockResumePlan = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(orchestrator, 'Orchestrator').mockImplementation(
        () =>
          ({
            resumePlan: mockResumePlan,
            setPlanModelSnapshot: vi.fn(),
          }) as any,
      );

      const result = await mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'conflicting-job' }, mockContext);

      expect(mockUpdatePlanJob).toHaveBeenCalledWith('plan-1', 'conflicting-job', { status: 'ready_to_merge', error: undefined });
      expect(result).toContain('Checkpoint');
      expect(result).toContain('resuming');
      expect(mockSavePlan).toHaveBeenCalled();
      expect(mockResumePlan).toHaveBeenCalled();
    });

    it('should throw if retry job name is not found in plan', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Retry Plan',
        mode: 'autopilot',
        status: 'paused',
        checkpoint: 'on_error',
        jobs: [{ id: 'j1', name: 'existing-job', prompt: 'do stuff', status: 'failed' }],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      await expect(
        mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'nonexistent' }, mockContext),
      ).rejects.toThrow('Job "nonexistent" not found in plan');
    });

    it('should reject retry of non-retryable jobs', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Test Plan',
        mode: 'supervisor',
        status: 'paused',
        checkpoint: 'on_error',
        jobs: [{ id: 'j1', name: 'running-job', prompt: 'do stuff', status: 'running' }],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      });

      await expect(
        mc_plan_approve.execute({ retry: 'running-job' }, mockContext),
      ).rejects.toThrow('not in a retryable state');
    });

    it('should clear checkpoint without retry (backward compatible)', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Checkpoint Plan',
        mode: 'supervisor',
        status: 'paused',
        checkpoint: 'pre_merge',
        jobs: [{ id: 'j1', name: 'merge-job', prompt: 'do merge', status: 'ready_to_merge' }],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      const mockSavePlan = vi.spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const mockResumePlan = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(orchestrator, 'Orchestrator').mockImplementation(
        () =>
          ({
            resumePlan: mockResumePlan,
            setPlanModelSnapshot: vi.fn(),
          }) as any,
      );

      const result = await mc_plan_approve.execute({ checkpoint: 'pre_merge' }, mockContext);

      expect(result).toContain('Checkpoint "pre_merge" cleared');
      expect(result).toContain('resuming');
      expect(result).not.toContain('ready_to_merge');
      expect(mockSavePlan).toHaveBeenCalled();
      expect(mockResumePlan).toHaveBeenCalled();
    });
  });

  describe('approve pending plan', () => {
    it('should transition plan to running and resume via orchestrator', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Feature Sprint',
        mode: 'copilot',
        status: 'pending',
        jobs: [
          { id: 'j1', name: 'auth', prompt: 'do auth', status: 'queued' },
          { id: 'j2', name: 'api', prompt: 'do api', status: 'queued' },
        ],
        integrationBranch: 'mc/integration-plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      const mockSavePlan = vi.spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const mockResumePlan = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(orchestrator, 'Orchestrator').mockImplementation(
        () =>
          ({
            resumePlan: mockResumePlan,
            setPlanModelSnapshot: vi.fn(),
          }) as any,
      );
      vi.spyOn(integration, 'createIntegrationBranch').mockResolvedValue({
        branch: 'mc/integration-plan-1',
        worktreePath: '/tmp/integration-plan-1',
      });
      vi.spyOn(worktreeSetup, 'resolvePostCreateHook').mockReturnValue(undefined as any);

      const result = await mc_plan_approve.execute({}, mockContext);

      expect(result).toContain('approved and started');
      expect(result).toContain('plan-1');
      expect(result).toContain('Jobs: 2');
      expect(result).toContain('mc_plan_status');
      expect(mockSavePlan).toHaveBeenCalled();
      expect(mockResumePlan).toHaveBeenCalled();
    });
  });
});
