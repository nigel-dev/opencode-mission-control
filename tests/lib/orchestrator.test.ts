import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Job, JobState } from '../../src/lib/job-state';
import type { JobSpec, PlanSpec } from '../../src/lib/plan-types';
import * as integrationMod from '../../src/lib/integration';
import * as jobStateMod from '../../src/lib/job-state';
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

  it('failed job event stops the plan', async () => {
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

    expect(planState?.status).toBe('failed');
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
