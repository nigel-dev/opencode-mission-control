import { randomUUID } from 'crypto';
import type { MCConfig } from './config';
import type { PlanSpec, JobSpec, PlanStatus, CheckpointType } from './plan-types';
import { loadPlan, savePlan, updatePlanJob, clearPlan, validateGhAuth } from './plan-state';
import { createIntegrationBranch, deleteIntegrationBranch } from './integration';
import { MergeTrain } from './merge-train';
import { addJob, getRunningJobs, updateJob, type Job } from './job-state';
import { JobMonitor } from './monitor';
import { createWorktree, removeWorktree } from './worktree';
import { resolvePostCreateHook } from './worktree-setup';
import { writePromptFile, cleanupPromptFile, buildPromptFileCommand } from './prompt-file';
import {
  createSession,
  createWindow,
  getCurrentSession,
  isInsideTmux,
  isPaneRunning,
  killSession,
  killWindow,
  sendKeys,
  setPaneDiedHook,
} from './tmux';

type PlanSpecWithAuth = PlanSpec & { ghAuthenticated?: boolean };

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';
export type ToastCallback = (
  title: string,
  message: string,
  variant: ToastVariant,
  duration: number,
) => void;

const TERMINAL_PLAN_STATUSES: PlanStatus[] = ['completed', 'failed', 'canceled'];

function isTerminalPlanStatus(status: PlanStatus): boolean {
  return TERMINAL_PLAN_STATUSES.includes(status);
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
  private activePlanId: string | null = null;
  private planPlacement: 'session' | 'window' | null = null;
  private subscriptionsActive = false;
  private checkpoint: CheckpointType | null = null;
  private toastCallback: ToastCallback | null = null;
  private jobsLaunchedCount = 0;
  private firstJobCompleted = false;

  private getMergeTrainConfig(): { testCommand?: string; testTimeout?: number } {
    const config = this.config as MCConfig & {
      testCommand?: string;
      testTimeout?: number;
    };
    return {
      testCommand: config.testCommand,
      testTimeout: config.testTimeout,
    };
  }

  constructor(monitor: JobMonitor, config: MCConfig, toastCallback?: ToastCallback) {
    this.monitor = monitor;
    this.config = config;
    this.toastCallback = toastCallback ?? null;
    this.handleJobComplete = this.handleJobComplete.bind(this);
    this.handleJobFailed = this.handleJobFailed.bind(this);
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

  getCheckpoint(): CheckpointType | null {
    return this.checkpoint;
  }

  async clearCheckpoint(checkpoint?: CheckpointType): Promise<void> {
    if (checkpoint && this.checkpoint !== checkpoint) {
      throw new Error(
        `Checkpoint mismatch: expected "${this.checkpoint}", got "${checkpoint}"`,
      );
    }
    this.checkpoint = null;

    const plan = await loadPlan();
    if (plan && plan.status === 'paused') {
      plan.status = 'running';
      plan.checkpoint = null;
      await savePlan(plan);
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

    const integration = await createIntegrationBranch(spec.id);
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
    this.planPlacement = spec.placement ?? null;
    this.mergeTrain = new MergeTrain(plan.integrationWorktree, this.getMergeTrainConfig());
    this.subscribeToMonitorEvents();
    this.startReconciler();
    this.showToast('Mission Control', `Plan "${plan.name}" started.`, 'info');
    return { pending: false };
  }

  private startReconciler(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.reconcilerInterval = setInterval(() => {
      this.reconcile().catch((error) => {
        console.error('Orchestrator reconcile error:', error);
      });
    }, 5000);

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

  private async setCheckpoint(type: CheckpointType, plan: PlanSpec): Promise<void> {
    this.checkpoint = type;
    plan.status = 'paused';
    plan.checkpoint = type;
    await savePlan(plan);
    this.stopReconciler();
    this.showToast(
      'Mission Control',
      `Supervisor checkpoint: ${type}. Approve to continue with mc_plan_approve.`,
      'warning',
    );
  }

  private isSupervisor(plan: PlanSpec): boolean {
    return plan.mode === 'supervisor';
  }

  private async reconcile(): Promise<void> {
    if (this.isReconciling) {
      return;
    }

    this.isReconciling = true;
    try {
      const plan = await loadPlan();

      if (!plan || isTerminalPlanStatus(plan.status)) {
        this.stopReconciler();
        this.unsubscribeFromMonitorEvents();
        return;
      }

      if (plan.status === 'paused' || this.checkpoint) {
        return;
      }

      this.activePlanId = plan.id;

      if (plan.status === 'pending') {
        plan.status = 'running';
      }

      const maxParallel = (this.config as MCConfig & { maxParallel?: number }).maxParallel ?? 3;
      const runningJobs = (await getRunningJobs()).filter((job) => job.planId === plan.id);
      let runningCount = runningJobs.length;

      const mergeOrder = [...plan.jobs].sort(
        (a, b) => (a.mergeOrder ?? Number.MAX_SAFE_INTEGER) - (b.mergeOrder ?? Number.MAX_SAFE_INTEGER),
      );
      const byName = new Map(plan.jobs.map((job) => [job.name, job]));

      let launchedThisCycle = 0;
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

        await this.launchJob(job);
        runningCount += 1;
        launchedThisCycle += 1;
        job.status = 'running';
      }

      if (launchedThisCycle > 0) {
        this.jobsLaunchedCount += launchedThisCycle;
        this.showToast(
          'Mission Control',
          `Launched ${launchedThisCycle} job(s) (${this.jobsLaunchedCount} total).`,
          'info',
        );
      }

      for (const job of mergeOrder) {
        if (job.status === 'completed') {
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

        if (this.isSupervisor(plan)) {
          await this.setCheckpoint('pre_merge', plan);
          return;
        }

        this.mergeTrain ??= new MergeTrain(plan.integrationWorktree!, this.getMergeTrainConfig());
        this.mergeTrain.enqueue(job);
        await updatePlanJob(plan.id, job.name, { status: 'merging' });
        job.status = 'merging';
      }

      if (this.mergeTrain && this.mergeTrain.getQueue().length > 0) {
        const nextJob = this.mergeTrain.getQueue()[0];
        this.showToast('Mission Control', `Merging job "${nextJob.name}"...`, 'info');
        const mergeResult = await this.mergeTrain.processNext();

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
        } else if (mergeResult.type === 'conflict') {
          await updatePlanJob(plan.id, nextJob.name, {
            status: 'conflict',
            error: mergeResult.files?.join(', ') ?? 'merge conflict',
          });

          if (this.isSupervisor(plan)) {
            await this.setCheckpoint('on_error', plan);
            return;
          }

          plan.status = 'failed';
          this.showToast('Mission Control', `Merge conflict in job "${nextJob.name}".`, 'error');
        } else {
          await updatePlanJob(plan.id, nextJob.name, {
            status: 'failed',
            error: mergeResult.output ?? 'merge train test failure',
          });

          if (this.isSupervisor(plan)) {
            await this.setCheckpoint('on_error', plan);
            return;
          }

          plan.status = 'failed';
          this.showToast('Mission Control', `Job "${nextJob.name}" failed during merge.`, 'error');
        }
      }

      const latestPlan = await loadPlan();
      if (!latestPlan) {
        return;
      }

      const allMerged = latestPlan.jobs.length > 0 && latestPlan.jobs.every((job) => job.status === 'merged');
      if (allMerged) {
        this.showToast('Mission Control', 'All jobs merged. Creating PR...', 'info');

        if (this.isSupervisor(latestPlan)) {
          await this.setCheckpoint('pre_pr', latestPlan);
          return;
        }

        latestPlan.status = 'creating_pr';
        await savePlan(latestPlan);

        const prUrl = await this.createPR();
        latestPlan.prUrl = prUrl;
        latestPlan.status = 'completed';
        latestPlan.completedAt = new Date().toISOString();
        await savePlan(latestPlan);
        this.stopReconciler();
        this.unsubscribeFromMonitorEvents();
        this.showToast('Mission Control', `Plan completed! PR: ${prUrl}`, 'success');
        return;
      }

      if (latestPlan.status !== plan.status) {
        latestPlan.status = plan.status;
        if (plan.status === 'failed') {
          latestPlan.completedAt = new Date().toISOString();
          this.stopReconciler();
          this.unsubscribeFromMonitorEvents();
          this.showToast('Mission Control', `Plan "${latestPlan.name}" failed.`, 'error');
        }
        await savePlan(latestPlan);
      }
    } finally {
      this.isReconciling = false;
    }
  }

  private async launchJob(job: JobSpec): Promise<void> {
    const planId = this.activePlanId;
    if (!planId) {
      throw new Error('No active plan for job launch');
    }

    const placement = this.planPlacement ?? this.config.defaultPlacement ?? 'session';
    const branch = job.branch ?? `mc/${job.name}`;
    const sanitizedName = job.name.replace(/[^a-zA-Z0-9_-]/g, '-');
    const tmuxSessionName = `mc-${sanitizedName}`;
    const tmuxTarget =
      placement === 'session'
        ? tmuxSessionName
        : (() => {
            const currentSession = getCurrentSession();
            if (!currentSession && !isInsideTmux()) {
              throw new Error('Window placement requires running inside tmux');
            }
            return `${currentSession}:${sanitizedName}`;
          })();

    await updatePlanJob(planId, job.name, { status: 'running', branch });

    let worktreePath = '';
    let promptFilePath: string | undefined;
    try {
      const postCreate = resolvePostCreateHook(
        this.config.worktreeSetup,
        {
          copyFiles: job.copyFiles,
          symlinkDirs: job.symlinkDirs,
          commands: job.commands,
        },
      );
      worktreePath = await createWorktree({ branch, postCreate });

      if (placement === 'session') {
        await createSession({
          name: tmuxSessionName,
          workdir: worktreePath,
        });
      } else {
        await createWindow({
          session: getCurrentSession()!,
          name: sanitizedName,
          workdir: worktreePath,
        });
      }

      const mcReportSuffix = `\n\nSTATUS REPORTING: Use the mc_report tool to keep Mission Control informed of your progress. Call mc_report with status "working" and a progress percentage (0-100) at key milestones, "blocked" if you encounter an issue you cannot resolve, "needs_review" when your work is complete and ready for human review. Report at least once when starting and once when finishing.`;
      const autoCommitSuffix = (this.config.autoCommit !== false)
        ? `\n\nIMPORTANT: When you have completed ALL of your work, you MUST commit your changes before finishing. Stage all modified and new files, then create a commit with a conventional commit message (e.g. "feat: ...", "fix: ...", "docs: ...", "refactor: ...", "chore: ..."). Do NOT skip this step.`
        : '';
      const jobPrompt = job.prompt + mcReportSuffix + autoCommitSuffix;
      promptFilePath = await writePromptFile(worktreePath, jobPrompt);
      const launchCommand = buildPromptFileCommand(promptFilePath);
      await setPaneDiedHook(tmuxTarget, `run-shell "echo '${job.id}' >> .mission-control/completed-jobs.log"`);
      await sendKeys(tmuxTarget, launchCommand);
      await sendKeys(tmuxTarget, 'Enter');
      cleanupPromptFile(promptFilePath);

      await addJob({
        id: randomUUID(),
        name: job.name,
        worktreePath,
        branch,
        tmuxTarget,
        placement,
        status: 'running',
        prompt: job.prompt,
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
        planId,
      });

      await updatePlanJob(planId, job.name, {
        status: 'running',
        branch,
        worktreePath,
        tmuxTarget,
      });
    } catch (error) {
      if (promptFilePath) {
        cleanupPromptFile(promptFilePath, 0);
      }

      try {
        if (placement === 'session') {
          await killSession(tmuxSessionName);
        } else {
          const [session, window] = tmuxTarget.split(':');
          if (session && window) {
            await killWindow(session, window);
          }
        }
      } catch {}

      if (worktreePath) {
        await removeWorktree(worktreePath, true).catch(() => {});
      }

      await updatePlanJob(planId, job.name, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleJobComplete(job: Job): void {
    if (job.planId && this.activePlanId && job.planId === this.activePlanId) {
      if (!this.firstJobCompleted) {
        this.firstJobCompleted = true;
        this.showToast('Mission Control', `First job completed: "${job.name}".`, 'success');
      }

      updatePlanJob(job.planId, job.name, {
        status: 'completed',
      }).catch((error) => {
        console.error('Failed to update completed job state:', error);
      });

      this.reconcile().catch((error) => {
        console.error('Reconcile after completion failed:', error);
      });
    }
  }

  private handleJobFailed(job: Job): void {
    if (job.planId && this.activePlanId && job.planId === this.activePlanId) {
      updatePlanJob(job.planId, job.name, {
        status: 'failed',
        error: 'job monitor reported failure',
      }).catch(() => {});

      loadPlan()
        .then(async (plan) => {
          if (!plan || plan.id !== job.planId) {
            return;
          }

          if (this.isSupervisor(plan)) {
            await this.setCheckpoint('on_error', plan);
            return;
          }

          plan.status = 'failed';
          plan.completedAt = new Date().toISOString();
          await savePlan(plan);
          this.showToast('Mission Control', `Plan failed: job "${job.name}" failed.`, 'error');
        })
        .catch(() => {})
        .finally(() => {
          if (!this.checkpoint) {
            this.stopReconciler();
            this.unsubscribeFromMonitorEvents();
          }
        });
    }
  }

  async cancelPlan(): Promise<void> {
    this.stopReconciler();

    const plan = await loadPlan();
    if (!plan) {
      return;
    }

    const runningJobs = (await getRunningJobs()).filter((job) => job.planId === plan.id);
    for (const job of runningJobs) {
      try {
        if (job.placement === 'session') {
          await killSession(job.tmuxTarget);
        } else {
          const [session, window] = job.tmuxTarget.split(':');
          if (session && window) {
            await killWindow(session, window);
          }
        }
        await updateJob(job.id, {
          status: 'stopped',
          completedAt: new Date().toISOString(),
        });
      } catch {}
    }

    await deleteIntegrationBranch(plan.id);
    await clearPlan();
    this.unsubscribeFromMonitorEvents();
  }

  async resumePlan(): Promise<void> {
    const plan = await loadPlan();
    if (!plan || (plan.status !== 'running' && plan.status !== 'paused')) {
      return;
    }

    if (plan.status === 'paused') {
      plan.status = 'running';
      plan.checkpoint = null;
      await savePlan(plan);
    }
    this.checkpoint = null;

    this.activePlanId = plan.id;
    this.planPlacement = plan.placement ?? null;
    this.mergeTrain = new MergeTrain(plan.integrationWorktree!, this.getMergeTrainConfig());

    const runningJobs = (await getRunningJobs()).filter((job) => job.planId === plan.id);
    let hasDeadRunningJob = false;

    for (const runningJob of runningJobs) {
      const paneAlive = await isPaneRunning(runningJob.tmuxTarget);
      if (!paneAlive) {
        hasDeadRunningJob = true;
        await updateJob(runningJob.id, {
          status: 'failed',
          completedAt: new Date().toISOString(),
        });
        await updatePlanJob(plan.id, runningJob.name, {
          status: 'failed',
          error: 'tmux pane is not running',
        });
      }
    }

    if (hasDeadRunningJob) {
      const currentPlan = await loadPlan();
      if (currentPlan) {
        currentPlan.status = 'failed';
        currentPlan.completedAt = new Date().toISOString();
        await savePlan(currentPlan);
      }
      return;
    }

    this.subscribeToMonitorEvents();
    this.startReconciler();
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

    const title = plan.name.replace(/"/g, '\\"');
    const prResult = await this.runCommand([
      'gh',
      'pr',
      'create',
      '--head',
      plan.integrationBranch,
      '--base',
      'main',
      '--title',
      title,
    ]);

    if (prResult.exitCode !== 0) {
      throw new Error(`Failed to create PR: ${prResult.stderr || prResult.stdout}`);
    }

    return prResult.stdout.trim();
  }

  private async runCommand(
    command: string[],
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(command, {
      cwd,
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
    if (this.subscriptionsActive) {
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
