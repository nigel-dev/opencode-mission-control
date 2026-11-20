import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as worktree from '../../src/lib/worktree';
import * as jobState from '../../src/lib/job-state';
import * as planState from '../../src/lib/plan-state';
import * as reports from '../../src/lib/reports';
import * as singleton from '../../src/lib/orchestrator-singleton';
import * as questionRelay from '../../src/lib/question-relay';
import * as rpcEvents from '../../src/lib/rpc-events';
import type { Job } from '../../src/lib/job-state';
import type { PlanSpec } from '../../src/lib/plan-types';
import type { AgentReport } from '../../src/lib/reports';
import { getProjectDirectory, runInProject } from '../../src/lib/project-context';
import {
  buildSnapshot,
  countJobs,
  createJobAgentRpcHandlers,
  createRpcHandlers,
  deriveAttention,
  toPlanView,
} from '../../src/lib/rpc-handlers';
import { mc_kill } from '../../src/tools/kill';
import { mc_cleanup } from '../../src/tools/cleanup';
import { mc_answer } from '../../src/tools/answer';
import { mc_plan_approve } from '../../src/tools/plan-approve';
import { mc_plan_cancel } from '../../src/tools/plan-cancel';
import { mc_capture } from '../../src/tools/capture';
import { mc_launch } from '../../src/tools/launch';

const PROJECT = '/tmp/mc-rpc-handlers-project';
const HOST_CONTEXT = '/tmp/mc-rpc-handlers-host';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'alpha',
    worktreePath: '/tmp/wt/alpha',
    branch: 'mc/alpha',
    status: 'running',
    prompt: 'Do the work',
    createdAt: '2026-11-16T10:00:00.000Z',
    ...overrides,
  };
}

function makeReport(overrides: Partial<AgentReport> = {}): AgentReport {
  return {
    jobId: 'job-1',
    jobName: 'alpha',
    status: 'working',
    message: 'Working',
    timestamp: '2026-11-16T10:05:00.000Z',
    ...overrides,
  };
}

function makePlan(overrides: Partial<PlanSpec> = {}): PlanSpec {
  return {
    id: 'plan-1',
    name: 'Release',
    mode: 'supervisor',
    status: 'running',
    integrationBranch: 'mc/integration/plan-1',
    baseCommit: 'abc123',
    createdAt: '2026-11-16T09:00:00.000Z',
    jobs: [
      { id: 'a', name: 'alpha', prompt: 'A', status: 'merged' },
      { id: 'b', name: 'beta', prompt: 'B', status: 'running', dependsOn: ['alpha'] },
    ],
    ...overrides,
  };
}

/** The error factory the host passes to a handler. */
function makeContext() {
  const error = vi.fn((type: string, message: string, data: { message: string }) => ({
    type,
    message,
    data,
  }));
  return { signal: new AbortController().signal, error } as unknown as Parameters<
    ReturnType<typeof createRpcHandlers>['kill']
  >[1] & { error: typeof error };
}

describe('rpc handlers', () => {
  let accumulators: Map<string, { filesEdited: string[]; currentTool?: string; currentFile?: string }>;
  let jobs: Job[];
  let jobReports: Map<string, AgentReport>;
  let pending: Map<string, number>;

  beforeEach(() => {
    accumulators = new Map();
    jobs = [];
    jobReports = new Map();
    pending = new Map();

    vi.spyOn(jobState, 'loadJobState').mockImplementation(async () => ({
      version: 4,
      jobs,
      updatedAt: '2026-11-16T10:00:00.000Z',
    }));
    vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);
    vi.spyOn(reports, 'readReport').mockImplementation(async (jobId: string) => jobReports.get(jobId) ?? null);
    vi.spyOn(singleton, 'getSharedMonitor').mockReturnValue({
      getEventAccumulator: (jobId: string) => accumulators.get(jobId),
      getUnansweredPermissionCount: () => 0,
    } as unknown as ReturnType<typeof singleton.getSharedMonitor>);
    vi.spyOn(questionRelay, 'getPendingQuestionsForJob').mockImplementation((jobId: string) =>
      Array.from({ length: pending.get(jobId) ?? 0 }) as ReturnType<
        typeof questionRelay.getPendingQuestionsForJob
      >,
    );
    vi.spyOn(rpcEvents, 'emitChanged').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('deriveAttention', () => {
    it('reports a running job waiting on a permission request as needing an answer', () => {
      expect(deriveAttention({ status: 'running' }, null, 0, 1)).toBe('question');
      expect(deriveAttention({ status: 'completed' }, null, 0, 1)).toBe('none');
    });

    it('prefers a pending question over the report', () => {
      expect(deriveAttention({ status: 'running' }, { status: 'blocked' }, 1)).toBe('question');
    });

    it('reports blocked only while the job is running', () => {
      expect(deriveAttention({ status: 'running' }, { status: 'blocked' }, 0)).toBe('blocked');
      expect(deriveAttention({ status: 'stopped' }, { status: 'blocked' }, 0)).toBe('none');
      expect(deriveAttention({ status: 'failed' }, { status: 'blocked' }, 3)).toBe('none');
    });

    it('reports needs_review for running and completed jobs', () => {
      expect(deriveAttention({ status: 'running' }, { status: 'needs_review' }, 0)).toBe('needs_review');
      expect(deriveAttention({ status: 'completed' }, { status: 'needs_review' }, 0)).toBe('needs_review');
      expect(deriveAttention({ status: 'failed' }, { status: 'needs_review' }, 0)).toBe('none');
    });

    it('flags a completed job that left uncommitted changes, whatever its report says', () => {
      expect(deriveAttention({ status: 'completed', uncommittedChanges: ['a.ts'] }, null, 0)).toBe('needs_review');
      expect(deriveAttention({ status: 'completed', uncommittedChanges: ['a.ts'] }, { status: 'completed' }, 0)).toBe(
        'needs_review',
      );
      expect(deriveAttention({ status: 'completed', uncommittedChanges: [] }, { status: 'completed' }, 0)).toBe('none');
    });

    it('is none without a report or for an ordinary report', () => {
      expect(deriveAttention({ status: 'running' }, null, 0)).toBe('none');
      expect(deriveAttention({ status: 'running' }, { status: 'progress' }, 0)).toBe('none');
    });
  });

  describe('countJobs', () => {
    it('counts each job once, with jobs needing attention under blocked', () => {
      expect(
        countJobs([
          { status: 'running', attention: 'none' },
          { status: 'running', attention: 'none' },
          { status: 'running', attention: 'blocked' },
          { status: 'completed', attention: 'needs_review' },
          { status: 'completed', attention: 'none' },
          { status: 'failed', attention: 'none' },
          { status: 'stopped', attention: 'none' },
        ]),
      ).toEqual({ running: 2, blocked: 2, completed: 1, failed: 1, stopped: 1 });
    });
  });

  describe('toPlanView', () => {
    it('maps plan jobs with their dependencies', () => {
      expect(toPlanView(makePlan({ prUrl: 'https://example.com/pr/1' }))).toEqual({
        id: 'plan-1',
        name: 'Release',
        mode: 'supervisor',
        status: 'running',
        prUrl: 'https://example.com/pr/1',
        jobs: [
          { name: 'alpha', status: 'merged', dependsOn: [] },
          { name: 'beta', status: 'running', dependsOn: ['alpha'] },
        ],
      });
    });

    it('describes a checkpoint and its cause', () => {
      const view = toPlanView(
        makePlan({
          status: 'paused',
          checkpoint: 'on_error',
          checkpointContext: { jobName: 'beta', failureKind: 'test_failure' },
        }),
      );

      expect(view.checkpoint).toBe('on_error');
      expect(view.checkpointMessage).toBe('Paused after an error: job "beta" failed the merge tests');
    });

    it('includes why the job failed when the checkpoint records it', () => {
      const view = toPlanView(
        makePlan({
          status: 'paused',
          checkpoint: 'on_error',
          checkpointContext: {
            jobName: 'beta',
            failureKind: 'launch_failed',
            reason: 'Invalid model "x"',
          },
        }),
      );

      expect(view.checkpointMessage).toBe(
        'Paused after an error: job "beta" could not be launched (Invalid model "x")',
      );
    });

    it('describes a checkpoint without a cause', () => {
      const view = toPlanView(makePlan({ status: 'paused', checkpoint: 'pre_pr', checkpointContext: null }));

      expect(view.checkpointMessage).toBe('Waiting for approval before creating the PR');
    });
  });

  describe('snapshot', () => {
    it('is empty when there are no jobs and no plan', async () => {
      expect(await buildSnapshot()).toEqual({
        jobs: [],
        plan: null,
        counts: { running: 0, blocked: 0, completed: 0, failed: 0, stopped: 0 },
      });
    });

    it('assembles job views from state, reports and monitor activity', async () => {
      jobs = [
        makeJob({ sessionID: 'ses_alpha', agent: 'build', model: 'anthropic/claude', planId: 'plan-1' }),
        makeJob({
          id: 'job-2',
          name: 'beta',
          worktreePath: '/tmp/wt/beta',
          branch: 'mc/beta',
          status: 'completed',
          completedAt: '2026-11-16T11:00:00.000Z',
        }),
      ];
      jobReports.set('job-1', makeReport({ status: 'progress', message: 'Halfway', progress: 50 }));
      accumulators.set('job-1', {
        filesEdited: ['src/a.ts', 'src/b.ts'],
        currentTool: 'edit',
        currentFile: 'src/b.ts',
      });

      const snapshot = await buildSnapshot();

      expect(snapshot.jobs).toEqual([
        {
          id: 'job-1',
          name: 'alpha',
          status: 'running',
          attention: 'none',
          branch: 'mc/alpha',
          worktreePath: '/tmp/wt/alpha',
          sessionID: 'ses_alpha',
          agent: 'build',
          model: 'anthropic/claude',
          planId: 'plan-1',
          createdAt: '2026-11-16T10:00:00.000Z',
          report: { status: 'progress', message: 'Halfway', progress: 50 },
          activity: { currentTool: 'edit', currentFile: 'src/b.ts', filesEdited: 2 },
        },
        {
          id: 'job-2',
          name: 'beta',
          status: 'completed',
          attention: 'none',
          branch: 'mc/beta',
          worktreePath: '/tmp/wt/beta',
          createdAt: '2026-11-16T10:00:00.000Z',
          completedAt: '2026-11-16T11:00:00.000Z',
        },
      ]);
      expect(snapshot.counts).toEqual({ running: 1, blocked: 0, completed: 1, failed: 0, stopped: 0 });
    });

    it('derives attention from reports and pending questions', async () => {
      jobs = [
        makeJob({ id: 'job-1', name: 'blocked-job' }),
        makeJob({ id: 'job-2', name: 'review-job', status: 'completed' }),
        makeJob({ id: 'job-3', name: 'question-job' }),
        makeJob({ id: 'job-4', name: 'plain-job' }),
      ];
      jobReports.set('job-1', makeReport({ jobId: 'job-1', status: 'blocked', message: 'Need a key' }));
      jobReports.set('job-2', makeReport({ jobId: 'job-2', status: 'needs_review', message: 'Check it' }));
      pending.set('job-3', 1);

      const snapshot = await buildSnapshot();

      expect(snapshot.jobs.map((job) => [job.name, job.attention])).toEqual([
        ['blocked-job', 'blocked'],
        ['review-job', 'needs_review'],
        ['question-job', 'question'],
        ['plain-job', 'none'],
      ]);
      expect(snapshot.counts).toEqual({ running: 1, blocked: 3, completed: 0, failed: 0, stopped: 0 });
    });

    it('notes why a job failed and that a finished job left uncommitted changes', async () => {
      jobs.push(
        makeJob({ id: 'f', name: 'failed-job', status: 'failed', failureReason: 'its session was deleted' }),
        makeJob({ id: 'd', name: 'dirty-job', status: 'completed', uncommittedChanges: ['a.ts', 'b.ts'] }),
        makeJob({ id: 'c', name: 'clean-job', status: 'completed' }),
      );

      const snapshot = await buildSnapshot();
      const byName = new Map(snapshot.jobs.map((job) => [job.name, job]));

      expect(byName.get('failed-job')?.note).toBe('its session was deleted');
      expect(byName.get('dirty-job')).toMatchObject({
        attention: 'needs_review',
        note: '2 uncommitted file(s) in its worktree are not on its branch',
      });
      expect(byName.get('clean-job')?.note).toBeUndefined();
      // A job needing attention is counted once, as blocked.
      expect(snapshot.counts).toMatchObject({ blocked: 1, completed: 1, failed: 1 });
    });

    it('includes the plan', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(makePlan());

      const snapshot = await buildSnapshot();

      expect(snapshot.plan?.name).toBe('Release');
      expect(snapshot.plan?.jobs).toHaveLength(2);
    });

    it('still returns the jobs when the plan cannot be loaded', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      jobs = [makeJob()];
      vi.spyOn(planState, 'loadPlan').mockRejectedValue(new Error('Invalid plan state'));

      const snapshot = await buildSnapshot();

      expect(snapshot.plan).toBeNull();
      expect(snapshot.jobs).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
    });

    it('takes a snapshot request as evidence that a client is connected', async () => {
      const seen = vi.spyOn(rpcEvents, 'recordClientSeen');
      const handlers = runInProject(PROJECT, () => createRpcHandlers());

      expect(seen).not.toHaveBeenCalled();
      await handlers.snapshot({}, makeContext());

      expect(seen).toHaveBeenCalledTimes(1);
    });

    it('is served by the snapshot handler', async () => {
      jobs = [makeJob()];
      const handlers = runInProject(PROJECT, () => createRpcHandlers());

      const result = await handlers.snapshot({}, makeContext());

      expect(result).toMatchObject({ jobs: [{ name: 'alpha' }], plan: null });
    });
  });

  describe('actions', () => {
    const ok = (content: string) => async () => ({ content });

    it('kill delegates to mc_kill', async () => {
      const execute = vi.spyOn(mc_kill, 'execute').mockImplementation(ok('stopped'));
      const handlers = runInProject(PROJECT, () => createRpcHandlers());

      const result = await handlers.kill({ name: 'alpha' }, makeContext());

      expect(execute).toHaveBeenCalledWith({ name: 'alpha' });
      expect(result).toEqual({ content: 'stopped' });
    });

    it('cleanup delegates to mc_cleanup', async () => {
      const execute = vi.spyOn(mc_cleanup, 'execute').mockImplementation(ok('cleaned'));
      const handlers = runInProject(PROJECT, () => createRpcHandlers());

      const result = await handlers.cleanup({ name: 'alpha', deleteBranch: true }, makeContext());

      expect(execute).toHaveBeenCalledWith({ name: 'alpha', all: undefined, deleteBranch: true, force: undefined });
      expect(result).toEqual({ content: 'cleaned' });
    });

    it('cleanup passes force through', async () => {
      const execute = vi.spyOn(mc_cleanup, 'execute').mockImplementation(ok('cleaned'));
      const handlers = runInProject(PROJECT, () => createRpcHandlers());

      await handlers.cleanup({ name: 'alpha', force: true }, makeContext());

      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'alpha', force: true }));
    });

    it('answer delegates to mc_answer', async () => {
      const execute = vi.spyOn(mc_answer, 'execute').mockImplementation(ok('sent'));
      const handlers = runInProject(PROJECT, () => createRpcHandlers());

      const result = await handlers.answer({ name: 'alpha', response: 'use blue' }, makeContext());

      expect(execute).toHaveBeenCalledWith({ name: 'alpha', response: 'use blue' });
      expect(result).toEqual({ content: 'sent' });
    });

    it('approve delegates to mc_plan_approve', async () => {
      const execute = vi.spyOn(mc_plan_approve, 'execute').mockImplementation(ok('approved'));
      const handlers = runInProject(PROJECT, () => createRpcHandlers());

      const result = await handlers.approve({ checkpoint: 'pre_merge' }, makeContext());

      expect(execute).toHaveBeenCalledWith({ checkpoint: 'pre_merge' });
      expect(result).toEqual({ content: 'approved' });
    });

    it('cancelPlan delegates to mc_plan_cancel', async () => {
      const execute = vi.spyOn(mc_plan_cancel, 'execute').mockImplementation(ok('canceled'));
      const handlers = runInProject(PROJECT, () => createRpcHandlers());

      const result = await handlers.cancelPlan({}, makeContext());

      expect(execute).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ content: 'canceled' });
    });

    it('capture delegates to mc_capture without announcing a change', async () => {
      const execute = vi.spyOn(mc_capture, 'execute').mockImplementation(ok('transcript'));
      const handlers = runInProject(PROJECT, () => createRpcHandlers());

      const result = await handlers.capture({ name: 'alpha', lines: 50 }, makeContext());

      expect(execute).toHaveBeenCalledWith({ name: 'alpha', lines: 50 });
      expect(result).toEqual({ content: 'transcript' });
      expect(rpcEvents.emitChanged).not.toHaveBeenCalled();
    });

    it('launch delegates to mc_launch without a launching session', async () => {
      const execute = vi.spyOn(mc_launch, 'execute').mockImplementation(ok('launched'));
      const handlers = runInProject(PROJECT, () => createRpcHandlers());

      const result = await handlers.launch(
        { name: 'gamma', prompt: 'Build it', agent: 'build', model: 'anthropic/claude', baseBranch: 'main' },
        makeContext(),
      );

      expect(execute).toHaveBeenCalledTimes(1);
      // Exactly one argument: no tool context, so no launching session ID.
      expect(execute.mock.calls[0]).toEqual([
        { name: 'gamma', prompt: 'Build it', agent: 'build', model: 'anthropic/claude', baseBranch: 'main' },
      ]);
      expect(result).toEqual({ content: 'launched' });
    });

    it('announces a change after a successful mutation', async () => {
      vi.spyOn(mc_kill, 'execute').mockImplementation(ok('stopped'));
      const handlers = runInProject(PROJECT, () => createRpcHandlers());

      await handlers.kill({ name: 'alpha' }, makeContext());

      expect(rpcEvents.emitChanged).toHaveBeenCalledWith('kill');
    });

    it('translates a thrown error into the declared failed error', async () => {
      vi.spyOn(mc_kill, 'execute').mockRejectedValue(new Error('Job "ghost" not found'));
      const handlers = runInProject(PROJECT, () => createRpcHandlers());
      const context = makeContext();

      const result = await handlers.kill({ name: 'ghost' }, context);

      expect(context.error).toHaveBeenCalledWith('failed', 'Job "ghost" not found', {
        message: 'Job "ghost" not found',
      });
      expect(result).toEqual({
        type: 'failed',
        message: 'Job "ghost" not found',
        data: { message: 'Job "ghost" not found' },
      });
      expect(rpcEvents.emitChanged).not.toHaveBeenCalled();
    });

    it('translates a non-Error rejection too', async () => {
      vi.spyOn(mc_answer, 'execute').mockRejectedValue('plain failure');
      const handlers = runInProject(PROJECT, () => createRpcHandlers());
      const context = makeContext();

      await handlers.answer({ name: 'alpha', response: 'x' }, context);

      expect(context.error).toHaveBeenCalledWith('failed', 'plain failure', { message: 'plain failure' });
    });
  });

  describe('project context', () => {
    it('runs the snapshot in the project the handlers were created for', async () => {
      let seen: string | undefined;
      vi.spyOn(jobState, 'loadJobState').mockImplementation(async () => {
        seen = getProjectDirectory();
        return { version: 4, jobs: [], updatedAt: '' };
      });
      const handlers = runInProject(PROJECT, () => createRpcHandlers());

      // The host calls handlers from its own async context.
      await runInProject(HOST_CONTEXT, () => handlers.snapshot({}, makeContext()));

      expect(seen).toBe(PROJECT);
    });

    it('runs actions in the project the handlers were created for', async () => {
      const seen: string[] = [];
      const record = async () => {
        seen.push(getProjectDirectory());
        return { content: 'ok' };
      };
      vi.spyOn(mc_kill, 'execute').mockImplementation(record);
      vi.spyOn(mc_cleanup, 'execute').mockImplementation(record);
      vi.spyOn(mc_answer, 'execute').mockImplementation(record);
      vi.spyOn(mc_plan_approve, 'execute').mockImplementation(record);
      vi.spyOn(mc_plan_cancel, 'execute').mockImplementation(record);
      vi.spyOn(mc_capture, 'execute').mockImplementation(record);
      vi.spyOn(mc_launch, 'execute').mockImplementation(record);
      const handlers = runInProject(PROJECT, () => createRpcHandlers());

      await runInProject(HOST_CONTEXT, async () => {
        await handlers.kill({ name: 'a' }, makeContext());
        await handlers.cleanup({ all: true }, makeContext());
        await handlers.answer({ name: 'a', response: 'r' }, makeContext());
        await handlers.approve({}, makeContext());
        await handlers.cancelPlan({}, makeContext());
        await handlers.capture({ name: 'a' }, makeContext());
        await handlers.launch({ name: 'a', prompt: 'p' }, makeContext());
      });

      expect(seen).toEqual(Array.from({ length: 7 }, () => PROJECT));
    });
  });

  describe('job agent handlers', () => {
    it('reports no jobs and refuses every action', async () => {
      const execute = vi.spyOn(mc_kill, 'execute');
      const handlers = createJobAgentRpcHandlers();
      const context = makeContext();

      // An empty snapshot that points the client at the main checkout, which owns the jobs.
      vi.spyOn(worktree, 'getMainWorktree').mockResolvedValue('/repo/main');
      expect(await handlers.snapshot({}, context)).toEqual({
        jobs: [],
        plan: null,
        counts: { running: 0, blocked: 0, completed: 0, failed: 0, stopped: 0 },
        home: '/repo/main',
      });

      const results = [
        await handlers.kill({ name: 'a' }, context),
        await handlers.cleanup({ all: true }, context),
        await handlers.answer({ name: 'a', response: 'r' }, context),
        await handlers.approve({}, context),
        await handlers.cancelPlan({}, context),
        await handlers.capture({ name: 'a' }, context),
        await handlers.launch({ name: 'a', prompt: 'p' }, context),
      ];

      for (const result of results) {
        expect(result).toMatchObject({ type: 'failed' });
      }
      expect(execute).not.toHaveBeenCalled();
      expect(jobState.loadJobState).not.toHaveBeenCalled();
    });
  });
});
