import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Job, JobState } from '../../src/lib/job-state';
import type { JobSpec, PlanSpec } from '../../src/lib/plan-types';
import * as integrationMod from '../../src/lib/integration';
import * as jobStateMod from '../../src/lib/job-state';
import * as mergeTrainMod from '../../src/lib/merge-train';
import { Orchestrator, hasCircularDependency, topologicalSort } from '../../src/lib/orchestrator';
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

class FakeMonitor extends EventEmitter {}

describe('orchestrator', () => {
  let planState: PlanSpec | null;
  let runningJobs: Job[];
  let monitor: FakeMonitor;

  beforeEach(() => {
    planState = null;
    runningJobs = [];
    monitor = new FakeMonitor();

    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => clone(planState));
    spyOn(planStateMod, 'savePlan').mockImplementation(async (plan: PlanSpec) => {
      planState = clone(plan);
    });
    spyOn(planStateMod, 'updatePlanJob').mockImplementation(
      async (planId: string, jobName: string, updates: Partial<JobSpec>) => {
        if (!planState || planState.id !== planId) {
          return;
        }
        planState.jobs = planState.jobs.map((job) =>
          job.name === jobName ? { ...job, ...updates } : job,
        );
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

  it('startPlan validates dependencies and creates integration branch', async () => {
    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);
    spyOn(orchestrator as any, 'startReconciler').mockImplementation(() => {});

    expect(
      orchestrator.startPlan(
        makePlan({
          jobs: [makeJob('a', { dependsOn: ['missing'] })],
        }),
      ),
    ).rejects.toThrow('depends on unknown job');

    await orchestrator.startPlan(
      makePlan({
        jobs: [makeJob('a'), makeJob('b', { dependsOn: ['a'] })],
      }),
    );

    expect(integrationMod.createIntegrationBranch).toHaveBeenCalledWith(
      'plan-1',
      expect.objectContaining({
        symlinkDirs: expect.arrayContaining(['.opencode']),
      }),
    );
    expect(planState?.status).toBe('pending');
    expect(planState?.jobs[1].status).toBe('waiting_deps');
  });

  it('DAG scheduling respects dependencies (job B waits for job A)', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [makeJob('job-a', { status: 'queued' }), makeJob('job-b', { status: 'queued', dependsOn: ['job-a'] })],
    });

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
      maxParallel: 2,
    } as any);
    const launchSpy = spyOn(orchestrator as any, 'launchJob').mockResolvedValue(undefined);

    await (orchestrator as any).reconcile();

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'job-a' }));
    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith('plan-1', 'job-b', { status: 'waiting_deps' });
  });

  it('parallel limit enforced (never more than N concurrent)', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [makeJob('j1', { status: 'queued' }), makeJob('j2', { status: 'queued' }), makeJob('j3', { status: 'queued' })],
    });

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
      maxParallel: 2,
    } as any);
    const launchSpy = spyOn(orchestrator as any, 'launchJob').mockResolvedValue(undefined);

    await (orchestrator as any).reconcile();

    expect(launchSpy).toHaveBeenCalledTimes(2);
  });

  it('jobs transition completed -> ready_to_merge -> merging -> merged', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [
        makeJob('merge-me', { status: 'completed', mergeOrder: 0, branch: 'mc/merge-me' }),
        makeJob('pending-later', { status: 'queued', mergeOrder: 1 }),
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

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);
    (orchestrator as any).mergeTrain = fakeTrain;

    await (orchestrator as any).reconcile();

    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith('plan-1', 'merge-me', { status: 'ready_to_merge' });
    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith('plan-1', 'merge-me', { status: 'merging' });
    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith('plan-1', 'merge-me', {
      status: 'merged',
      mergedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('merge train integration enqueues ready jobs when prior jobs merged', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [
        makeJob('a', { status: 'merged', mergeOrder: 0 }),
        makeJob('b', { status: 'ready_to_merge', mergeOrder: 1, branch: 'mc/b' }),
        makeJob('c', { status: 'queued', mergeOrder: 2 }),
      ],
    });

    const fakeTrain = {
      enqueued: [] as string[],
      queue: [] as JobSpec[],
      enqueue(job: JobSpec) {
        this.enqueued.push(job.name);
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

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);
    (orchestrator as any).mergeTrain = fakeTrain;

    await (orchestrator as any).reconcile();

    expect(fakeTrain.enqueued).toContain('b');
  });

  it('creates PR when all jobs are merged', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [makeJob('done', { status: 'merged', mergeOrder: 0 })],
    });

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);
    const createPRSpy = spyOn(orchestrator as any, 'createPR').mockResolvedValue('https://example.com/pr/1');

    await (orchestrator as any).reconcile();

    expect(createPRSpy).toHaveBeenCalledTimes(1);
    expect(planState?.status).toBe('completed');
    expect(planState?.prUrl).toBe('https://example.com/pr/1');
  });

  it('failed job event pauses the plan', async () => {
    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);
    spyOn(orchestrator as any, 'startReconciler').mockImplementation(() => {});

    await orchestrator.startPlan(
      makePlan({
        status: 'pending',
        jobs: [makeJob('bad-job', { status: 'queued' })],
      }),
    );

    monitor.emit('failed', {
      id: 'j1',
      name: 'bad-job',
      planId: 'plan-1',
    } as Job);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(planState?.status).toBe('paused');
    expect(planState?.checkpoint).toBe('on_error');
  });

  it('autopilot plan should pause on merge conflict instead of failing', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [
        makeJob('conflict-job', { status: 'ready_to_merge', mergeOrder: 0, branch: 'mc/conflict-job' }),
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
        return { success: false, type: 'conflict', files: ['src/index.ts'] };
      },
    };

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);
    (orchestrator as any).mergeTrain = fakeTrain;

    await (orchestrator as any).reconcile();

    expect(planState?.status).toBe('paused');
    expect(planState?.checkpoint).toBe('on_error');
    // Verify updatePlanJob was called with conflict status
    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith('plan-1', 'conflict-job', {
      status: 'conflict',
      error: 'src/index.ts',
    });
  });

  it('autopilot plan should pause on test failure instead of failing', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [
        makeJob('test-fail-job', { status: 'ready_to_merge', mergeOrder: 0, branch: 'mc/test-fail-job' }),
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
        return { success: false, type: 'test_failure', output: 'tests failed' };
      },
    };

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);
    (orchestrator as any).mergeTrain = fakeTrain;

    await (orchestrator as any).reconcile();

    expect(planState?.status).toBe('paused');
    expect(planState?.checkpoint).toBe('on_error');
    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith('plan-1', 'test-fail-job', {
      status: 'failed',
      error: 'tests failed',
    });
  });

  it('autopilot plan should pause on job monitor failure', async () => {
    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);
    spyOn(orchestrator as any, 'startReconciler').mockImplementation(() => {});

    await orchestrator.startPlan(
      makePlan({
        status: 'pending',
        mode: 'autopilot',
        jobs: [makeJob('monitor-fail', { status: 'queued' })],
      }),
    );

    monitor.emit('failed', {
      id: 'j1',
      name: 'monitor-fail',
      planId: 'plan-1',
    } as Job);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(planState?.status).toBe('paused');
    expect(planState?.checkpoint).toBe('on_error');
  });

  it('cancelPlan stops plan jobs and cleans up integration branch', async () => {
    planState = makePlan({ status: 'running' });
    runningJobs = [
      {
        id: 'job-1',
        name: 'one',
        worktreePath: '/tmp/w1',
        branch: 'mc/one',
        tmuxTarget: 'mc-one',
        placement: 'session',
        status: 'running',
        prompt: 'one',
        mode: 'vanilla',
        createdAt: '2026-01-01T00:00:00.000Z',
        planId: 'plan-1',
      },
      {
        id: 'job-2',
        name: 'two',
        worktreePath: '/tmp/w2',
        branch: 'mc/two',
        tmuxTarget: 'main:two',
        placement: 'window',
        status: 'running',
        prompt: 'two',
        mode: 'vanilla',
        createdAt: '2026-01-01T00:00:00.000Z',
        planId: 'plan-1',
      },
    ];

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);

    await orchestrator.cancelPlan();

    expect(tmuxMod.killSession).toHaveBeenCalledWith('mc-one');
    expect(tmuxMod.killWindow).toHaveBeenCalledWith('main', 'two');
    expect(integrationMod.deleteIntegrationBranch).toHaveBeenCalledWith('plan-1');
    expect(planStateMod.clearPlan).toHaveBeenCalled();
  });

  it('should mark job needs_rebase and pause plan when trial merge detects conflicts', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [
        makeJob('merge-conflict', { status: 'completed', mergeOrder: 0, branch: 'mc/merge-conflict' }),
      ],
    });

    spyOn(mergeTrainMod, 'checkMergeability').mockResolvedValue({
      canMerge: false,
      conflicts: ['src/index.ts'],
    });

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);

    await (orchestrator as any).reconcile();

    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith('plan-1', 'merge-conflict', {
      status: 'needs_rebase',
      error: 'src/index.ts',
    });
    expect(planState?.status).toBe('paused');
    expect(planState?.checkpoint).toBe('on_error');
  });

  it('should proceed to merge when trial merge succeeds', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [
        makeJob('clean-merge', { status: 'completed', mergeOrder: 0, branch: 'mc/clean-merge' }),
      ],
    });

    spyOn(mergeTrainMod, 'checkMergeability').mockResolvedValue({ canMerge: true });

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

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);
    (orchestrator as any).mergeTrain = fakeTrain;

    await (orchestrator as any).reconcile();

    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith('plan-1', 'clean-merge', { status: 'merging' });
    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith('plan-1', 'clean-merge', {
      status: 'merged',
      mergedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('resumePlan reconstructs state and marks dead running panes failed', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [makeJob('stuck', { status: 'running' })],
    });
    runningJobs = [
      {
        id: 'job-1',
        name: 'stuck',
        worktreePath: '/tmp/w1',
        branch: 'mc/stuck',
        tmuxTarget: 'mc-stuck',
        placement: 'session',
        status: 'running',
        prompt: 'stuck',
        mode: 'vanilla',
        createdAt: '2026-01-01T00:00:00.000Z',
        planId: 'plan-1',
      },
    ];
    spyOn(tmuxMod, 'isPaneRunning').mockResolvedValue(false);

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);
    const startSpy = spyOn(orchestrator as any, 'startReconciler');

    await orchestrator.resumePlan();

    expect(jobStateMod.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(planState?.status).toBe('failed');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('should fail job and pause plan when touchSet is violated', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [
        makeJob('touch-violator', {
          status: 'completed',
          mergeOrder: 0,
          branch: 'mc/touch-violator',
          touchSet: ['src/**'],
        }),
      ],
    });

    spyOn(mergeTrainMod, 'validateTouchSet').mockResolvedValue({
      valid: false,
      violations: ['README.md'],
      changedFiles: ['src/app.ts', 'README.md'],
    });

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);

    await (orchestrator as any).reconcile();

    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith(
      'plan-1',
      'touch-violator',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('Modified files outside touchSet'),
      }),
    );
    expect(planState?.status).toBe('paused');
    expect(planState?.checkpoint).toBe('on_error');
  });

  it('should allow transition to ready_to_merge when touchSet is satisfied', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [
        makeJob('touch-ok', {
          status: 'completed',
          mergeOrder: 0,
          branch: 'mc/touch-ok',
          touchSet: ['src/**'],
        }),
      ],
    });

    spyOn(mergeTrainMod, 'validateTouchSet').mockResolvedValue({
      valid: true,
      changedFiles: ['src/app.ts'],
    });

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);

    await (orchestrator as any).reconcile();

    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith(
      'plan-1',
      'touch-ok',
      { status: 'ready_to_merge' },
    );
  });

  it('should skip touchSet validation when touchSet is not defined', async () => {
    planState = makePlan({
      status: 'running',
      jobs: [
        makeJob('no-touchset', {
          status: 'completed',
          mergeOrder: 0,
          branch: 'mc/no-touchset',
        }),
      ],
    });

    const validateSpy = spyOn(mergeTrainMod, 'validateTouchSet');

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);

    await (orchestrator as any).reconcile();

    expect(validateSpy).not.toHaveBeenCalled();
    expect(planStateMod.updatePlanJob).toHaveBeenCalledWith(
      'plan-1',
      'no-touchset',
      { status: 'ready_to_merge' },
    );
  });

  it('root plan jobs branch from baseCommit', async () => {
    planState = makePlan({
      status: 'running',
      baseCommit: 'abc123',
      integrationBranch: 'mc/integration-plan-1',
      jobs: [makeJob('root-job', { status: 'queued' })],
    });

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);

    await (orchestrator as any).reconcile();

    expect(worktreeMod.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ startPoint: 'abc123' }),
    );
  });

  it('dependent plan jobs branch from integration branch HEAD', async () => {
    planState = makePlan({
      status: 'running',
      baseCommit: 'abc123',
      integrationBranch: 'mc/integration-plan-1',
      jobs: [
        makeJob('upstream', { status: 'merged', mergeOrder: 0 }),
        makeJob('downstream', { status: 'queued', dependsOn: ['upstream'], mergeOrder: 1 }),
      ],
    });

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    } as any);

    await (orchestrator as any).reconcile();

    expect(worktreeMod.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ startPoint: 'mc/integration-plan-1' }),
    );
  });

  it('startPoint is passed through to createWorktree for plan jobs', async () => {
    planState = makePlan({
      status: 'running',
      baseCommit: 'def456',
      integrationBranch: 'mc/integration-plan-1',
      jobs: [
        makeJob('no-deps', { status: 'queued', mergeOrder: 0 }),
        makeJob('has-deps', { status: 'merged', mergeOrder: 1 }),
        makeJob('with-deps', { status: 'queued', dependsOn: ['has-deps'], mergeOrder: 2 }),
      ],
    });

    const orchestrator = new Orchestrator(monitor as any, {
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
      maxParallel: 3,
    } as any);

    await (orchestrator as any).reconcile();

    const calls = (worktreeMod.createWorktree as any).mock.calls;
    const noDepCall = calls.find((c: any) => c[0].branch === 'mc/no-deps');
    const withDepCall = calls.find((c: any) => c[0].branch === 'mc/with-deps');

    expect(noDepCall[0].startPoint).toBe('def456');
    expect(withDepCall[0].startPoint).toBe('mc/integration-plan-1');
  });
});

describe('orchestrator DAG helpers', () => {
  it('detects circular dependencies', () => {
    const jobs = [
      makeJob('a', { dependsOn: ['c'] }),
      makeJob('b', { dependsOn: ['a'] }),
      makeJob('c', { dependsOn: ['b'] }),
    ];

    expect(hasCircularDependency(jobs)).toBe(true);
  });

  it('topologicalSort returns dependency-safe order', () => {
    const jobs = [
      makeJob('b', { dependsOn: ['a'] }),
      makeJob('a'),
      makeJob('c', { dependsOn: ['b'] }),
    ];

    const sorted = topologicalSort(jobs);
    expect(sorted.map((job) => job.name)).toEqual(['a', 'b', 'c']);
  });
});
