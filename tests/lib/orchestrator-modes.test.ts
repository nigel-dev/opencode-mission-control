import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Job, JobState } from '../../src/lib/job-state';
import type { JobSpec, PlanSpec } from '../../src/lib/plan-types';
import * as integrationMod from '../../src/lib/integration';
import * as jobStateMod from '../../src/lib/job-state';
import { Orchestrator, type ToastCallback } from '../../src/lib/orchestrator';
import * as mergeTrainMod from '../../src/lib/merge-train';
import * as planStateMod from '../../src/lib/plan-state';
import * as tmuxMod from '../../src/lib/tmux';
import * as worktreeMod from '../../src/lib/worktree';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeJob(name: string, overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    id: `${name}-id`,
    name,
    prompt: `do ${name}`,
    status: 'queued',
    ...overrides,
  };
}

function makePlan(overrides: Partial<PlanSpec> = {}): PlanSpec {
  return {
    id: 'plan-1',
    name: 'Plan One',
    mode: 'autopilot',
    status: 'pending',
    jobs: [makeJob('job-a')],
    integrationBranch: 'mc/integration-plan-1',
    integrationWorktree: '/tmp/integration-plan-1',
    baseCommit: 'abc123',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const DEFAULT_CONFIG = {
  defaultPlacement: 'session' as const,
  pollInterval: 10000,
  idleThreshold: 300000,
  worktreeBasePath: '/tmp',
  omo: { enabled: false, defaultMode: 'vanilla' as const },
  maxParallel: 3,
};

class FakeMonitor extends EventEmitter {}

describe('orchestrator modes', () => {
  let planState: PlanSpec | null;
  let runningJobs: Job[];
  let monitor: FakeMonitor;
  let toastCalls: { title: string; message: string; variant: string; duration: number }[];
  let notifyCalls: string[];
  let toastCallback: ToastCallback;

  beforeEach(() => {
    planState = null;
    runningJobs = [];
    monitor = new FakeMonitor();
    toastCalls = [];
    notifyCalls = [];
    toastCallback = (title, message, variant, duration) => {
      toastCalls.push({ title, message, variant, duration });
    };

    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => clone(planState));
    spyOn(planStateMod, 'savePlan').mockImplementation(async (plan: PlanSpec) => {
      planState = clone(plan);
    });
    spyOn(planStateMod, 'updatePlanJob').mockImplementation(
      async (planId: string, jobName: string, updates: Partial<JobSpec>) => {
        if (!planState || planState.id !== planId) return;
        planState.jobs = planState.jobs.map((job) =>
          job.name === jobName ? { ...job, ...updates } : job,
        );
      },
    );
    spyOn(planStateMod, 'updatePlanFields').mockImplementation(
      async (planId: string, updates: Partial<PlanSpec>) => {
        if (!planState || planState.id !== planId) return;
        if (updates.status !== undefined) planState.status = updates.status;
        if (updates.checkpoint !== undefined) planState.checkpoint = updates.checkpoint;
        if (updates.checkpointContext !== undefined) planState.checkpointContext = updates.checkpointContext;
        if (updates.completedAt !== undefined) planState.completedAt = updates.completedAt;
        if (updates.prUrl !== undefined) planState.prUrl = updates.prUrl;
      },
    );
    spyOn(planStateMod, 'clearPlan').mockImplementation(async () => {
      planState = null;
    });
    spyOn(planStateMod, 'validateGhAuth').mockResolvedValue(true);

    spyOn(integrationMod, 'createIntegrationBranch').mockResolvedValue({
      branch: 'mc/integration-plan-1',
      worktreePath: '/tmp/integration-plan-1',
    });
    spyOn(integrationMod, 'deleteIntegrationBranch').mockResolvedValue();

    spyOn(jobStateMod, 'getRunningJobs').mockImplementation(async () => clone(runningJobs));
    spyOn(jobStateMod, 'addJob').mockResolvedValue();
    spyOn(jobStateMod, 'updateJob').mockResolvedValue();
    spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => {
      const state: JobState = {
        version: 2,
        jobs: runningJobs,
        updatedAt: new Date().toISOString(),
      };
      return state;
    });

    spyOn(worktreeMod, 'createWorktree').mockResolvedValue('/tmp/wt/job-a');
    spyOn(worktreeMod, 'removeWorktree').mockResolvedValue();

    spyOn(tmuxMod, 'createSession').mockResolvedValue();
    spyOn(tmuxMod, 'createWindow').mockResolvedValue();
    spyOn(tmuxMod, 'getCurrentSession').mockReturnValue('main');
    spyOn(tmuxMod, 'isInsideTmux').mockReturnValue(true);
    spyOn(tmuxMod, 'isPaneRunning').mockResolvedValue(true);
    spyOn(tmuxMod, 'killSession').mockResolvedValue();
    spyOn(tmuxMod, 'killWindow').mockResolvedValue();
    spyOn(tmuxMod, 'sendKeys').mockResolvedValue();
    spyOn(tmuxMod, 'setPaneDiedHook').mockResolvedValue();

    spyOn(mergeTrainMod, 'checkMergeability').mockResolvedValue({ canMerge: true });
  });

  afterEach(() => {
    mock.restore();
  });

  describe('autopilot mode', () => {
    it('runs to completion without checkpoints', async () => {
      planState = makePlan({
        mode: 'autopilot',
        status: 'running',
        jobs: [makeJob('done', { status: 'merged', mergeOrder: 0 })],
      });

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      const createPRSpy = spyOn(orchestrator as any, 'createPR').mockResolvedValue(
        'https://example.com/pr/1',
      );

      await (orchestrator as any).reconcile();

      expect(createPRSpy).toHaveBeenCalledTimes(1);
      expect(planState?.status).toBe('completed');
      expect(planState?.prUrl).toBe('https://example.com/pr/1');
      expect(orchestrator.getCheckpoint()).toBeNull();
    });

    it('sends toast on plan start', async () => {
      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      spyOn(orchestrator as any, 'startReconciler').mockImplementation(() => {});

      await orchestrator.startPlan(
        makePlan({ mode: 'autopilot', jobs: [makeJob('a')] }),
      );

      const startToast = toastCalls.find((t) => t.message.includes('started'));
      expect(startToast).toBeTruthy();
      expect(startToast!.variant).toBe('info');
    });

    it('sends toast when jobs are launched', async () => {
      planState = makePlan({
        mode: 'autopilot',
        status: 'running',
        jobs: [makeJob('j1', { status: 'queued' }), makeJob('j2', { status: 'queued' })],
      });

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      spyOn(orchestrator as any, 'launchJob').mockResolvedValue(undefined);

      await (orchestrator as any).reconcile();

      const launchToast = toastCalls.find((t) => t.message.includes('Launched'));
      expect(launchToast).toBeTruthy();
      expect(launchToast!.message).toContain('2 job(s)');
    });

    it('sends toast on plan completion with PR URL', async () => {
      planState = makePlan({
        mode: 'autopilot',
        status: 'running',
        jobs: [makeJob('done', { status: 'merged', mergeOrder: 0 })],
      });

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      spyOn(orchestrator as any, 'createPR').mockResolvedValue('https://example.com/pr/42');

      await (orchestrator as any).reconcile();

      const completedToast = toastCalls.find((t) => t.message.includes('PR:'));
      expect(completedToast).toBeTruthy();
      expect(completedToast!.message).toContain('https://example.com/pr/42');
      expect(completedToast!.variant).toBe('success');
    });

    it('sends toast on first job completion', async () => {
      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      spyOn(orchestrator as any, 'startReconciler').mockImplementation(() => {});

      await orchestrator.startPlan(
        makePlan({ mode: 'autopilot', jobs: [makeJob('fast-job')] }),
      );

      monitor.emit('complete', {
        id: 'j1',
        name: 'fast-job',
        planId: 'plan-1',
      } as Job);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const firstCompleteToast = toastCalls.find((t) => t.message.includes('First job completed'));
      expect(firstCompleteToast).toBeTruthy();
      expect(firstCompleteToast!.variant).toBe('success');
    });
  });

  describe('copilot mode', () => {
    it('creates pending plan and returns early with message', async () => {
      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);

      const result = await orchestrator.startPlan(
        makePlan({ mode: 'copilot', jobs: [makeJob('a')] }),
      );

      expect(result.pending).toBe(true);
      expect(result.message).toContain('copilot mode');
      expect(result.message).toContain('mc_plan_approve');
      expect(planState?.status).toBe('pending');
    });

    it('does not start reconciler for copilot mode', async () => {
      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      const reconcilerSpy = spyOn(orchestrator as any, 'startReconciler');

      await orchestrator.startPlan(
        makePlan({ mode: 'copilot', jobs: [makeJob('a')] }),
      );

      expect(reconcilerSpy).not.toHaveBeenCalled();
    });

    it('sends toast about copilot awaiting approval', async () => {
      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);

      await orchestrator.startPlan(
        makePlan({ mode: 'copilot', jobs: [makeJob('a')] }),
      );

      const copilotToast = toastCalls.find((t) => t.message.includes('copilot mode'));
      expect(copilotToast).toBeTruthy();
    });
  });

  describe('supervisor mode', () => {
    it('pauses before merge with pre_merge checkpoint', async () => {
      planState = makePlan({
        mode: 'supervisor',
        status: 'running',
        jobs: [
          makeJob('merge-me', { status: 'completed', mergeOrder: 0, branch: 'mc/merge-me' }),
        ],
      });

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);

      await (orchestrator as any).reconcile();

      expect(orchestrator.getCheckpoint()).toBe('pre_merge');
      expect(planState?.status).toBe('paused');
      expect(planState?.checkpoint).toBe('pre_merge');
    });

    it('pauses on conflict with on_error checkpoint', async () => {
      planState = makePlan({
        mode: 'supervisor',
        status: 'running',
        jobs: [
          makeJob('bad-merge', { status: 'merging', mergeOrder: 0, branch: 'mc/bad-merge' }),
        ],
      });

      const conflictJob = planState.jobs[0];
      const fakeTrain = {
        queue: [conflictJob] as JobSpec[],
        enqueue(job: JobSpec) {
          this.queue.push(job);
        },
        getQueue() {
          return [...this.queue];
        },
        async processNext() {
          this.queue.shift();
          return { success: false, type: 'conflict' as const, files: ['src/index.ts'] };
        },
      };

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      (orchestrator as any).mergeTrain = fakeTrain;

      await (orchestrator as any).reconcile();

      expect(orchestrator.getCheckpoint()).toBe('on_error');
      expect(planState?.status).toBe('paused');
      expect(planState?.checkpoint).toBe('on_error');
    });

    it('pauses before PR with pre_pr checkpoint', async () => {
      planState = makePlan({
        mode: 'supervisor',
        status: 'running',
        jobs: [makeJob('done', { status: 'merged', mergeOrder: 0 })],
      });

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);

      await (orchestrator as any).reconcile();

      expect(orchestrator.getCheckpoint()).toBe('pre_pr');
      expect(planState?.status).toBe('paused');
      expect(planState?.checkpoint).toBe('pre_pr');
    });

    it('pauses on job failure with on_error checkpoint', async () => {
      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      spyOn(orchestrator as any, 'startReconciler').mockImplementation(() => {});

      await orchestrator.startPlan(
        makePlan({ mode: 'supervisor', jobs: [makeJob('bad-job')] }),
      );

      monitor.emit('failed', {
        id: 'j1',
        name: 'bad-job',
        planId: 'plan-1',
      } as Job);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(planState?.status).toBe('paused');
      expect(planState?.checkpoint).toBe('on_error');
    });

    it('reconcile skips when checkpoint is set', async () => {
      planState = makePlan({
        mode: 'supervisor',
        status: 'paused',
        checkpoint: 'pre_merge',
        jobs: [
          makeJob('merge-me', { status: 'completed', mergeOrder: 0, branch: 'mc/merge-me' }),
        ],
      });

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      const launchSpy = spyOn(orchestrator as any, 'launchJob').mockResolvedValue(undefined);

      await (orchestrator as any).reconcile();

      expect(launchSpy).not.toHaveBeenCalled();
    });

    it('clearCheckpoint resumes execution', async () => {
      planState = makePlan({
        mode: 'supervisor',
        status: 'paused',
        checkpoint: 'pre_merge',
        jobs: [
          makeJob('merge-me', { status: 'completed', mergeOrder: 0, branch: 'mc/merge-me' }),
        ],
      });

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      (orchestrator as any).checkpoint = 'pre_merge';

      await orchestrator.clearCheckpoint('pre_merge');

      expect(orchestrator.getCheckpoint()).toBeNull();
      expect(planState?.status).toBe('running');
      expect(planState?.checkpoint).toBeNull();
    });

    it('clearCheckpoint throws on mismatch', async () => {
      planState = makePlan({
        mode: 'supervisor',
        status: 'paused',
        checkpoint: 'pre_merge',
      });

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      (orchestrator as any).checkpoint = 'pre_merge';

      expect(orchestrator.clearCheckpoint('pre_pr')).rejects.toThrow('Checkpoint mismatch');
    });

    it('does not re-checkpoint after pre_merge approval', async () => {
      planState = makePlan({
        mode: 'supervisor',
        status: 'running',
        jobs: [
          makeJob('merge-me', { status: 'completed', mergeOrder: 0, branch: 'mc/merge-me' }),
        ],
      });

      const fakeTrain = {
        queue: [] as JobSpec[],
        enqueue(job: JobSpec) {
          this.queue.push(job);
        },
        getQueue() {
          return [...this.queue];
        },
        async processNext() {
          this.queue.shift();
          return { success: true, mergedAt: '2026-01-02T00:00:00.000Z' };
        },
      };

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);

      // First reconcile: job transitions completed -> ready_to_merge, then supervisor checkpoints
      await (orchestrator as any).reconcile();
      expect(orchestrator.getCheckpoint()).toBe('pre_merge');
      expect(planState?.status).toBe('paused');

      // Inject fake merge train before clearing so the auto-reconcile uses it
      (orchestrator as any).mergeTrain = fakeTrain;

      // Simulate mc_plan_approve clearing the checkpoint
      await orchestrator.clearCheckpoint('pre_merge');
      expect(orchestrator.getCheckpoint()).toBeNull();
      expect(planState?.status).toBe('running');

      // Wait for the auto-reconcile triggered by clearCheckpoint/startReconciler
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Job should have moved to merging (enqueued in merge train) and then merged
      expect(orchestrator.getCheckpoint()).not.toBe('pre_merge');
      const mergeJob = planState?.jobs.find(j => j.name === 'merge-me');
      expect(mergeJob?.status).toBe('merged');
    });

    it('sends checkpoint toast notifications', async () => {
      planState = makePlan({
        mode: 'supervisor',
        status: 'running',
        jobs: [makeJob('done', { status: 'merged', mergeOrder: 0 })],
      });

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);

      await (orchestrator as any).reconcile();

      const checkpointToast = toastCalls.find(
        (t) => t.message.includes('Supervisor checkpoint') && t.message.includes('pre_pr'),
      );
      expect(checkpointToast).toBeTruthy();
      expect(checkpointToast!.variant).toBe('warning');
      expect(checkpointToast!.duration).toBe(8000);
    });
  });

  describe('toast notifications', () => {
    it('uses correct durations per variant', async () => {
      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      (orchestrator as any).showToast('Test', 'info msg', 'info');
      (orchestrator as any).showToast('Test', 'success msg', 'success');
      (orchestrator as any).showToast('Test', 'warning msg', 'warning');
      (orchestrator as any).showToast('Test', 'error msg', 'error');

      expect(toastCalls[0].duration).toBe(5000);
      expect(toastCalls[1].duration).toBe(3000);
      expect(toastCalls[2].duration).toBe(8000);
      expect(toastCalls[3].duration).toBe(8000);
    });

    it('works without toast callback (no-op)', async () => {
      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any);
      (orchestrator as any).showToast('Test', 'msg', 'info');
      expect(toastCalls.length).toBe(0);
    });

    it('sends merge toast on successful merge', async () => {
      planState = makePlan({
        mode: 'autopilot',
        status: 'running',
        jobs: [
          makeJob('merge-me', { status: 'merging', mergeOrder: 0, branch: 'mc/merge-me' }),
          makeJob('still-running', { status: 'running', mergeOrder: 1 }),
        ],
      });

      const mergeJob = planState.jobs[0];
      const fakeTrain = {
        queue: [mergeJob] as JobSpec[],
        enqueue(job: JobSpec) {
          this.queue.push(job);
        },
        getQueue() {
          return [...this.queue];
        },
        async processNext() {
          this.queue.shift();
          return { success: true, mergedAt: '2026-01-02T00:00:00.000Z' };
        },
      };

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      (orchestrator as any).mergeTrain = fakeTrain;

      await (orchestrator as any).reconcile();

      const mergeToast = toastCalls.find((t) => t.message.includes('merged successfully'));
      expect(mergeToast).toBeTruthy();
      expect(mergeToast!.variant).toBe('success');
    });

    it('sends test execution details in notify after successful merge', async () => {
      planState = makePlan({
        mode: 'autopilot',
        status: 'running',
        jobs: [
          makeJob('merge-me', { status: 'merging', mergeOrder: 0, branch: 'mc/merge-me' }),
        ],
      });

      const mergeJob = planState.jobs[0];
      const fakeTrain = {
        queue: [mergeJob] as JobSpec[],
        enqueue(job: JobSpec) {
          this.queue.push(job);
        },
        getQueue() {
          return [...this.queue];
        },
        async processNext() {
          this.queue.shift();
          return {
            success: true as const,
            mergedAt: '2026-01-02T00:00:00.000Z',
            testReport: {
              status: 'passed' as const,
              command: 'bun test',
              output: '12 passed',
              setup: {
                status: 'passed' as const,
                commands: ['bun install'],
                output: 'installed',
              },
            },
          };
        },
      };

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, {
        toast: toastCallback,
        notify: (message) => notifyCalls.push(message),
      });
      (orchestrator as any).mergeTrain = fakeTrain;

      await (orchestrator as any).reconcile();

      const details = notifyCalls.find((message) => message.includes('tests passed'));
      expect(details).toBeTruthy();
      expect(details).toContain('command: bun test');
      expect(details).toContain('setup passed: bun install');
      expect(details).toContain('test output: 12 passed');
    });

    it('sends error toast on plan failure', async () => {
      planState = makePlan({
        mode: 'autopilot',
        status: 'running',
        jobs: [
          makeJob('fail-merge', { status: 'ready_to_merge', mergeOrder: 0, branch: 'mc/f' }),
        ],
      });

      const fakeTrain = {
        queue: [] as JobSpec[],
        enqueue(job: JobSpec) {
          this.queue.push(job);
        },
        getQueue() {
          return [...this.queue];
        },
        async processNext() {
          this.queue.shift();
          return { success: false, type: 'test_failure' as const, output: 'tests failed' };
        },
      };

      const orchestrator = new Orchestrator(monitor as any, DEFAULT_CONFIG as any, toastCallback);
      (orchestrator as any).mergeTrain = fakeTrain;

      await (orchestrator as any).reconcile();

      const errorToast = toastCalls.find((t) => t.variant === 'error');
      expect(errorToast).toBeTruthy();
    });
  });
});
