import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Job, JobState } from '../../src/lib/job-state';
import type { JobSpec, PlanSpec } from '../../src/lib/plan-types';
import type { MCConfig } from '../../src/lib/config';
import * as integrationMod from '../../src/lib/integration';
import * as jobStateMod from '../../src/lib/job-state';
import * as jobLauncherMod from '../../src/lib/job-launcher';
import * as mergeTrainMod from '../../src/lib/merge-train';
import { Orchestrator } from '../../src/lib/orchestrator';
import * as planStateMod from '../../src/lib/plan-state';
import * as jobRuntimeMod from '../../src/lib/job-runtime';
import * as worktreeMod from '../../src/lib/worktree';
import * as gitMod from '../../src/lib/git';

// Orchestrator lifecycle (dispose, one live instance) and the ways a plan used
// to get stuck: unhandled failed jobs, statuses written over a pause, plans cut
// off by a restart in a status nothing resumed.

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeJob(name: string, overrides: Partial<JobSpec> = {}): JobSpec {
  return { id: `${name}-id`, name, prompt: `do ${name}`, status: 'queued', ...overrides };
}

function makePlan(overrides: Partial<PlanSpec> = {}): PlanSpec {
  return {
    id: 'plan-1',
    name: 'Plan One',
    mode: 'autopilot',
    status: 'running',
    jobs: [makeJob('job-a')],
    integrationBranch: 'mc/integration-plan-1',
    integrationWorktree: '/tmp/integration-plan-1',
    baseCommit: 'abc123',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeStateJob(name: string, overrides: Partial<Job> = {}): Job {
  return {
    id: `${name}-state-id`,
    name,
    worktreePath: `/tmp/wt/${name}`,
    branch: `mc/plan/plan-1/${name}`,
    status: 'running',
    prompt: `do ${name}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    planId: 'plan-1',
    sessionID: `ses_${name}`,
    ...overrides,
  };
}

const CONFIG: MCConfig = { pollInterval: 10000, worktreeBasePath: '/tmp', maxParallel: 3 };

class FakeMonitor extends EventEmitter {}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A merge train whose `processNext` the test finishes by hand. */
function controllableTrain(job: JobSpec) {
  let finish: (result: unknown) => void = () => {};
  const train = {
    queue: [job] as JobSpec[],
    stopCalls: 0,
    started: false,
    enqueue(next: JobSpec) {
      this.queue.push(next);
    },
    getQueue() {
      return [...this.queue];
    },
    stop() {
      this.stopCalls += 1;
    },
    processNext() {
      this.queue.shift();
      this.started = true;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  return { train, finish: (result: unknown) => finish(result) };
}

describe('orchestrator lifecycle', () => {
  let planState: PlanSpec | null;
  let stateJobs: Job[];
  let monitor: FakeMonitor;
  let toasts: string[];
  let notifications: string[];
  let orchestrators: Orchestrator[];
  let planWrites: Array<Record<string, unknown>>;

  function create(): Orchestrator {
    const orchestrator = new Orchestrator(monitor as never, CONFIG, {
      toast: (_title, message) => {
        toasts.push(message);
      },
      notify: (message) => {
        notifications.push(message);
      },
    });
    orchestrators.push(orchestrator);
    return orchestrator;
  }

  const reconcile = (orchestrator: Orchestrator): Promise<void> =>
    (orchestrator as unknown as { reconcile(): Promise<void> }).reconcile();
  const jobStatus = (name: string) => planState?.jobs.find((job) => job.name === name)?.status;

  beforeEach(() => {
    planState = null;
    stateJobs = [];
    monitor = new FakeMonitor();
    toasts = [];
    notifications = [];
    orchestrators = [];
    planWrites = [];

    spyOn(planStateMod, 'loadPlan').mockImplementation(async () => clone(planState));
    spyOn(planStateMod, 'savePlan').mockImplementation(async (plan: PlanSpec) => {
      planState = clone(plan);
    });
    spyOn(planStateMod, 'updatePlanJob').mockImplementation(
      async (planId: string, jobName: string, updates: Partial<JobSpec>) => {
        if (!planState || planState.id !== planId) {
          throw new Error('No active plan exists');
        }
        planState.jobs = planState.jobs.map((job) => (job.name === jobName ? { ...job, ...updates } : job));
      },
    );
    spyOn(planStateMod, 'updatePlanFields').mockImplementation(
      async (planId: string, updates: Record<string, unknown>) => {
        if (!planState || planState.id !== planId) {
          throw new Error('No active plan exists');
        }
        planWrites.push(updates);
        Object.assign(planState, updates);
      },
    );
    spyOn(planStateMod, 'clearPlan').mockImplementation(async () => {
      planState = null;
    });
    spyOn(planStateMod, 'validateGhAuth').mockResolvedValue(true);

    spyOn(integrationMod, 'deleteIntegrationBranch').mockResolvedValue();

    spyOn(jobStateMod, 'getRunningJobs').mockImplementation(async () =>
      clone(stateJobs.filter((job) => job.status === 'running')),
    );
    spyOn(jobStateMod, 'updateJob').mockImplementation(async (id: string, updates: Partial<Job>) => {
      stateJobs = stateJobs.map((job) => (job.id === id ? { ...job, ...updates } : job));
    });
    spyOn(jobStateMod, 'loadJobState').mockImplementation(async () => {
      const state: JobState = { version: 4, jobs: clone(stateJobs), updatedAt: new Date().toISOString() };
      return state;
    });

    spyOn(worktreeMod, 'removeWorktree').mockResolvedValue();
    spyOn(jobRuntimeMod, 'stopJobSession').mockResolvedValue();
    spyOn(jobRuntimeMod, 'removeJobSession').mockResolvedValue();
    spyOn(gitMod, 'gitCommand').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    spyOn(mergeTrainMod, 'checkMergeability').mockResolvedValue({ canMerge: true });
    spyOn(console, 'warn').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await Promise.all(orchestrators.map((orchestrator) => orchestrator.dispose()));
    mock.restore();
  });

  describe('dispose', () => {
    it('stops the reconcile timer and stops reacting to monitor events', async () => {
      planState = makePlan({ jobs: [makeJob('job-a', { status: 'running' })] });
      stateJobs = [makeStateJob('job-a')];
      const orchestrator = create();
      await orchestrator.resumePlan();
      await waitUntil(() => monitor.listenerCount('complete') === 1);

      await orchestrator.dispose();

      expect(orchestrator.isDisposed()).toBe(true);
      expect(monitor.listenerCount('complete')).toBe(0);
      expect(monitor.listenerCount('failed')).toBe(0);
      expect((orchestrator as unknown as { reconcilerInterval: unknown }).reconcilerInterval).toBeNull();

      // A reconcile asked for after dispose does nothing: the plan is not read.
      const loads = (planStateMod.loadPlan as ReturnType<typeof mock>).mock.calls.length;
      await reconcile(orchestrator);
      expect((planStateMod.loadPlan as ReturnType<typeof mock>).mock.calls.length).toBe(loads);
    });

    it('launches nothing once disposed, even if a monitor event still reaches it', async () => {
      planState = makePlan({ jobs: [makeJob('job-a', { status: 'running' }), makeJob('job-b')] });
      stateJobs = [makeStateJob('job-a')];
      const launch = spyOn(jobLauncherMod, 'launchJob');
      const orchestrator = create();
      await orchestrator.resumePlan();
      const handler = monitor.listeners('complete')[0] as (job: Job) => void;

      await orchestrator.dispose();
      launch.mockClear();
      handler({ ...makeStateJob('job-a'), status: 'completed' });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(jobStatus('job-a')).toBe('running');
      expect(launch).not.toHaveBeenCalled();
    });

    it('stops the merge train and waits for the reconcile pass that is in flight', async () => {
      const merging = makeJob('merge-me', { status: 'merging', mergeOrder: 0, branch: 'mc/merge-me' });
      planState = makePlan({ jobs: [merging] });
      const { train, finish } = controllableTrain(merging);
      const orchestrator = create();
      (orchestrator as unknown as { mergeTrain: unknown }).mergeTrain = train;

      const pass = reconcile(orchestrator);
      await waitUntil(() => train.started);

      let disposed = false;
      const disposing = orchestrator.dispose().then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(train.stopCalls).toBe(1);
      expect(disposed).toBe(false);

      finish({ success: true, mergedAt: '2026-01-02T00:00:00.000Z', testReport: undefined });
      await disposing;
      await pass;

      // The disposed orchestrator records nothing: the job stays `merging`, so
      // its successor redoes the merge instead of trusting an aborted one.
      expect(jobStatus('merge-me')).toBe('merging');
      expect(toasts.some((message) => message.includes('merged successfully'))).toBe(false);
    });

    it('is safe to call twice', async () => {
      const orchestrator = create();
      await orchestrator.dispose();
      await orchestrator.dispose();
      expect(orchestrator.isDisposed()).toBe(true);
    });
  });

  describe('failed jobs pause the plan', () => {
    it('pauses on a launch failure, names the job and the reason, and counts only real launches', async () => {
      planState = makePlan({
        jobs: [makeJob('good', { mergeOrder: 0 }), makeJob('bad', { mergeOrder: 1 }), makeJob('later', { mergeOrder: 2 })],
      });
      spyOn(jobLauncherMod, 'launchJob').mockImplementation(async (options) => {
        if (options.name === 'bad') {
          throw new Error('Failed to create worktree for branch "mc/plan/plan-1/bad": branch is checked out elsewhere');
        }
        return makeStateJob(options.name);
      });
      const orchestrator = create();

      await reconcile(orchestrator);

      expect(jobStatus('good')).toBe('running');
      expect(jobStatus('bad')).toBe('failed');
      // Nothing more is started once the plan is about to pause.
      expect(jobStatus('later')).toBe('queued');
      expect(planState?.status).toBe('paused');
      expect(planState?.checkpoint).toBe('on_error');
      expect(planState?.checkpointContext).toEqual({
        jobName: 'bad',
        failureKind: 'launch_failed',
        reason: expect.stringContaining('branch is checked out elsewhere'),
      });
      expect(notifications).toContain('🚀 Launched 1 job(s): good. (1/3 total launched)');
      expect(toasts).toContain('Launched 1 job(s) (1 total).');
      expect(notifications.some((message) => message.includes('"bad" could not be launched'))).toBe(true);
    });

    it('says nothing about launches when the only launch failed', async () => {
      planState = makePlan({ jobs: [makeJob('bad')] });
      spyOn(jobLauncherMod, 'launchJob').mockRejectedValue(new Error('Invalid job name'));
      const orchestrator = create();

      await reconcile(orchestrator);

      expect(toasts.some((message) => message.startsWith('Launched'))).toBe(false);
      expect(planState?.checkpointContext).toMatchObject({ jobName: 'bad', failureKind: 'launch_failed' });
    });

    it('pauses on a failed job that no checkpoint covers instead of waiting forever', async () => {
      planState = makePlan({
        jobs: [
          makeJob('broken', { status: 'failed', error: 'its session ended with an error' }),
          makeJob('waiting', { status: 'waiting_deps', dependsOn: ['broken'] }),
        ],
      });
      const launch = spyOn(jobLauncherMod, 'launchJob');
      const orchestrator = create();

      await reconcile(orchestrator);

      expect(planState?.status).toBe('paused');
      expect(planState?.checkpoint).toBe('on_error');
      expect(planState?.checkpointContext).toEqual({
        jobName: 'broken',
        failureKind: 'job_failed',
        reason: 'its session ended with an error',
      });
      expect(launch).not.toHaveBeenCalled();
      expect(notifications.some((message) => message.includes('mc_plan_approve(checkpoint: "on_error", retry: "broken")'))).toBe(true);
    });

    it('notifies once when the monitor event and a reconcile pass see the same failure', async () => {
      planState = makePlan({ jobs: [makeJob('job-a', { status: 'running' })] });
      stateJobs = [makeStateJob('job-a')];
      const orchestrator = create();
      await orchestrator.resumePlan();
      await waitUntil(() => monitor.listenerCount('failed') === 1);

      stateJobs = [makeStateJob('job-a', { status: 'failed', failureReason: 'its session was deleted' })];
      monitor.emit('failed', stateJobs[0]);
      await Promise.all([reconcile(orchestrator), reconcile(orchestrator)]);
      await waitUntil(() => planState?.status === 'paused');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(notifications.filter((message) => message.includes('"job-a" failed'))).toHaveLength(1);
      expect(planState?.checkpointContext).toMatchObject({
        jobName: 'job-a',
        failureKind: 'job_failed',
        reason: 'its session was deleted',
      });
    });

    it('tries again on the next pass when the pause could not be recorded', async () => {
      planState = makePlan({ jobs: [makeJob('broken', { status: 'failed', error: 'boom' })] });
      const orchestrator = create();
      const update = planStateMod.updatePlanFields as ReturnType<typeof mock>;
      update.mockImplementationOnce(async () => {
        throw new Error('disk full');
      });

      await expect(reconcile(orchestrator)).rejects.toThrow('disk full');
      expect(planState?.status).toBe('running');
      expect(orchestrator.getCheckpoint()).toBeNull();
      // Nobody was told about a pause that did not happen.
      expect(notifications).toEqual([]);

      await reconcile(orchestrator);

      expect(planState?.status).toBe('paused');
      expect(orchestrator.getCheckpoint()).toBe('on_error');
      expect(notifications).toHaveLength(1);
    });

    it('pauses when a job finished with uncommitted changes, before merging its branch', async () => {
      planState = makePlan({ jobs: [makeJob('dirty', { status: 'completed', branch: 'mc/plan/plan-1/dirty' })] });
      stateJobs = [makeStateJob('dirty', { status: 'completed', uncommittedChanges: ['src/new.ts', 'README.md'] })];
      const orchestrator = create();
      const train = { enqueue: mock(), getQueue: () => [], stop: () => {} };
      (orchestrator as unknown as { mergeTrain: unknown }).mergeTrain = train;

      await reconcile(orchestrator);

      expect(train.enqueue).not.toHaveBeenCalled();
      expect(jobStatus('dirty')).toBe('failed');
      expect(planState?.status).toBe('paused');
      expect(planState?.checkpointContext).toEqual({
        jobName: 'dirty',
        failureKind: 'uncommitted_changes',
        reason: 'uncommitted changes in its worktree: src/new.ts, README.md',
      });
      expect(notifications.some((message) => message.includes('merging now would leave them out'))).toBe(true);
    });
  });

  describe('never writing over a pause', () => {
    it('keeps the plan paused when a job fails while a merge is in flight', async () => {
      const merging = makeJob('merge-me', { status: 'merging', mergeOrder: 0, branch: 'mc/merge-me' });
      planState = makePlan({ jobs: [merging, makeJob('other', { status: 'running', mergeOrder: 1 })] });
      stateJobs = [makeStateJob('other')];
      const { train, finish } = controllableTrain(merging);
      const orchestrator = create();
      await orchestrator.resumePlan();
      (orchestrator as unknown as { mergeTrain: unknown }).mergeTrain = train;
      train.queue = [merging];
      await waitUntil(() => train.started);

      // The other job fails while the tests of the merge are still running.
      stateJobs = [makeStateJob('other', { status: 'failed', failureReason: 'its session ended with an error' })];
      monitor.emit('failed', stateJobs[0]);
      await waitUntil(() => planState?.status === 'paused');

      finish({ success: true, mergedAt: '2026-01-02T00:00:00.000Z', testReport: undefined });
      await new Promise((resolve) => setTimeout(resolve, 30));

      // The finished merge is recorded, but the pause survives: the plan can
      // still be approved. (It used to be written back to `running`, which
      // mc_plan_approve refuses.)
      expect(jobStatus('merge-me')).toBe('merged');
      expect(planState?.status).toBe('paused');
      expect(planState?.checkpoint).toBe('on_error');
      const afterPause = planWrites.slice(planWrites.findIndex((write) => write.status === 'paused') + 1);
      expect(afterPause.some((write) => write.status !== undefined)).toBe(false);
    });

    it('restores the pause of a plan left running with a checkpoint set', async () => {
      planState = makePlan({
        status: 'running',
        checkpoint: 'on_error',
        checkpointContext: { jobName: 'job-a', failureKind: 'job_failed' },
        jobs: [makeJob('job-a', { status: 'failed' }), makeJob('job-b')],
      });
      const launch = spyOn(jobLauncherMod, 'launchJob');
      const orchestrator = create();

      await reconcile(orchestrator);

      expect(planState?.status).toBe('paused');
      expect(planState?.checkpoint).toBe('on_error');
      expect(launch).not.toHaveBeenCalled();
    });
  });

  describe('cancelPlan', () => {
    it('marks the plan canceled before it stops any job', async () => {
      planState = makePlan({ jobs: [makeJob('job-a', { status: 'running' }), makeJob('queued-job')] });
      stateJobs = [makeStateJob('job-a')];
      const order: string[] = [];
      (planStateMod.updatePlanFields as ReturnType<typeof mock>).mockImplementation(
        async (_planId: string, updates: Record<string, unknown>) => {
          order.push(`plan:${String(updates.status)}`);
          Object.assign(planState!, updates);
        },
      );
      (jobRuntimeMod.stopJobSession as ReturnType<typeof mock>).mockImplementation(async () => {
        order.push('stop job-a');
      });

      await create().cancelPlan();

      expect(order).toEqual(['plan:canceled', 'stop job-a']);
      expect(planState).toBeNull();
    });

    it('lets no other orchestrator launch queued jobs while the plan is being canceled', async () => {
      planState = makePlan({ jobs: [makeJob('job-a', { status: 'running' }), makeJob('queued-job')] });
      stateJobs = [makeStateJob('job-a')];
      const launch = spyOn(jobLauncherMod, 'launchJob').mockImplementation(async (options) => makeStateJob(options.name));
      const bystander = create();
      // Stopping a job frees a slot. A reconcile tick landing right then used
      // to launch the queued job into a plan that was being deleted.
      (jobRuntimeMod.stopJobSession as ReturnType<typeof mock>).mockImplementation(async () => {
        await reconcile(bystander);
      });

      await create().cancelPlan();

      expect(launch).not.toHaveBeenCalled();
    });
  });

  describe('resumePlan after a restart', () => {
    it.each(['merging', 'creating_pr', 'pending'] as const)('picks up a plan that was cut off in status %s', async (status) => {
      planState = makePlan({ status, jobs: [makeJob('job-a', { status: 'running' })] });
      stateJobs = [makeStateJob('job-a')];
      const orchestrator = create();

      await orchestrator.resumePlan();

      expect(planState?.status).toBe('running');
      expect(monitor.listenerCount('complete')).toBe(1);
      expect((orchestrator as unknown as { reconcilerInterval: unknown }).reconcilerInterval).not.toBeNull();
    });

    it('leaves a copilot plan that still waits for approval alone', async () => {
      planState = makePlan({ mode: 'copilot', status: 'pending' });
      const orchestrator = create();

      await orchestrator.resumePlan();

      expect(planState?.status).toBe('pending');
      expect(monitor.listenerCount('complete')).toBe(0);
    });

    it('does not resume a finished plan', async () => {
      planState = makePlan({ status: 'completed' });
      const orchestrator = create();

      await orchestrator.resumePlan();

      expect(monitor.listenerCount('complete')).toBe(0);
    });

    it('keeps a checkpoint whose status was lost, as a pause', async () => {
      planState = makePlan({ status: 'running', checkpoint: 'pre_merge' });
      const orchestrator = create();

      await orchestrator.resumePlan();

      expect(planState?.status).toBe('paused');
      expect(orchestrator.getCheckpoint()).toBe('pre_merge');
      expect(monitor.listenerCount('complete')).toBe(0);
    });
  });

  describe('plan model', () => {
    it("launches jobs on the plan's recorded model, without needing a snapshot in memory", async () => {
      planState = makePlan({
        model: 'anthropic/claude-sonnet-4',
        jobs: [makeJob('plain'), makeJob('own-model', { model: 'openai/gpt-5' })],
      });
      const launch = spyOn(jobLauncherMod, 'launchJob').mockImplementation(async (options) => makeStateJob(options.name));
      // A fresh orchestrator, as after a restart or an approval: nothing set on it.
      const orchestrator = create();

      await reconcile(orchestrator);

      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ name: 'plain', model: 'anthropic/claude-sonnet-4' }));
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ name: 'own-model', model: 'openai/gpt-5' }));
    });
  });

  describe('PR creation', () => {
    it('uses the PR that already exists when a restart interrupted its creation', async () => {
      planState = makePlan({ status: 'running', jobs: [makeJob('done', { status: 'merged' })] });
      const orchestrator = create();
      const commands: string[][] = [];
      spyOn(orchestrator as never, 'runCommand').mockImplementation((async (command: string[]) => {
        commands.push(command);
        if (command[0] === 'git') return { stdout: '', stderr: '', exitCode: 0 };
        if (command[1] === 'pr' && command[2] === 'create') {
          return {
            stdout: '',
            stderr: 'a pull request for branch "mc/integration-plan-1" into branch "main" already exists',
            exitCode: 1,
          };
        }
        return { stdout: 'https://github.com/acme/repo/pull/7', stderr: '', exitCode: 0 };
      }) as never);

      await reconcile(orchestrator);

      expect(planState?.status).toBe('completed');
      expect(planState?.prUrl).toBe('https://github.com/acme/repo/pull/7');
      expect(commands.map((command) => command.slice(0, 3).join(' '))).toEqual([
        'git push origin',
        'gh pr create',
        'gh pr view',
      ]);
    });
  });
});
