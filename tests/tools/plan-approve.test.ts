import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as planState from '../../src/lib/plan-state';
import * as orchestrator from '../../src/lib/orchestrator';
import * as config from '../../src/lib/config';
import * as integration from '../../src/lib/integration';
import * as mergeTrain from '../../src/lib/merge-train';

const { mc_plan_approve } = await import('../../src/tools/plan-approve');

const mockContext = {
  sessionID: 'test-session',
  messageID: 'test-message',
  agent: 'test-agent',
  directory: '/test/dir',
  worktree: '/test/worktree',
  abort: new AbortController().signal,
  metadata: mock(),
  ask: mock(),
} as any;

describe('mc_plan_approve', () => {
  beforeEach(() => {
    mock.restore();
    spyOn(config, 'loadConfig').mockResolvedValue({
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    });
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_plan_approve.description).toContain('copilot');
    });
  });

  describe('no active plan', () => {
    it('should throw error when no plan exists', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue(null);

      expect(
        mc_plan_approve.execute({}, mockContext),
      ).rejects.toThrow('No active plan to approve');
    });
  });

  describe('non-pending plan', () => {
    it('should throw error when plan is not pending', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Test Plan',
        mode: 'copilot',
        status: 'running',
        jobs: [],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      });

      expect(
        mc_plan_approve.execute({}, mockContext),
      ).rejects.toThrow('not pending');
    });
  });

  describe('retry validation', () => {
    it('should reject when both retry and relaunch are provided', async () => {
      expect(
        mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'bad-job', relaunch: 'bad-job' }, mockContext),
      ).rejects.toThrow('Cannot specify both "retry" and "relaunch"');
    });

    it('should reset a failed job to ready_to_merge when retry is provided', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue({
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

      const mockSavePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const mockResumePlan = mock().mockResolvedValue(undefined);
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockImplementation(mockResumePlan);
      spyOn(orchestrator.Orchestrator.prototype, 'setPlanModelSnapshot').mockImplementation(() => {});

      const result = await mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'bad-job' }, mockContext);

      expect(mockSavePlan).toHaveBeenCalledWith(expect.objectContaining({
        status: 'running',
        jobs: expect.arrayContaining([
          expect.objectContaining({ name: 'bad-job', status: 'ready_to_merge' }),
        ]),
      }));
      expect(result).toContain('bad-job');
      expect(result).toContain('ready_to_merge');
      expect(mockResumePlan).toHaveBeenCalled();
    });

    it('should accept touchSet violations and move failed job to ready_to_merge', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'TouchSet Plan',
        mode: 'supervisor',
        status: 'paused',
        checkpoint: 'on_error',
        checkpointContext: {
          jobName: 'touch-job',
          failureKind: 'touchset',
          touchSetViolations: ['README.md'],
          touchSetPatterns: ['src/**'],
        },
        jobs: [
          { id: 'j1', name: 'touch-job', prompt: 'fix files', status: 'failed', error: 'touchSet violation' },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      const mockSavePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const mockResumePlan = mock().mockResolvedValue(undefined);
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockImplementation(mockResumePlan);
      spyOn(orchestrator.Orchestrator.prototype, 'setPlanModelSnapshot').mockImplementation(() => {});

      const result = await mc_plan_approve.execute({ checkpoint: 'on_error' }, mockContext);

      expect(mockSavePlan).toHaveBeenCalledWith(expect.objectContaining({
        status: 'running',
        checkpoint: null,
        checkpointContext: null,
        jobs: expect.arrayContaining([
          expect.objectContaining({ name: 'touch-job', status: 'ready_to_merge' }),
        ]),
      }));
      expect(mockResumePlan).toHaveBeenCalled();
      expect(result).toContain('TouchSet violations for job "touch-job" accepted');
    });

    it('should relaunch touchSet-failed job for correction', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'TouchSet Relaunch Plan',
        mode: 'supervisor',
        status: 'paused',
        checkpoint: 'on_error',
        checkpointContext: {
          jobName: 'touch-job',
          failureKind: 'touchset',
          touchSetViolations: ['README.md'],
          touchSetPatterns: ['src/**'],
        },
        jobs: [
          {
            id: 'j1',
            name: 'touch-job',
            prompt: 'fix files',
            status: 'failed',
            touchSet: ['src/**'],
            branch: 'mc/plan/plan-1/touch-job',
          },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      const mockSavePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const mockResumePlan = mock().mockResolvedValue(undefined);
      const relaunchSpy = mock().mockResolvedValue(undefined);
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockImplementation(mockResumePlan);
      spyOn(orchestrator.Orchestrator.prototype, 'relaunchJobForCorrection').mockImplementation(relaunchSpy);
      spyOn(orchestrator.Orchestrator.prototype, 'setPlanModelSnapshot').mockImplementation(() => {});

      const result = await mc_plan_approve.execute({ checkpoint: 'on_error', relaunch: 'touch-job' }, mockContext);

      expect(mockSavePlan).toHaveBeenCalledWith(expect.objectContaining({
        status: 'running',
        checkpoint: null,
        checkpointContext: null,
      }));
      expect(relaunchSpy).toHaveBeenCalledWith('touch-job', ['README.md'], ['src/**']);
      expect(mockResumePlan).toHaveBeenCalled();
      expect(result).toContain('relaunched with correction prompt');
    });

    it('should re-validate touchSet on retry before proceeding', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'TouchSet Retry Plan',
        mode: 'supervisor',
        status: 'paused',
        checkpoint: 'on_error',
        checkpointContext: {
          jobName: 'touch-job',
          failureKind: 'touchset',
          touchSetViolations: ['README.md'],
          touchSetPatterns: ['src/**'],
        },
        jobs: [
          {
            id: 'j1',
            name: 'touch-job',
            prompt: 'fix files',
            status: 'failed',
            touchSet: ['src/**'],
            branch: 'mc/plan/plan-1/touch-job',
          },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      const validateSpy = spyOn(mergeTrain, 'validateTouchSet').mockResolvedValue({
        valid: true,
        changedFiles: ['src/main.ts'],
      });
      const mockSavePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const mockResumePlan = mock().mockResolvedValue(undefined);
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockImplementation(mockResumePlan);
      spyOn(orchestrator.Orchestrator.prototype, 'setPlanModelSnapshot').mockImplementation(() => {});

      const result = await mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'touch-job' }, mockContext);

      expect(validateSpy).toHaveBeenCalledWith('mc/plan/plan-1/touch-job', 'mc/integration/plan-1', ['src/**']);
      expect(mockSavePlan).toHaveBeenCalledWith(expect.objectContaining({
        status: 'running',
        jobs: expect.arrayContaining([
          expect.objectContaining({ name: 'touch-job', status: 'ready_to_merge' }),
        ]),
      }));
      expect(mockResumePlan).toHaveBeenCalled();
      expect(result).toContain('touch-job');
      expect(result).toContain('ready_to_merge');
    });

    it('should reject retry when touchSet remains violated after manual fix', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'TouchSet Retry Plan',
        mode: 'supervisor',
        status: 'paused',
        checkpoint: 'on_error',
        checkpointContext: {
          jobName: 'touch-job',
          failureKind: 'touchset',
          touchSetViolations: ['README.md'],
          touchSetPatterns: ['src/**'],
        },
        jobs: [
          {
            id: 'j1',
            name: 'touch-job',
            prompt: 'fix files',
            status: 'failed',
            touchSet: ['src/**'],
            branch: 'mc/plan/plan-1/touch-job',
          },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      spyOn(mergeTrain, 'validateTouchSet').mockResolvedValue({
        valid: false,
        violations: ['README.md'],
        changedFiles: ['src/main.ts', 'README.md'],
      });

      expect(
        mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'touch-job' }, mockContext),
      ).rejects.toThrow('still has touchSet violations after manual fix');
    });

    it('should reject relaunch when failure is not touchSet-related', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Non TouchSet Plan',
        mode: 'supervisor',
        status: 'paused',
        checkpoint: 'on_error',
        checkpointContext: {
          jobName: 'bad-job',
          failureKind: 'test_failure',
        },
        jobs: [
          { id: 'j1', name: 'bad-job', prompt: 'fix', status: 'failed', error: 'tests failed' },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      expect(
        mc_plan_approve.execute({ checkpoint: 'on_error', relaunch: 'bad-job' }, mockContext),
      ).rejects.toThrow('was not failed due to a touchSet violation');
    });

    it('should allow retry of needs_rebase jobs', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue({
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

      const mockSavePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const mockResumePlan = mock().mockResolvedValue(undefined);
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockImplementation(mockResumePlan);
      spyOn(orchestrator.Orchestrator.prototype, 'setPlanModelSnapshot').mockImplementation(() => {});

      const result = await mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'conflicting-job' }, mockContext);

      expect(mockSavePlan).toHaveBeenCalledWith(expect.objectContaining({
        status: 'running',
        jobs: expect.arrayContaining([
          expect.objectContaining({ name: 'conflicting-job', status: 'ready_to_merge' }),
        ]),
      }));
      expect(result).toContain('Checkpoint');
      expect(result).toContain('ready_to_merge');
      expect(mockResumePlan).toHaveBeenCalled();
    });

    it('should throw if retry job name is not found in plan', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue({
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

      expect(
        mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'nonexistent' }, mockContext),
      ).rejects.toThrow('Job "nonexistent" not found in plan');
    });

    it('should reject retry of non-retryable jobs', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue({
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

      expect(
        mc_plan_approve.execute({ retry: 'running-job' }, mockContext),
      ).rejects.toThrow('not in a retryable state');
    });

    it('should clear checkpoint without retry (backward compatible)', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue({
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

      const mockSavePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const mockResumePlan = mock().mockResolvedValue(undefined);
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockImplementation(mockResumePlan);
      spyOn(orchestrator.Orchestrator.prototype, 'setPlanModelSnapshot').mockImplementation(() => {});

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
      spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Feature Sprint',
        mode: 'copilot',
        status: 'pending',
        jobs: [
          { id: 'j1', name: 'auth', prompt: 'do auth', status: 'queued' },
          { id: 'j2', name: 'api', prompt: 'do api', status: 'queued' },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      const mockSavePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const mockResumePlan = mock().mockResolvedValue(undefined);
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockImplementation(mockResumePlan);
      spyOn(orchestrator.Orchestrator.prototype, 'setPlanModelSnapshot').mockImplementation(() => {});
      spyOn(integration, 'createIntegrationBranch').mockResolvedValue({
        branch: 'mc/integration-plan-1',
        worktreePath: '/tmp/mc-integration-plan-1',
      });

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
