import { bindToDirectory, getProjectDirectory } from './project-context';
import type { MCConfig } from './config';
import type { PlanSpec, JobSpec, PlanStatus, CheckpointType, CheckpointContext } from './plan-types';
import { loadPlan, savePlan, updatePlanJob, updatePlanFields, clearPlan, validateGhAuth } from './plan-state';
import { getDefaultBranch, gitCommand } from './git';
import { fillPrTemplate, loadPrTemplate } from './pr-template';
import { createIntegrationBranch, deleteIntegrationBranch } from './integration';
import { MergeTrain, checkMergeability, type MergeTestReport, validateTouchSet } from './merge-train';
import { getRunningJobs, updateJob, loadJobState, type Job } from './job-state';
import { JobMonitor } from './monitor';
import { removeWorktree } from './worktree';
import { resolvePostCreateHook } from './worktree-setup';
import { launchJob as launchSharedJob } from './job-launcher';
import { removeJobSession, stopJobSession } from './job-runtime';

type PlanSpecWithAuth = PlanSpec & { ghAuthenticated?: boolean };

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';
export type ToastCallback = (
  title: string,
  message: string,
  variant: ToastVariant,
  duration: number,
) => void;
export type NotifyCallback = (message: string, targetSessionID?: string) => void;
/**
 * Tells clients a supervisor checkpoint needs the user. Returns whether the
 * request was sent; when it was not, the orchestrator falls back to a toast.
 */
export type CheckpointAttentionCallback = (checkpoint: CheckpointType, message: string) => boolean;

const TERMINAL_PLAN_STATUSES: PlanStatus[] = ['completed', 'failed', 'canceled'];

function isTerminalPlanStatus(status: PlanStatus): boolean {
  return TERMINAL_PLAN_STATUSES.includes(status);
}

function compactOutput(output?: string, maxLength = 180): string | null {
  if (!output) {
    return null;
  }

  const normalized = output.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function summarizeFiles(files: string[], max = 10): string {
  if (files.length <= max) {
    return files.join(', ');
  }
  return `${files.slice(0, max).join(', ')} (+${files.length - max} more)`;
}

function toAdjacencyMap(jobs: JobSpec[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const job of jobs) {
    map.set(job.name, job.dependsOn ?? []);
  }
  return map;
}

export function hasCircularDependency(jobs: JobSpec[]): boolean {
  const graph = toAdjacencyMap(jobs);
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (node: string): boolean => {
    if (visiting.has(node)) {
      return true;
    }
    if (visited.has(node)) {
      return false;
    }

    visiting.add(node);
    const neighbors = graph.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (!graph.has(neighbor)) {
        continue;
      }
      if (visit(neighbor)) {
        return true;
      }
    }

    visiting.delete(node);
    visited.add(node);
    return false;
  };

  for (const node of graph.keys()) {
    if (visit(node)) {
      return true;
    }
  }

  return false;
}

export function topologicalSort(jobs: JobSpec[]): JobSpec[] {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const job of jobs) {
    indegree.set(job.name, 0);
    outgoing.set(job.name, []);
  }

  for (const job of jobs) {
    for (const dep of job.dependsOn ?? []) {
      if (!byName.has(dep)) {
        continue;
      }
      indegree.set(job.name, (indegree.get(job.name) ?? 0) + 1);
      outgoing.get(dep)!.push(job.name);
    }
  }

  const queue: string[] = [];
  for (const [name, degree] of indegree.entries()) {
    if (degree === 0) {
      queue.push(name);
    }
  }

  const sorted: JobSpec[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(byName.get(name)!);

    for (const next of outgoing.get(name) ?? []) {
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
      }
    }
  }

  if (sorted.length !== jobs.length) {
    throw new Error('Plan contains circular dependencies');
  }

  return sorted;
}

export class Orchestrator {
  private monitor: JobMonitor;
  private config: MCConfig;
  private mergeTrain: MergeTrain | null = null;
  private reconcilerInterval: Timer | null = null;
  private isRunning = false;
  private isReconciling = false;
  private reconcilePending = false;
  private activePlanId: string | null = null;
  private planModelSnapshot: string | undefined;
  private planLaunchSessionID: string | undefined;
  private subscriptionsActive = false;
  private checkpoint: CheckpointType | null = null;
  private toastCallback: ToastCallback | null = null;
  private notifyCallback: NotifyCallback | null = null;
  private attentionCallback: CheckpointAttentionCallback | null = null;
  private jobsLaunchedCount = 0;
  private approvedForMerge = new Set<string>();
  private firstJobCompleted = false;
  private disposed = false;
  /** The reconcile pass in flight, if any; `dispose()` waits for it. */
  private reconcileInFlight: Promise<void> | null = null;

  private getMergeTrainConfig(): {
    testCommand?: string;
    testTimeout?: number;
    mergeStrategy?: 'squash' | 'ff-only' | 'merge';
    setupCommands?: string[];
    fixBeforeRollbackTimeout?: number;
  } {
    return {
      testCommand: this.config.testCommand,
      testTimeout: this.config.testTimeout,
      mergeStrategy: this.config.mergeStrategy,
      setupCommands: this.config.worktreeSetup?.commands,
      fixBeforeRollbackTimeout: this.config.fixBeforeRollbackTimeout,
    };
  }

  constructor(monitor: JobMonitor, config: MCConfig, callbacks?: ToastCallback | { toast?: ToastCallback; notify?: NotifyCallback; attention?: CheckpointAttentionCallback }) {
    this.monitor = monitor;
    this.config = config;
    if (typeof callbacks === 'function') {
      this.toastCallback = callbacks;
      this.notifyCallback = null;
    } else {
      this.toastCallback = callbacks?.toast ?? null;
      this.notifyCallback = callbacks?.notify ?? null;
      this.attentionCallback = callbacks?.attention ?? null;
    }
  }

  /**
   * Model for plan jobs that name none, when the plan itself records none
   * (plans created before the model was stored in plan.json).
   */
  setPlanModelSnapshot(model: string | undefined): void {
    this.planModelSnapshot = model;
  }

  /**
   * Stop this orchestrator for good: no more reconcile ticks, no reaction to
   * monitor events, no new launches or merges, and a merge test that is
   * running is aborted. Resolves once a reconcile pass that was already in
   * flight has returned, so a successor never works on the plan concurrently.
   * Idempotent.
   */
  dispose(): Promise<void> {
    this.disposed = true;
    this.stopReconciler();
    this.unsubscribeFromMonitorEvents();
    this.mergeTrain?.stop();
    return this.reconcileInFlight ?? Promise.resolve();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private showToast(title: string, message: string, variant: ToastVariant): void {
    if (!this.toastCallback) return;
    const durations: Record<ToastVariant, number> = {
      success: 3000,
      info: 5000,
      warning: 8000,
      error: 8000,
    };
    this.toastCallback(title, message, variant, durations[variant]);
  }

  private notify(message: string, targetSessionID?: string): void {
    if (!this.notifyCallback) return;
    this.notifyCallback(message, targetSessionID ?? this.planLaunchSessionID);
  }

  private formatTestReportSummary(testReport?: MergeTestReport): string | null {
    if (!testReport) {
      return null;
    }

    const parts: string[] = [];

    if (testReport.status === 'skipped') {
      parts.push('tests skipped');
    } else if (testReport.status === 'passed') {
      parts.push('tests passed');
    } else {
      parts.push('tests failed');
    }

    if (testReport.command) {
      parts.push(`command: ${testReport.command}`);
    }

    if (testReport.setup.status === 'passed') {
      if (testReport.setup.commands.length > 0) {
        parts.push(`setup passed: ${testReport.setup.commands.join(' && ')}`);
      } else {
        parts.push('setup skipped');
      }
    } else if (testReport.setup.status === 'failed') {
      parts.push(`setup failed: ${testReport.setup.commands.join(' && ')}`);
    } else {
      parts.push('setup skipped');
    }

    if (testReport.reason) {
      parts.push(`reason: ${testReport.reason}`);
    }

    const setupSnippet = compactOutput(testReport.setup.output);
    if (setupSnippet) {
      parts.push(`setup output: ${setupSnippet}`);
    }

    const testSnippet = compactOutput(testReport.output);
    if (testSnippet) {
      parts.push(`test output: ${testSnippet}`);
    }

    return parts.join(' | ');
  }

  getCheckpoint(): CheckpointType | null {
    return this.checkpoint;
  }

  async clearCheckpoint(checkpoint?: CheckpointType): Promise<void> {
    if (checkpoint && this.checkpoint !== checkpoint) {
      throw new Error(
        `Checkpoint mismatch: expected "${this.checkpoint}", got "${checkpoint}"`,
      );
    }
    const wasPreMerge = this.checkpoint === 'pre_merge';
    const wasPrePr = this.checkpoint === 'pre_pr';
    this.checkpoint = null;

    const plan = await loadPlan();
    if (plan && plan.status === 'paused') {
      if (wasPreMerge) {
        for (const job of plan.jobs) {
          if (job.status === 'ready_to_merge') {
            this.approvedForMerge.add(job.name);
          }
        }
      }

      await updatePlanFields(plan.id, {
        status: 'running',
        checkpoint: null,
        checkpointContext: null,
        ...(wasPreMerge
          ? { approvedMergeJobs: plan.jobs.filter((j) => j.status === 'ready_to_merge').map((j) => j.name) }
          : {}),
        ...(wasPrePr ? { approvedPrePr: true } : {}),
      });
      this.showToast('Mission Control', 'Checkpoint cleared, resuming execution.', 'info');

      if (!this.isRunning) {
        this.startReconciler();
      }
    }
  }

  async startPlan(spec: PlanSpec): Promise<{ pending: boolean; message?: string }> {
    this.validatePlan(spec);

    const existingPlan = await loadPlan();
    if (existingPlan) {
      throw new Error('Active plan already exists');
    }

    const ghAuthenticated = await validateGhAuth();
    const plan: PlanSpecWithAuth = {
      ...spec,
      status: 'pending',
      ghAuthenticated,
      jobs: topologicalSort(spec.jobs).map((job, idx) => ({
        ...job,
        status: job.dependsOn?.length ? 'waiting_deps' : 'queued',
        mergeOrder: job.mergeOrder ?? idx,
      })),
    };

    const integrationPostCreate = resolvePostCreateHook(this.config.worktreeSetup);
    const integration = spec.baseBranch
      ? await createIntegrationBranch(spec.id, integrationPostCreate, spec.baseBranch)
      : await createIntegrationBranch(spec.id, integrationPostCreate);
    plan.integrationBranch = integration.branch;
    plan.integrationWorktree = integration.worktreePath;

    if (spec.mode === 'copilot') {
      await savePlan(plan);
      this.showToast(
        'Mission Control',
        `Plan "${plan.name}" created in copilot mode. Awaiting approval.`,
        'info',
      );
      return {
        pending: true,
        message: 'Plan created in copilot mode. Review with mc_plan_status, then approve with mc_plan_approve.',
      };
    }

    await savePlan(plan);

    this.activePlanId = plan.id;
    this.planLaunchSessionID = spec.launchSessionID;
    this.mergeTrain = new MergeTrain(plan.integrationWorktree, this.getMergeTrainConfig());
    this.subscribeToMonitorEvents();
    this.startReconciler();
    this.showToast('Mission Control', `Plan "${plan.name}" started.`, 'info');
    this.notify(`📋 Plan "${plan.name}" started in autopilot mode. ${plan.jobs.length} jobs queued.`);
    return { pending: false };
  }

  private startReconciler(): void {
    if (this.isRunning || this.disposed) {
      return;
    }

    this.isRunning = true;
    // Bound to the project this orchestrator runs for: a timer tick must work
    // on this project's plan whatever async context it fires in.
    this.reconcilerInterval = setInterval(
      bindToDirectory(getProjectDirectory(), () => {
        this.reconcile().catch((error) => {
          console.error('Orchestrator reconcile error:', error);
        });
      }),
      5000,
    );

    this.reconcile().catch((error) => {
      console.error('Orchestrator initial reconcile error:', error);
    });
  }

  private stopReconciler(): void {
    if (this.reconcilerInterval) {
      clearInterval(this.reconcilerInterval);
      this.reconcilerInterval = null;
    }
    this.isRunning = false;
  }

  private async setCheckpoint(type: CheckpointType, plan: PlanSpec, context?: CheckpointContext): Promise<void> {
    this.checkpoint = type;
    await updatePlanFields(plan.id, {
      status: 'paused',
      checkpoint: type,
      checkpointContext: context ?? null,
    });
    this.stopReconciler();
    const detail = context
      ? ` Job "${context.jobName}": ${context.failureKind}${context.reason ? ` (${context.reason})` : ''}.`
      : '';
    if (this.attentionCallback?.(type, `Plan "${plan.name}" is paused at the ${type} checkpoint.${detail}`)) {
      return;
    }
    this.showToast(
      'Mission Control',
      `Supervisor checkpoint: ${type}. Approve to continue with mc_plan_approve.`,
      'warning',
    );
  }

  /**
   * Pause the plan on a job failure. The checkpoint is claimed synchronously,
   * so when a monitor event and a reconcile pass notice the same failure only
   * one of them pauses the plan and notifies.
   */
  private async pauseForFailure(
    plan: PlanSpec,
    context: CheckpointContext,
    toast: string,
    notification: string,
  ): Promise<void> {
    if (this.checkpoint || this.disposed) {
      return;
    }
    this.checkpoint = 'on_error';
    try {
      await this.setCheckpoint('on_error', plan, context);
    } catch (error) {
      // The pause was not recorded (the plan is gone, or the write failed).
      // Release the claim so the next reconcile pass tries again.
      this.checkpoint = null;
      throw error;
    }
    this.showToast('Mission Control', toast, 'error');
    this.notify(notification);
  }

  private isSupervisor(plan: PlanSpec): boolean {
    return plan.mode === 'supervisor';
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.isReconciling) {
      this.reconcilePending = true;
      return;
    }

    this.isReconciling = true;
    const pass = (async () => {
      try {
        do {
          this.reconcilePending = false;
          await this._doReconcile();
        } while (this.reconcilePending && !this.disposed);
      } finally {
        this.isReconciling = false;
      }
    })();
    // dispose() only waits for the pass to end; its failure is reported to
    // this method's caller through `await pass` below.
    const settled = pass.then(
      () => undefined,
      () => undefined,
    );
    this.reconcileInFlight = settled;
    try {
      await pass;
    } finally {
      if (this.reconcileInFlight === settled) {
        this.reconcileInFlight = null;
      }
    }
  }

  private async _doReconcile(): Promise<void> {
      if (this.disposed) {
        return;
      }

      const plan = await loadPlan();

      if (!plan || isTerminalPlanStatus(plan.status)) {
        this.stopReconciler();
        this.unsubscribeFromMonitorEvents();
        return;
      }

      if (plan.checkpoint && plan.status !== 'paused') {
        // A checkpoint with a non-paused status cannot be approved. Restore the
        // pause so mc_plan_approve can clear it.
        this.checkpoint = plan.checkpoint;
        await updatePlanFields(plan.id, { status: 'paused' });
        this.stopReconciler();
        return;
      }

      if (plan.status === 'paused' || this.checkpoint) {
        return;
      }

      this.activePlanId = plan.id;

      if (plan.status === 'pending') {
        plan.status = 'running';
      }

      const maxParallel = this.config.maxParallel ?? 3;
      const runningJobs = (await getRunningJobs()).filter((job) => job.planId === plan.id);
      let runningCount = runningJobs.length;

      // Safety net: detect plan jobs stuck as 'running' when jobs.json already
      // shows them as completed/failed (can happen if a prior savePlan race
      // overwrote their status, or if the 'complete' event was missed).
      const jobState = await loadJobState();
      const runningJobNames = new Set(runningJobs.map((j) => j.name));
      for (const planJob of plan.jobs) {
        if (planJob.status !== 'running') continue;
        if (runningJobNames.has(planJob.name)) continue;

        const stateJob = jobState.jobs.find(
          (j) => j.name === planJob.name && j.planId === plan.id,
        );

        if (!stateJob) continue;

        if (stateJob.status === 'completed') {
          await updatePlanJob(plan.id, planJob.name, { status: 'completed' });
          planJob.status = 'completed';
        } else if (stateJob.status === 'failed' || stateJob.status === 'stopped') {
          const error =
            stateJob.status === 'stopped'
              ? 'the job was stopped'
              : stateJob.failureReason ?? 'the job failed';
          await updatePlanJob(plan.id, planJob.name, { status: 'failed', error });
          planJob.status = 'failed';
          planJob.error = error;
        }
      }

      // A failed job that no checkpoint covers would stall the plan forever:
      // nothing merges it, and everything that depends on it waits. Pause and
      // tell the user instead.
      const unhandledFailure = plan.jobs.find((job) => job.status === 'failed');
      if (unhandledFailure) {
        const reason = unhandledFailure.error ?? 'the job failed';
        await this.pauseForFailure(
          plan,
          { jobName: unhandledFailure.name, failureKind: 'job_failed', reason },
          `Job "${unhandledFailure.name}" failed. Plan paused.`,
          `❌ Job "${unhandledFailure.name}" failed: ${reason}.\n` +
            `Fix its branch and retry with mc_plan_approve(checkpoint: "on_error", retry: "${unhandledFailure.name}"), or cancel the plan with mc_plan_cancel.`,
        );
        return;
      }

      const mergeOrder = [...plan.jobs].sort(
        (a, b) => (a.mergeOrder ?? Number.MAX_SAFE_INTEGER) - (b.mergeOrder ?? Number.MAX_SAFE_INTEGER),
      );
      const byName = new Map(plan.jobs.map((job) => [job.name, job]));

      const launched: string[] = [];
      let launchFailure: { job: JobSpec; error: string } | undefined;
      for (const job of mergeOrder) {
        if (job.status !== 'queued' && job.status !== 'waiting_deps') {
          continue;
        }

        const depsSatisfied = (job.dependsOn ?? []).every(
          (depName) => byName.get(depName)?.status === 'merged',
        );

        if (!depsSatisfied) {
          if (job.status !== 'waiting_deps') {
            await updatePlanJob(plan.id, job.name, { status: 'waiting_deps' });
            job.status = 'waiting_deps';
          }
          continue;
        }

        if (runningCount >= maxParallel) {
          continue;
        }

        if (this.disposed) {
          return;
        }

        const error = await this.launchJob(job, plan);
        if (error) {
          job.status = 'failed';
          job.error = error;
          launchFailure = { job, error };
          // The plan is about to pause; do not start more work.
          break;
        }

        runningCount += 1;
        launched.push(job.name);
        job.status = 'running';
      }

      if (launched.length > 0) {
        this.jobsLaunchedCount += launched.length;
        this.showToast(
          'Mission Control',
          `Launched ${launched.length} job(s) (${this.jobsLaunchedCount} total).`,
          'info',
        );
        this.notify(`🚀 Launched ${launched.length} job(s): ${launched.join(', ')}. (${this.jobsLaunchedCount}/${mergeOrder.length} total launched)`);
      }

      if (launchFailure) {
        const { job, error } = launchFailure;
        await this.pauseForFailure(
          plan,
          { jobName: job.name, failureKind: 'launch_failed', reason: error },
          `Job "${job.name}" could not be launched. Plan paused.`,
          `❌ Job "${job.name}" could not be launched: ${error}\n` +
            `Fix the cause and launch it again with mc_plan_approve(checkpoint: "on_error", retry: "${job.name}"), or cancel the plan with mc_plan_cancel.`,
        );
        return;
      }

      if (this.disposed) {
        return;
      }

      for (const job of mergeOrder) {
        if (job.status === 'completed') {
          // The monitor flags a job that finished with changes it never
          // committed. Merging its branch would silently leave them out.
          const stateJob = jobState.jobs.find(
            (candidate) => candidate.name === job.name && candidate.planId === plan.id,
          );
          const uncommitted = stateJob?.uncommittedChanges ?? [];
          if (uncommitted.length > 0) {
            const reason = `uncommitted changes in its worktree: ${summarizeFiles(uncommitted)}`;
            await updatePlanJob(plan.id, job.name, { status: 'failed', error: reason });
            job.status = 'failed';
            await this.pauseForFailure(
              plan,
              { jobName: job.name, failureKind: 'uncommitted_changes', reason },
              `Job "${job.name}" finished with uncommitted changes. Plan paused.`,
              `❌ Job "${job.name}" finished with uncommitted changes in ${stateJob?.worktreePath ?? 'its worktree'}:\n` +
                `  ${summarizeFiles(uncommitted)}\n` +
                `They are not on its branch, so merging now would leave them out.\n\n` +
                `Options:\n` +
                `  Commit them in the worktree, then: mc_plan_approve(checkpoint: "on_error", retry: "${job.name}")\n` +
                `  Merge the branch without them:    mc_plan_approve(checkpoint: "on_error")`,
            );
            return;
          }

          if (job.touchSet && job.touchSet.length > 0 && job.branch && plan.integrationBranch) {
            const validation = await validateTouchSet(job.branch, plan.integrationBranch, job.touchSet);
            if (!validation.valid && validation.violations) {
              await updatePlanJob(plan.id, job.name, {
                status: 'failed',
                error: `Modified files outside touchSet: ${validation.violations.join(', ')}. Expected only: ${job.touchSet.join(', ')}`,
              });
              job.status = 'failed';

              await this.pauseForFailure(
                plan,
                {
                  jobName: job.name,
                  failureKind: 'touchset',
                  touchSetViolations: validation.violations,
                  touchSetPatterns: job.touchSet,
                },
                `Job "${job.name}" touched files outside its touchSet. Plan paused.`,
                `❌ Job "${job.name}" modified files outside its touchSet:\n` +
                `  Violations: ${validation.violations.join(', ')}\n` +
                `  Allowed: ${job.touchSet.join(', ')}\n\n` +
                `Options:\n` +
                `  Accept violations:  mc_plan_approve(checkpoint: "on_error")\n` +
                `  Agent fixes branch: mc_plan_approve(checkpoint: "on_error", relaunch: "${job.name}")\n` +
                `  You fix, re-check:  mc_plan_approve(checkpoint: "on_error", retry: "${job.name}")`,
              );
              return;
            }
          }

          await updatePlanJob(plan.id, job.name, { status: 'ready_to_merge' });
          job.status = 'ready_to_merge';
        }
      }

      for (const job of mergeOrder) {
        if (job.status !== 'ready_to_merge') {
          continue;
        }

        const earlierJobs = mergeOrder.filter(
          (candidate) => (candidate.mergeOrder ?? 0) < (job.mergeOrder ?? 0),
        );
        const canMergeNow = earlierJobs.every((candidate) => {
          const current = byName.get(candidate.name);
          return current?.status === 'merged';
        });
        if (!canMergeNow) {
          continue;
        }

        if (this.disposed) {
          return;
        }

        if (job.branch && plan.integrationWorktree) {
          const mergeCheck = await checkMergeability(plan.integrationWorktree, job.branch);
          if (!mergeCheck.canMerge) {
            await updatePlanJob(plan.id, job.name, {
              status: 'needs_rebase',
              error: mergeCheck.conflicts?.join(', ') ?? 'merge conflict detected in trial merge',
            });
            job.status = 'needs_rebase';

            await this.pauseForFailure(
              plan,
              { jobName: job.name, failureKind: 'merge_conflict' },
              `Job "${job.name}" has merge conflicts. Plan paused.`,
              `❌ Job "${job.name}" would conflict with the integration branch.\n  Files: ${mergeCheck.conflicts?.join(', ') ?? 'unknown'}\nRebase the job branch and retry with mc_plan_approve(checkpoint: "on_error", retry: "${job.name}").`,
            );
            return;
          }
        }

        const persistedMergeApproval = plan.approvedMergeJobs ?? [];
        const approvedForMerge =
          this.approvedForMerge.has(job.name) ||
          persistedMergeApproval.includes(job.name);

        if (this.isSupervisor(plan) && !approvedForMerge) {
          await this.setCheckpoint('pre_merge', plan);
          return;
        }

        if (persistedMergeApproval.includes(job.name)) {
          // Consume the persisted approval so a later retry does not silently
          // bypass the supervisor checkpoint again.
          await updatePlanFields(plan.id, {
            approvedMergeJobs: persistedMergeApproval.filter((name) => name !== job.name),
          });
        }

        if (this.disposed) {
          return;
        }

        this.mergeTrain ??= new MergeTrain(plan.integrationWorktree!, this.getMergeTrainConfig());
        this.mergeTrain.enqueue(job);
        await updatePlanJob(plan.id, job.name, { status: 'merging' });
        job.status = 'merging';
        this.approvedForMerge.delete(job.name);
      }

      if (this.mergeTrain && this.mergeTrain.getQueue().length > 0 && !this.disposed) {
        plan.status = 'merging';

        const nextJob = this.mergeTrain.getQueue()[0];
        this.showToast('Mission Control', `Merging job "${nextJob.name}"...`, 'info');
        this.notify(`⇄ Merging job "${nextJob.name}" into integration branch...`);
        const mergeResult = await this.mergeTrain.processNext();

        if (this.disposed) {
          // A successor owns the plan now. The job is still `merging` in
          // plan.json, which makes the successor redo this merge from scratch.
          return;
        }

        const mergedCount = mergeOrder.filter(j => j.status === 'merged').length;

        if (mergeResult.success) {
          await updatePlanJob(plan.id, nextJob.name, {
            status: 'merged',
            mergedAt: mergeResult.mergedAt,
          });
          const current = byName.get(nextJob.name);
          if (current) {
            current.status = 'merged';
            current.mergedAt = mergeResult.mergedAt;
          }
          this.showToast('Mission Control', `Job "${nextJob.name}" merged successfully.`, 'success');
          this.notify(`✅ Job "${nextJob.name}" merged successfully. (${mergedCount + 1}/${mergeOrder.length} merged)`);
          const testSummary = this.formatTestReportSummary(mergeResult.testReport);
          if (testSummary) {
            this.notify(`🧪 ${nextJob.name}: ${testSummary}`);
          }
        } else if (mergeResult.type === 'conflict') {
          await updatePlanJob(plan.id, nextJob.name, {
            status: 'conflict',
            error: mergeResult.files?.join(', ') ?? 'merge conflict',
          });

          await this.pauseForFailure(
            plan,
            { jobName: nextJob.name, failureKind: 'merge_conflict' },
            `Merge conflict in job "${nextJob.name}". Plan paused.`,
            `❌ Merge conflict in job "${nextJob.name}". Files: ${mergeResult.files?.join(', ') ?? 'unknown'}. Fix the branch and retry with mc_plan_approve(checkpoint: "on_error", retry: "${nextJob.name}").`,
          );
          return;
        } else {
          await updatePlanJob(plan.id, nextJob.name, {
            status: 'failed',
            error: mergeResult.output ?? 'merge train test failure',
          });

          const testSummary = this.formatTestReportSummary(mergeResult.testReport);
          if (testSummary) {
            this.notify(`🧪 ${nextJob.name}: ${testSummary}`);
          }

          await this.pauseForFailure(
            plan,
            { jobName: nextJob.name, failureKind: 'test_failure' },
            `Job "${nextJob.name}" failed merge tests. Plan paused.`,
            `❌ Job "${nextJob.name}" failed merge tests. Fix the branch and retry with mc_plan_approve(checkpoint: "on_error", retry: "${nextJob.name}").`,
          );
          return;
        }
      }

      if (plan.status === 'merging' && (!this.mergeTrain || this.mergeTrain.getQueue().length === 0)) {
        plan.status = 'running';
      }

      const latestPlan = await loadPlan();
      if (!latestPlan || this.disposed) {
        return;
      }

      // A failure handler may have paused the plan while this pass was
      // launching or merging. Never write a status back over a pause or a
      // checkpoint: the plan could then no longer be approved.
      if (latestPlan.status === 'paused' || latestPlan.checkpoint || this.checkpoint) {
        return;
      }

      const allMerged = latestPlan.jobs.length > 0 && latestPlan.jobs.every((job) => job.status === 'merged');
      // Guard: don't re-enter PR creation if already in progress or terminal
      if (allMerged && latestPlan.status !== 'creating_pr' && latestPlan.status !== 'completed' && latestPlan.status !== 'failed') {
        if (this.isSupervisor(latestPlan) && !latestPlan.approvedPrePr) {
          this.showToast('Mission Control', 'All jobs merged. Waiting for approval to create the PR.', 'info');
          await this.setCheckpoint('pre_pr', latestPlan);
          return;
        }

        this.showToast('Mission Control', 'All jobs merged. Creating PR...', 'info');
        this.notify(`🎯 All ${latestPlan.jobs.length} jobs merged. Creating PR...`);

        await updatePlanFields(latestPlan.id, {
          status: 'creating_pr',
          ...(this.isSupervisor(latestPlan) ? { approvedPrePr: false } : {}),
        });

        try {
          const prUrl = await this.createPR();
          const completedAt = new Date().toISOString();
          await updatePlanFields(latestPlan.id, {
            status: 'completed',
            prUrl,
            completedAt,
          });
          this.stopReconciler();
          this.unsubscribeFromMonitorEvents();
          this.showToast('Mission Control', `Plan completed! PR: ${prUrl}`, 'success');
          this.notify(`🎉 Plan "${latestPlan.name}" completed! PR created: ${prUrl}`);
        } catch (prError) {
          const completedAt = new Date().toISOString();
          const errMsg = prError instanceof Error ? prError.message : String(prError);
          await updatePlanFields(latestPlan.id, {
            status: 'failed',
            completedAt,
            failureReason: `PR creation failed: ${errMsg}`,
          });
          this.stopReconciler();
          this.unsubscribeFromMonitorEvents();
          this.showToast('Mission Control', `PR creation failed: ${errMsg}`, 'error');
          this.notify(`❌ Plan "${latestPlan.name}" failed: ${errMsg}`);
        }
        return;
      }

      if (latestPlan.status !== plan.status) {
        await updatePlanFields(latestPlan.id, { status: plan.status });
      }
  }

  /**
   * Launch a plan job. Returns the reason when the launch failed (the plan job
   * is then recorded as `failed`), or null when the job is running.
   */
  private async launchJob(job: JobSpec, plan: PlanSpec): Promise<string | null> {
    const planId = plan.id;
    const branch = job.branch ?? `mc/plan/${planId.slice(0, 8)}/${job.name}`;

    try {
      await updatePlanJob(planId, job.name, { status: 'running', branch });

      // Plan jobs branch from a deterministic start point:
      // - Jobs WITH dependencies → integration branch HEAD (sees upstream changes)
      // - Root jobs (no deps) → baseCommit (consistent starting state)
      const hasDeps = job.dependsOn && job.dependsOn.length > 0;
      const startPoint = hasDeps ? plan.integrationBranch : plan.baseCommit;

      // Same launch path as mc_launch: worktree, session, job record. It
      // removes the worktree and session again if any step fails.
      const launched = await launchSharedJob({
        name: job.name,
        prompt: job.prompt,
        branch,
        startPoint,
        agent: job.agent,
        model: job.model ?? plan.model ?? this.planModelSnapshot,
        copyFiles: job.copyFiles,
        symlinkDirs: job.symlinkDirs,
        commands: job.commands,
        planId,
        launchSessionID: this.planLaunchSessionID,
        config: this.config,
        // A retried plan job is launched again under its original name.
        replaceFinished: true,
      });

      await updatePlanJob(planId, job.name, {
        status: 'running',
        branch,
        worktreePath: launched.worktreePath,
      });
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await updatePlanJob(planId, job.name, { status: 'failed', error: message });
      } catch (updateError) {
        // The plan is gone (canceled while this job was launching).
        console.warn(`[Orchestrator] Could not record the failed launch of job "${job.name}":`, updateError);
      }
      return message;
    }
  }

  async relaunchJobForCorrection(
    jobName: string,
    violations: string[],
    touchSetPatterns: string[],
  ): Promise<void> {
    const plan = await loadPlan();
    if (!plan) {
      throw new Error('No active plan');
    }

    const job = plan.jobs.find((j) => j.name === jobName);
    if (!job) {
      throw new Error(`Job "${jobName}" not found in plan`);
    }
    if (!job.worktreePath || !job.branch) {
      throw new Error(`Job "${jobName}" has no worktree or branch — cannot relaunch`);
    }

    // Stop the job's previous run if it is somehow still going, so the
    // correction does not race it in the same worktree.
    const previousRuns = (await loadJobState()).jobs.filter(
      (j) => j.name === job.name && j.planId === plan.id && j.status === 'running',
    );
    for (const previous of previousRuns) {
      await updateJob(previous.id, {
        status: 'stopped',
        completedAt: new Date().toISOString(),
      });
      if (previous.sessionID) {
        await stopJobSession(previous.sessionID).catch((error: unknown) => {
          console.warn(`[Orchestrator] Failed to stop the previous run of job "${jobName}":`, error);
        });
      }
    }

    // Build correction prompt with context from the original task
    const correctionPrompt =
      `CORRECTION TASK — TouchSet Violation\n\n` +
      `The previous task in this worktree was:\n"${job.prompt}"\n\n` +
      `It completed successfully but modified files outside the allowed scope.\n\n` +
      `Violations (files you must revert):\n${violations.map((v) => `  - ${v}`).join('\n')}\n\n` +
      `Allowed patterns (files you may keep):\n${touchSetPatterns.map((p) => `  - ${p}`).join('\n')}\n\n` +
      `Instructions:\n` +
      `1. Review the changes on this branch (git log, git diff)\n` +
      `2. Revert ONLY the violating files listed above — do NOT break the intended work\n` +
      `3. If a violating file is genuinely required, explain why in your commit message\n` +
      `4. Commit your corrections and report completion`;

    try {
      // Relaunch in the job's existing worktree, on its existing branch. The
      // stale job entry (and its report) is replaced by a fresh one.
      await launchSharedJob({
        name: job.name,
        prompt: correctionPrompt,
        branch: job.branch,
        worktreePath: job.worktreePath,
        agent: job.agent,
        model: job.model ?? plan.model ?? this.planModelSnapshot,
        planId: plan.id,
        launchSessionID: this.planLaunchSessionID,
        config: this.config,
        replaceFinished: true,
      });

      await updatePlanJob(plan.id, job.name, {
        status: 'running',
        error: undefined,
      });
    } catch (error) {
      throw new Error(
        `Failed to relaunch job "${jobName}" for correction: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private handleJobComplete = (job: Job): void => {
    if (this.disposed || !job.planId || !this.activePlanId || job.planId !== this.activePlanId) {
      return;
    }

    if (!this.firstJobCompleted) {
      this.firstJobCompleted = true;
      this.showToast('Mission Control', `First job completed: "${job.name}".`, 'success');
    }

    const planId = job.planId;
    (async () => {
      await updatePlanJob(planId, job.name, {
        status: 'completed',
      });
      await this.reconcile();
    })().catch((error) => {
      console.error('Failed to reconcile completed job state:', error);
    });
  }

  private handleJobFailed = (job: Job): void => {
    if (this.disposed || !job.planId || !this.activePlanId || job.planId !== this.activePlanId) {
      return;
    }

    const planId = job.planId;
    const reason = job.failureReason ?? 'job monitor reported failure';
    (async () => {
      await updatePlanJob(planId, job.name, { status: 'failed', error: reason });

      const plan = await loadPlan();
      if (!plan || plan.id !== planId) {
        return;
      }

      await this.pauseForFailure(
        plan,
        { jobName: job.name, failureKind: 'job_failed', reason },
        `Job "${job.name}" failed. Plan paused.`,
        `❌ Job "${job.name}" failed: ${reason}. Fix and retry with mc_plan_approve(checkpoint: "on_error", retry: "${job.name}").`,
      );
    })().catch((error) => {
      // The failed job stays `failed` in plan.json (or is found by the
      // reconcile safety net), so the next reconcile pass pauses the plan.
      console.error(`[Orchestrator] Failed to pause the plan after job "${job.name}" failed:`, error);
    });
  }

  async cancelPlan(): Promise<void> {
    this.stopReconciler();

    const plan = await loadPlan();
    if (!plan) {
      return;
    }

    // Unsubscribe from monitor events BEFORE killing jobs to prevent
    // completion/failure handlers from racing with plan cleanup.
    this.unsubscribeFromMonitorEvents();
    this.activePlanId = null;

    // Mark the plan canceled before stopping anything: a reconcile tick that
    // sees running jobs disappear would otherwise launch the queued ones.
    if (!isTerminalPlanStatus(plan.status)) {
      await updatePlanFields(plan.id, { status: 'canceled' });
    }

    const runningJobs = (await getRunningJobs()).filter((job) => job.planId === plan.id);
    for (const job of runningJobs) {
      try {
        // Mark the job stopped before interrupting it, so the monitor does not
        // record the interruption as a failure of a running job.
        await updateJob(job.id, {
          status: 'stopped',
          completedAt: new Date().toISOString(),
        });
        if (job.sessionID) {
          await stopJobSession(job.sessionID);
        }
      } catch (error) {
        console.warn(`[Orchestrator] Failed to stop job "${job.name}" while canceling the plan:`, error);
      }
    }

    const state = await loadJobState();
    const planJobs = state.jobs.filter((job) => job.planId === plan.id);
    for (const job of planJobs) {
      if (job.sessionID) {
        // The worktree is about to be deleted; a session left pointing at it
        // would be unusable.
        await removeJobSession(job.sessionID).catch((error: unknown) => {
          console.warn(`[Orchestrator] Failed to remove the session of job "${job.name}" while canceling the plan:`, error);
        });
      }
      if (job.worktreePath) {
        await removeWorktree(job.worktreePath, true).catch((error: unknown) => {
          // Usually already gone; mc_cleanup removes anything left behind.
          console.warn(`[Orchestrator] Could not remove the worktree of job "${job.name}" while canceling the plan:`, error);
        });
      }
      if (job.branch) {
        const deleted = await gitCommand(['branch', '-D', job.branch]);
        if (deleted.exitCode !== 0 && !deleted.stderr.includes('not found')) {
          console.warn(`[Orchestrator] Could not delete branch ${job.branch} while canceling the plan: ${deleted.stderr}`);
        }
      }
    }
    await deleteIntegrationBranch(plan.id);
    await clearPlan();
  }

  async resumePlan(): Promise<void> {
    let plan = await loadPlan();
    if (!plan || isTerminalPlanStatus(plan.status)) {
      return;
    }

    if (plan.status === 'pending' && plan.mode === 'copilot') {
      // Waiting for mc_plan_approve; nothing has started yet.
      return;
    }

    if (plan.checkpoint && plan.status !== 'paused') {
      // A checkpoint with a non-paused status cannot be approved. Restore the
      // pause so mc_plan_approve can clear it.
      await updatePlanFields(plan.id, { status: 'paused' });
      plan = { ...plan, status: 'paused' };
    }

    if (plan.status === 'paused') {
      // A plan waiting at a checkpoint stays there across reloads and restarts.
      // Only mc_plan_approve may clear a checkpoint; it marks the plan running
      // before it resumes it.
      this.checkpoint = plan.checkpoint ?? null;
      this.activePlanId = plan.id;
      this.planLaunchSessionID = plan.launchSessionID;
      return;
    }
    this.checkpoint = null;

    if (plan.status !== 'running') {
      // `pending` (started but not reconciled yet), `merging` and
      // `creating_pr` were cut off by a restart. The reconciler redoes the
      // interrupted step from the job statuses.
      await updatePlanFields(plan.id, { status: 'running' });
    }

    this.activePlanId = plan.id;
    this.planLaunchSessionID = plan.launchSessionID;
    this.mergeTrain = new MergeTrain(plan.integrationWorktree!, this.getMergeTrainConfig());

    // The merge queue lives in memory. A job left in `merging` was cut off by
    // the restart and would otherwise wait forever: undo its partial merge and
    // hand it back to the reconciler, which merges and tests it again.
    for (const job of plan.jobs) {
      if (job.status === 'merging') {
        await this.recoverInterruptedMerge(plan.id, plan.integrationWorktree!, job.name);
      }
    }

    const runningJobs = (await getRunningJobs()).filter((job) => job.planId === plan.id);

    // Jobs with a session are picked up by the monitor, which reconciles them
    // against the session's outcome. A running job without a session has
    // nothing behind it and can never finish: fail it, and let the reconciler
    // pause the plan on the failed job.
    for (const runningJob of runningJobs) {
      if (runningJob.sessionID) {
        continue;
      }

      const reason = 'the job has no session to resume after a restart';
      await updateJob(runningJob.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        failureReason: reason,
      });
      await updatePlanJob(plan.id, runningJob.name, {
        status: 'failed',
        error: reason,
      });
    }

    if (this.disposed) {
      return;
    }

    this.subscribeToMonitorEvents();
    this.startReconciler();
  }

  private async recoverInterruptedMerge(planId: string, worktree: string, jobName: string): Promise<void> {
    // No-op when no merge is in progress; the exit code is not an error here.
    await gitCommand(['-C', worktree, 'merge', '--abort']);

    // The merge commit may already exist with its tests unfinished. Drop it so
    // the job is merged and tested from scratch.
    const head = await gitCommand(['-C', worktree, 'log', '-1', '--format=%s']);
    const target = head.exitCode === 0 && head.stdout === `Merge ${jobName}` ? 'HEAD~1' : 'HEAD';
    const reset = await gitCommand(['-C', worktree, 'reset', '--hard', target]);
    if (reset.exitCode !== 0) {
      console.warn(`[Mission Control] Could not reset the integration worktree for job ${jobName}: ${reset.stderr}`);
    }
    await gitCommand(['-C', worktree, 'clean', '-fd']);

    await updatePlanJob(planId, jobName, { status: 'ready_to_merge' });
  }

  private async createPR(): Promise<string> {
    const plan = await loadPlan();
    if (!plan) {
      throw new Error('No active plan found');
    }

    const pushResult = await this.runCommand(['git', 'push', 'origin', plan.integrationBranch]);
    if (pushResult.exitCode !== 0) {
      throw new Error(`Failed to push integration branch: ${pushResult.stderr || pushResult.stdout}`);
    }

    const baseBranch = plan.baseBranch ?? await getDefaultBranch();
    const title = plan.name;
    const jobLines = plan.jobs.map((j) => {
      const status = j.status === 'merged' ? '✅' : j.status === 'failed' ? '❌' : '⏳';
      const mergedAt = j.mergedAt ? new Date(j.mergedAt).toISOString().slice(0, 19).replace('T', ' ') : '—';
      return `| ${j.name} | ${status} ${j.status} | ${mergedAt} |`;
    }).join('\n');

    const mergeTrainConfig = this.getMergeTrainConfig();
    const testingLines: string[] = [];
    if (mergeTrainConfig.testCommand) {
      testingLines.push(`- [x] \`${mergeTrainConfig.testCommand}\` passed after each merge`);
    }
    if (mergeTrainConfig.setupCommands?.length) {
      testingLines.push(`- [x] Setup: \`${mergeTrainConfig.setupCommands.join(' && ')}\``);
    }
    if (testingLines.length === 0) {
      testingLines.push('- No test command configured');
    }

    const summary = `Orchestrated plan **${plan.name}** with ${plan.jobs.length} job(s).`;
    const jobsTable = ['| Job | Status | Merged At |', '|-----|--------|-----------|', jobLines].join('\n');
    const notes = [
      `- Integration branch: \`${plan.integrationBranch}\``,
      `- Base commit: \`${plan.baseCommit.slice(0, 8)}\``,
      `- Mode: ${plan.mode}`,
    ].join('\n');
    const attribution = '🚀 *Automated PR from [Mission Control](https://github.com/nigel-dev/opencode-mission-control)*';

    // Use the repository's PR template when it has one, filled with the plan's data.
    const template = plan.integrationWorktree ? await loadPrTemplate(plan.integrationWorktree) : null;
    const filled = template
      ? fillPrTemplate(template, {
          Summary: summary,
          Changes: jobsTable,
          Testing: testingLines.join('\n'),
          Notes: notes,
        })
      : [
          '## Summary', '', summary, '',
          '## Jobs', '', jobsTable, '',
          '## Testing', '', ...testingLines, '',
          '## Notes', '', notes,
        ].join('\n');
    const body = `${filled}\n\n---\n\n${attribution}`;
    const prResult = await this.runCommand([
      'gh',
      'pr',
      'create',
      '--head',
      plan.integrationBranch,
      '--base',
      baseBranch,
      '--title',
      title,
      '--body',
      body,
    ]);

    if (prResult.exitCode !== 0) {
      const output = prResult.stderr || prResult.stdout;
      if (/already exists/i.test(output)) {
        // A restart can interrupt the plan after the PR was opened but before
        // its URL was recorded. Use the PR that is already there.
        const existing = await this.runCommand([
          'gh', 'pr', 'view', plan.integrationBranch, '--json', 'url', '--jq', '.url',
        ]);
        if (existing.exitCode === 0 && existing.stdout) {
          return existing.stdout;
        }
      }
      throw new Error(`Failed to create PR: ${output}`);
    }

    return prResult.stdout.trim();
  }

  private async runCommand(
    command: string[],
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(command, {
      cwd: cwd ?? getProjectDirectory(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  }

  private validatePlan(spec: PlanSpec): void {
    const names = spec.jobs.map((job) => job.name);
    if (new Set(names).size !== names.length) {
      throw new Error('Job names must be unique');
    }

    const nameSet = new Set(names);
    for (const job of spec.jobs) {
      for (const dep of job.dependsOn ?? []) {
        if (!nameSet.has(dep)) {
          throw new Error(`Job "${job.name}" depends on unknown job "${dep}"`);
        }
      }
    }

    if (hasCircularDependency(spec.jobs)) {
      throw new Error('Plan contains circular dependencies');
    }
  }

  private subscribeToMonitorEvents(): void {
    if (this.subscriptionsActive || this.disposed) {
      return;
    }

    this.monitor.on('complete', this.handleJobComplete);
    this.monitor.on('failed', this.handleJobFailed);
    this.subscriptionsActive = true;
  }

  private unsubscribeFromMonitorEvents(): void {
    if (!this.subscriptionsActive) {
      return;
    }

    this.monitor.off('complete', this.handleJobComplete);
    this.monitor.off('failed', this.handleJobFailed);
    this.subscriptionsActive = false;
  }
}
