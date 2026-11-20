import type { RpcHandlers } from '@opencode/plugin/promise/rpc';
import type {
  ActionResult,
  JobAttention,
  JobView,
  PlanView,
  Snapshot,
  SnapshotCounts,
  missionControlRpc,
} from '../rpc';
import { loadJobState, type Job } from './job-state';
import { loadPlan } from './plan-state';
import type { CheckpointContext, CheckpointType, PlanSpec } from './plan-types';
import { readReport, type AgentReport } from './reports';
import { getSharedMonitor } from './orchestrator-singleton';
import { getPendingQuestionsForJob } from './question-relay';
import { bindToDirectory, getProjectDirectory } from './project-context';
import { emitChanged, recordClientSeen } from './rpc-events';
import { getMainWorktree } from './worktree';
import { mc_kill } from '../tools/kill';
import { mc_cleanup } from '../tools/cleanup';
import { mc_answer } from '../tools/answer';
import { mc_plan_approve } from '../tools/plan-approve';
import { mc_plan_cancel } from '../tools/plan-cancel';
import { mc_capture } from '../tools/capture';
import { mc_launch } from '../tools/launch';

export type MissionControlHandlers = RpcHandlers<typeof missionControlRpc>;

/**
 * What a job is waiting on, if anything. A pending question form wins over a
 * report; a "blocked" report only counts while the job is still running, and
 * "needs_review" also applies to a job that finished.
 */
export function deriveAttention(
  job: Pick<Job, 'status' | 'uncommittedChanges'>,
  report: Pick<AgentReport, 'status'> | null,
  pendingQuestions: number,
  unansweredPermissions = 0,
): JobAttention {
  if (job.status === 'completed' && (job.uncommittedChanges?.length ?? 0) > 0) {
    // Finished, but part of its work is not on its branch.
    return 'needs_review';
  }
  if (job.status === 'running' && (pendingQuestions > 0 || unansweredPermissions > 0)) {
    return 'question';
  }
  if (job.status === 'running' && report?.status === 'blocked') {
    return 'blocked';
  }
  if ((job.status === 'running' || job.status === 'completed') && report?.status === 'needs_review') {
    return 'needs_review';
  }
  return 'none';
}

/**
 * Counts partition the jobs: a job needing attention is counted as `blocked`
 * only, every other job under its status.
 */
export function countJobs(jobs: readonly Pick<JobView, 'status' | 'attention'>[]): SnapshotCounts {
  const counts: SnapshotCounts = { running: 0, blocked: 0, completed: 0, failed: 0, stopped: 0 };
  for (const job of jobs) {
    if (job.attention !== 'none') {
      counts.blocked++;
    } else {
      counts[job.status]++;
    }
  }
  return counts;
}

const CHECKPOINT_MESSAGES: Record<CheckpointType, string> = {
  pre_merge: 'Waiting for approval before merging',
  on_error: 'Paused after an error',
  pre_pr: 'Waiting for approval before creating the PR',
};

const FAILURE_LABELS: Record<CheckpointContext['failureKind'], string> = {
  touchset: 'changed files outside its touch set',
  merge_conflict: 'has a merge conflict',
  test_failure: 'failed the merge tests',
  job_failed: 'failed',
  launch_failed: 'could not be launched',
  uncommitted_changes: 'finished with uncommitted changes',
};

function checkpointMessage(plan: PlanSpec): string | undefined {
  if (!plan.checkpoint) {
    return undefined;
  }
  const context = plan.checkpointContext;
  if (context) {
    const reason = context.reason ? ` (${context.reason})` : '';
    return `${CHECKPOINT_MESSAGES[plan.checkpoint]}: job "${context.jobName}" ${FAILURE_LABELS[context.failureKind]}${reason}`;
  }
  return CHECKPOINT_MESSAGES[plan.checkpoint];
}

export function toPlanView(plan: PlanSpec): PlanView {
  return {
    id: plan.id,
    name: plan.name,
    mode: plan.mode,
    status: plan.status,
    ...(plan.checkpoint ? { checkpoint: plan.checkpoint } : {}),
    ...(plan.checkpoint ? { checkpointMessage: checkpointMessage(plan) } : {}),
    ...(plan.prUrl ? { prUrl: plan.prUrl } : {}),
    ...(plan.failureReason ? { failureReason: plan.failureReason } : {}),
    jobs: plan.jobs.map((job) => ({
      name: job.name,
      status: job.status,
      dependsOn: job.dependsOn ?? [],
    })),
  };
}

async function toJobView(job: Job): Promise<JobView> {
  let report: AgentReport | null = null;
  try {
    report = await readReport(job.id);
  } catch (error) {
    console.warn(`[Mission Control] Could not read the report of job "${job.name}":`, error);
  }

  const monitor = getSharedMonitor();
  const accumulator = monitor.getEventAccumulator(job.id);
  const attention = deriveAttention(
    job,
    report,
    getPendingQuestionsForJob(job.id).length,
    monitor.getUnansweredPermissionCount(job.id),
  );
  const uncommitted = job.uncommittedChanges?.length ?? 0;
  const note =
    job.status === 'completed' && uncommitted > 0
      ? `${uncommitted} uncommitted file(s) in its worktree are not on its branch`
      : job.status === 'failed'
        ? job.failureReason
        : undefined;

  return {
    id: job.id,
    name: job.name,
    status: job.status,
    attention,
    branch: job.branch,
    worktreePath: job.worktreePath,
    ...(job.sessionID ? { sessionID: job.sessionID } : {}),
    ...(job.agent ? { agent: job.agent } : {}),
    ...(job.model ? { model: job.model } : {}),
    ...(job.planId ? { planId: job.planId } : {}),
    createdAt: job.createdAt,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(note ? { note } : {}),
    ...(report
      ? {
          report: {
            status: report.status,
            message: report.message,
            ...(report.progress !== undefined ? { progress: report.progress } : {}),
          },
        }
      : {}),
    ...(accumulator
      ? {
          activity: {
            ...(accumulator.currentTool ? { currentTool: accumulator.currentTool } : {}),
            ...(accumulator.currentFile ? { currentFile: accumulator.currentFile } : {}),
            filesEdited: accumulator.filesEdited.length,
          },
        }
      : {}),
  };
}

/** The state of the current project's jobs and plan, as sent to clients. */
export async function buildSnapshot(): Promise<Snapshot> {
  const state = await loadJobState();
  const jobs = await Promise.all(state.jobs.map(toJobView));

  let plan: PlanSpec | null = null;
  try {
    plan = await loadPlan();
  } catch (error) {
    // An unreadable plan file must not hide the jobs from the TUI.
    console.warn('[Mission Control] Could not load the plan for a snapshot:', error);
  }

  return {
    jobs,
    plan: plan ? toPlanView(plan) : null,
    counts: countJobs(jobs),
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || 'Unknown error';
}

/**
 * Run a tool on behalf of an RPC action: tools throw for expected failures
 * (unknown job, job not running, ...), which become the declared `failed`
 * error. A successful mutation tells clients to refetch.
 */
async function runAction<Failure>(
  context: { error: (type: 'failed', message: string, data: { message: string }) => Failure },
  reason: string | undefined,
  execute: () => Promise<ActionResult>,
): Promise<ActionResult | Failure> {
  try {
    const result = await execute();
    if (reason) {
      emitChanged(reason);
    }
    return { content: result.content };
  } catch (error) {
    const message = errorMessage(error);
    return context.error('failed', message, { message });
  }
}

/**
 * Handlers for the command-center plugin instance. The host calls them from
 * its own async context, so each is bound to the project directory that is
 * current when this is called.
 */
export function createRpcHandlers(): MissionControlHandlers {
  const directory = getProjectDirectory();

  const handlers: MissionControlHandlers = {
    snapshot: async () => {
      // Only the TUI part asks for snapshots: it is connected and listening.
      recordClientSeen();
      return { ...(await buildSnapshot()), home: directory };
    },
    kill: (input, context) =>
      runAction(context, 'kill', () => mc_kill.execute({ name: input.name })),
    cleanup: (input, context) =>
      runAction(context, 'cleanup', () =>
        mc_cleanup.execute({
          name: input.name,
          all: input.all,
          deleteBranch: input.deleteBranch,
          force: input.force,
        }),
      ),
    answer: (input, context) =>
      runAction(context, 'answer', () =>
        mc_answer.execute({ name: input.name, response: input.response }),
      ),
    approve: (input, context) =>
      runAction(context, 'approve', () => mc_plan_approve.execute({ checkpoint: input.checkpoint })),
    cancelPlan: (_input, context) =>
      runAction(context, 'cancelPlan', () => mc_plan_cancel.execute()),
    capture: (input, context) =>
      runAction(context, undefined, () =>
        mc_capture.execute({ name: input.name, lines: input.lines }),
      ),
    // The RPC call context carries no session, so the job has no launching
    // session: its notifications go to the active session instead.
    launch: (input, context) =>
      runAction(context, 'launch', () =>
        mc_launch.execute({
          name: input.name,
          prompt: input.prompt,
          agent: input.agent,
          model: input.model,
          baseBranch: input.baseBranch,
        }),
      ),
  };

  return bindHandlers(directory, handlers);
}

const JOB_AGENT_MESSAGE =
  'Mission Control actions are not available from inside a job worktree. Use the session that launched the job.';

/**
 * Handlers for a plugin instance loaded inside a job worktree. Jobs are managed
 * from the command center, so this instance reports no jobs and mutates nothing.
 */
export function createJobAgentRpcHandlers(): MissionControlHandlers {
  const unavailable = async <Failure>(context: {
    error: (type: 'failed', message: string, data: { message: string }) => Failure;
  }): Promise<Failure> => context.error('failed', JOB_AGENT_MESSAGE, { message: JOB_AGENT_MESSAGE });

  // A job worktree belongs to a project whose jobs are owned by the plugin
  // instance of the main checkout; point clients there.
  const findHome = bindToDirectory(getProjectDirectory(), async (): Promise<string | undefined> => {
    try {
      return await getMainWorktree();
    } catch (error) {
      console.warn('[Mission Control] Could not resolve the main checkout of a job worktree:', error);
      return undefined;
    }
  });

  return {
    snapshot: async () => ({ jobs: [], plan: null, counts: countJobs([]), home: await findHome() }),
    kill: (_input, context) => unavailable(context),
    cleanup: (_input, context) => unavailable(context),
    answer: (_input, context) => unavailable(context),
    approve: (_input, context) => unavailable(context),
    cancelPlan: (_input, context) => unavailable(context),
    capture: (_input, context) => unavailable(context),
    launch: (_input, context) => unavailable(context),
  };
}

function bindHandlers(directory: string, handlers: MissionControlHandlers): MissionControlHandlers {
  return {
    snapshot: bindToDirectory(directory, handlers.snapshot),
    kill: bindToDirectory(directory, handlers.kill),
    cleanup: bindToDirectory(directory, handlers.cleanup),
    answer: bindToDirectory(directory, handlers.answer),
    approve: bindToDirectory(directory, handlers.approve),
    cancelPlan: bindToDirectory(directory, handlers.cancelPlan),
    capture: bindToDirectory(directory, handlers.capture),
    launch: bindToDirectory(directory, handlers.launch),
  };
}
