import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as planState from '../../src/lib/plan-state';
import * as orchestrator from '../../src/lib/orchestrator';
import * as config from '../../src/lib/config';
import * as integration from '../../src/lib/integration';
import * as mergeTrain from '../../src/lib/merge-train';
import * as singleton from '../../src/lib/orchestrator-singleton';
import * as jobState from '../../src/lib/job-state';
import * as worktreeStatus from '../../src/lib/worktree-status';
import * as modelTracker from '../../src/lib/model-tracker';
import type { PlanSpec } from '../../src/lib/plan-types';

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
    // Each test starts without a live orchestrator from the one before it.
    singleton.setSharedOrchestrator(null);
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
      expect(result.content).toContain('bad-job');
      expect(result.content).toContain('ready_to_merge');
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
      expect(result.content).toContain('TouchSet violations for job "touch-job" accepted');
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
      expect(result.content).toContain('relaunched with correction prompt');
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
      expect(result.content).toContain('touch-job');
      expect(result.content).toContain('ready_to_merge');
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
      expect(result.content).toContain('Checkpoint');
      expect(result.content).toContain('ready_to_merge');
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

      expect(result.content).toContain('Checkpoint "pre_merge" cleared');
      expect(result.content).toContain('resuming');
      expect(result.content).not.toContain('ready_to_merge');
      expect(mockSavePlan).toHaveBeenCalledWith(expect.objectContaining({
        approvedMergeJobs: ['merge-job'],
      }));
      expect(mockResumePlan).toHaveBeenCalled();
    });

    it('should persist pre_pr approval so a fresh orchestrator does not re-pause', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Pre-PR Plan',
        mode: 'supervisor',
        status: 'paused',
        checkpoint: 'pre_pr',
        jobs: [{ id: 'j1', name: 'done-job', prompt: 'do merge', status: 'merged' }],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      const mockSavePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const mockResumePlan = mock().mockResolvedValue(undefined);
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockImplementation(mockResumePlan);
      spyOn(orchestrator.Orchestrator.prototype, 'setPlanModelSnapshot').mockImplementation(() => {});

      const result = await mc_plan_approve.execute({ checkpoint: 'pre_pr' }, mockContext);

      expect(result.content).toContain('Checkpoint "pre_pr" cleared');
      expect(mockSavePlan).toHaveBeenCalledWith(expect.objectContaining({
        approvedPrePr: true,
      }));
      expect(mockResumePlan).toHaveBeenCalled();
    });
  });

  describe('one live orchestrator', () => {
    function pausedPlan(overrides: Partial<PlanSpec> = {}): PlanSpec {
      return {
        id: 'plan-1',
        name: 'Lifecycle Plan',
        mode: 'supervisor',
        status: 'paused',
        checkpoint: 'pre_merge',
        jobs: [{ id: 'j1', name: 'merge-job', prompt: 'do merge', status: 'ready_to_merge' }],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
        ...overrides,
      };
    }

    it('retires the orchestrator that paused the plan, and waits for it, before changing the plan', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue(pausedPlan());
      const order: string[] = [];
      spyOn(planState, 'savePlan').mockImplementation(async () => {
        order.push('plan saved');
      });
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockImplementation(async () => {
        order.push('plan resumed');
      });
      const live = {
        dispose: mock(async () => {
          // A reconcile pass that is still finishing a merge.
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push('old orchestrator disposed');
        }),
      };
      singleton.setSharedOrchestrator(live as any);

      await mc_plan_approve.execute({ checkpoint: 'pre_merge' }, mockContext);

      expect(live.dispose).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['old orchestrator disposed', 'plan saved', 'plan resumed']);
      expect(singleton.getSharedOrchestrator()).toBeInstanceOf(orchestrator.Orchestrator);
      expect(singleton.getSharedOrchestrator()).not.toBe(live);
    });

    it('works from the plan as the retired orchestrator left it', async () => {
      // The retired orchestrator's last pass merged a job after the approval
      // was requested. A stale copy of the plan must not undo that.
      const before = pausedPlan({
        jobs: [
          { id: 'j1', name: 'merge-job', prompt: 'do merge', status: 'ready_to_merge' },
          { id: 'j2', name: 'in-flight', prompt: 'x', status: 'merging' },
        ],
      });
      const after = pausedPlan({
        jobs: [
          { id: 'j1', name: 'merge-job', prompt: 'do merge', status: 'ready_to_merge' },
          { id: 'j2', name: 'in-flight', prompt: 'x', status: 'merged' },
        ],
      });
      let disposed = false;
      spyOn(planState, 'loadPlan').mockImplementation(async () => (disposed ? after : before));
      const savePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockResolvedValue(undefined);
      singleton.setSharedOrchestrator({
        dispose: mock(async () => {
          disposed = true;
        }),
      } as any);

      await mc_plan_approve.execute({ checkpoint: 'pre_merge' }, mockContext);

      expect(savePlan).toHaveBeenCalledWith(
        expect.objectContaining({
          jobs: expect.arrayContaining([expect.objectContaining({ name: 'in-flight', status: 'merged' })]),
        }),
      );
    });

    it('leaves the live orchestrator alone when there is nothing to approve', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue(pausedPlan({ status: 'running', checkpoint: null }));
      const live = { dispose: mock(async () => {}) };
      singleton.setSharedOrchestrator(live as any);

      await expect(mc_plan_approve.execute({}, mockContext)).rejects.toThrow('not pending or paused');

      // Retiring it here would orphan a running plan.
      expect(live.dispose).not.toHaveBeenCalled();
      expect(singleton.getSharedOrchestrator()).toBe(live as any);
      singleton.setSharedOrchestrator(null);
    });

    it("does not replace the plan's model with whatever model was used last", async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue(pausedPlan({ model: 'anthropic/claude-sonnet-4' }));
      const savePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockResolvedValue(undefined);
      const snapshot = spyOn(orchestrator.Orchestrator.prototype, 'setPlanModelSnapshot');
      const getCurrentModel = spyOn(modelTracker, 'getCurrentModel').mockReturnValue('other/model');

      await mc_plan_approve.execute({ checkpoint: 'pre_merge' }, mockContext);

      expect(getCurrentModel).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      expect(savePlan).toHaveBeenCalledWith(expect.objectContaining({ model: 'anthropic/claude-sonnet-4' }));
    });
  });

  describe('retrying a job that never launched', () => {
    it('queues the job again instead of trying to merge a branch with no work', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Launch Plan',
        mode: 'autopilot',
        status: 'paused',
        checkpoint: 'on_error',
        checkpointContext: { jobName: 'never-ran', failureKind: 'launch_failed', reason: 'Invalid model "x"' },
        jobs: [{ id: 'j1', name: 'never-ran', prompt: 'x', status: 'failed', error: 'Invalid model "x"' }],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });
      const savePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockResolvedValue(undefined);

      const result = await mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'never-ran' }, mockContext);

      const saved = savePlan.mock.calls[0][0] as PlanSpec;
      expect(saved.status).toBe('running');
      expect(saved.jobs[0]).toMatchObject({ name: 'never-ran', status: 'queued' });
      expect(saved.jobs[0].error).toBeUndefined();
      // Nothing was merged or approved for merge: the job has to run first.
      expect(saved.approvedMergeJobs ?? []).not.toContain('never-ran');
      expect(result.content).toContain('reset to queued');
    });
  });

  describe('uncommitted changes checkpoint', () => {
    function dirtyPlan(): PlanSpec {
      return {
        id: 'plan-1',
        name: 'Dirty Plan',
        mode: 'autopilot',
        status: 'paused',
        checkpoint: 'on_error',
        checkpointContext: { jobName: 'dirty', failureKind: 'uncommitted_changes', reason: 'uncommitted changes' },
        jobs: [{ id: 'j1', name: 'dirty', prompt: 'x', status: 'failed', error: 'uncommitted changes' }],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      };
    }

    function stateWithDirtyJob(): void {
      spyOn(jobState, 'loadJobState').mockResolvedValue({
        version: 4,
        jobs: [
          {
            id: 'state-1',
            name: 'dirty',
            worktreePath: '/tmp/wt/dirty',
            branch: 'mc/plan/plan-1/dirty',
            status: 'completed',
            prompt: 'x',
            createdAt: new Date().toISOString(),
            planId: 'plan-1',
            uncommittedChanges: ['src/new.ts'],
          },
        ],
        updatedAt: new Date().toISOString(),
      });
    }

    it('refuses the retry while the changes are still uncommitted', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue(dirtyPlan());
      const savePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const resumePlan = spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockResolvedValue(undefined);
      stateWithDirtyJob();
      spyOn(worktreeStatus, 'findUncommittedChanges').mockResolvedValue(['src/new.ts']);

      await expect(
        mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'dirty' }, mockContext),
      ).rejects.toThrow(/still has uncommitted changes.*src\/new\.ts/s);

      expect(savePlan).not.toHaveBeenCalled();
      expect(resumePlan).not.toHaveBeenCalled();
    });

    it('merges the job on retry once its work is committed', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue(dirtyPlan());
      const savePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockResolvedValue(undefined);
      stateWithDirtyJob();
      spyOn(worktreeStatus, 'findUncommittedChanges').mockResolvedValue([]);

      await mc_plan_approve.execute({ checkpoint: 'on_error', retry: 'dirty' }, mockContext);

      expect(savePlan).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'running',
          jobs: [expect.objectContaining({ name: 'dirty', status: 'ready_to_merge' })],
        }),
      );
    });

    it('merges the branch without the changes when approved without retry, and says so', async () => {
      spyOn(planState, 'loadPlan').mockResolvedValue(dirtyPlan());
      const savePlan = spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      spyOn(orchestrator.Orchestrator.prototype, 'resumePlan').mockResolvedValue(undefined);

      const result = await mc_plan_approve.execute({ checkpoint: 'on_error' }, mockContext);

      expect(savePlan).toHaveBeenCalledWith(
        expect.objectContaining({
          jobs: [expect.objectContaining({ name: 'dirty', status: 'ready_to_merge' })],
        }),
      );
      expect(result.content).toContain('will be merged without its uncommitted changes');
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

      expect(result.content).toContain('approved and started');
      expect(result.content).toContain('plan-1');
      expect(result.content).toContain('Jobs: 2');
      expect(result.content).toContain('mc_plan_status');
      expect(mockSavePlan).toHaveBeenCalled();
      expect(mockResumePlan).toHaveBeenCalled();
    });
  });
});
