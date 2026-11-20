import { z } from 'zod';
import { loadPlan, savePlan } from '../lib/plan-state';
import { replaceSharedOrchestrator } from '../lib/orchestrator-singleton';
import type { CheckpointType } from '../lib/plan-types';
import { loadConfig } from '../lib/config';
import { loadJobState } from '../lib/job-state';
import { findUncommittedChanges } from '../lib/worktree-status';
import { createIntegrationBranch } from '../lib/integration';
import { resolvePostCreateHook } from '../lib/worktree-setup';
import { validateTouchSet } from '../lib/merge-train';

export const mc_plan_approve = {
  name: 'mc_plan_approve',
  description:
    'Approve a pending copilot plan, clear a supervisor checkpoint, or retry/relaunch a failed job to continue execution',
  input: z.object({
    checkpoint: z.enum(['pre_merge', 'on_error', 'pre_pr']).optional().describe('Specific checkpoint to clear (for supervisor mode)'),
    retry: z.string().optional().describe('Name of a failed, conflict, or needs_rebase job to retry after manual fix (re-validates touchSet)'),
    relaunch: z.string().optional().describe('Name of a touchSet-failed job to relaunch — spawns agent in existing worktree with correction prompt'),
  }).strict(),
  async execute(args: { checkpoint?: 'pre_merge' | 'on_error' | 'pre_pr'; retry?: string; relaunch?: string }) {
    if (args.retry && args.relaunch) {
      throw new Error('Cannot specify both "retry" and "relaunch". Use "retry" for manual fixes (re-validates) or "relaunch" to spawn an agent to fix violations.');
    }

    const initial = await loadPlan();
    if (!initial) {
      throw new Error('No active plan to approve');
    }

    const targetJobName = args.retry ?? args.relaunch;
    if (targetJobName) {
      const job = initial.jobs.find((j) => j.name === targetJobName);
      if (!job) {
        throw new Error(`Job "${targetJobName}" not found in plan`);
      }
      if (job.status !== 'failed' && job.status !== 'conflict' && job.status !== 'needs_rebase') {
        throw new Error(`Job "${targetJobName}" is not in a retryable state (current: ${job.status}). Only failed, conflict, or needs_rebase jobs can be retried.`);
      }
    }

    if (initial.status !== 'pending' && !(initial.status === 'paused' && initial.checkpoint)) {
      throw new Error(
        `Plan "${initial.name}" is not pending or paused (current status: ${initial.status})`,
      );
    }

    // From here on the plan is going to be resumed. Retire the orchestrator
    // that paused it first and wait for a reconcile pass it still has in
    // flight, then read the plan again: that pass may have changed job states.
    const config = await loadConfig();
    const orchestrator = await replaceSharedOrchestrator(config);
    const settledPlan = await loadPlan();
    if (!settledPlan || settledPlan.id !== initial.id) {
      throw new Error('No active plan to approve');
    }
    const plan = settledPlan;
    if (plan.status !== 'pending' && !(plan.status === 'paused' && plan.checkpoint)) {
      // The retired orchestrator's last pass moved the plan on; pick it up as is.
      await orchestrator.resumePlan();
      throw new Error(
        `Plan "${plan.name}" is not pending or paused (current status: ${plan.status})`,
      );
    }

    if (plan.status === 'paused' && plan.checkpoint) {
      const checkpoint = (args.checkpoint ?? plan.checkpoint) as CheckpointType;

      // Supervisor approvals must survive the process boundary: mc_plan_approve
      // creates a new Orchestrator, so in-memory approval sets are empty on
      // resume. Persist approvals on the plan before resuming.
      const mergeApprovals = plan.approvedMergeJobs ?? [];
      const approveForMerge = (jobName: string) => {
        if (!mergeApprovals.includes(jobName)) {
          mergeApprovals.push(jobName);
        }
        plan.approvedMergeJobs = mergeApprovals;
      };

      if (args.relaunch) {
        const ctx = plan.checkpointContext;
        if (!ctx || ctx.failureKind !== 'touchset') {
          throw new Error(`Job "${args.relaunch}" was not failed due to a touchSet violation — use "retry" instead.`);
        }
        if (ctx.jobName !== args.relaunch) {
          throw new Error(`Checkpoint was set for job "${ctx.jobName}", not "${args.relaunch}".`);
        }

        plan.status = 'running';
        plan.checkpoint = null;
        plan.checkpointContext = null;
        approveForMerge(args.relaunch);
        await savePlan(plan);

        await orchestrator.relaunchJobForCorrection(
          args.relaunch,
          ctx.touchSetViolations ?? [],
          ctx.touchSetPatterns ?? [],
        );
        await orchestrator.resumePlan();

        return { content: [
          `Checkpoint "${checkpoint}" cleared. Job "${args.relaunch}" relaunched with correction prompt.`,
          '',
          `  ID:   ${plan.id}`,
          `  Mode: ${plan.mode}`,
          '',
          'The agent will fix touchSet violations in the existing worktree.',
          'Use mc_plan_status to monitor progress.',
        ].join('\n') };
      }

      if (args.retry) {
        const job = plan.jobs.find(j => j.name === args.retry)!;

        const ctx = plan.checkpointContext;
        if (ctx?.failureKind === 'touchset' && ctx.jobName === args.retry) {
          if (job.touchSet && job.touchSet.length > 0 && job.branch && plan.integrationBranch) {
            const validation = await validateTouchSet(job.branch, plan.integrationBranch, job.touchSet);
            if (!validation.valid && validation.violations) {
              throw new Error(
                `Job "${args.retry}" still has touchSet violations after manual fix:\n` +
                `  Violations: ${validation.violations.join(', ')}\n` +
                `  Allowed: ${job.touchSet.join(', ')}\n` +
                `Fix the remaining violations and retry again.`,
              );
            }
          }
        }

        if (ctx?.failureKind === 'uncommitted_changes' && ctx.jobName === args.retry) {
          const stateJob = (await loadJobState()).jobs.find(
            (candidate) => candidate.name === args.retry && candidate.planId === plan.id,
          );
          if (stateJob) {
            const remaining = await findUncommittedChanges(stateJob);
            if (remaining.length > 0) {
              throw new Error(
                `Job "${args.retry}" still has uncommitted changes in ${stateJob.worktreePath}:\n` +
                `  ${remaining.join(', ')}\n` +
                `Commit them and retry again, or approve without "retry" to merge the branch without them.`,
              );
            }
          }
        }

        // A job that never launched has no work to merge: queue it again.
        const relaunch = ctx?.failureKind === 'launch_failed' && ctx.jobName === args.retry;
        const retryJob = plan.jobs.find(j => j.name === args.retry)!;
        retryJob.status = relaunch ? 'queued' : 'ready_to_merge';
        retryJob.error = undefined;

        plan.status = 'running';
        plan.checkpoint = null;
        plan.checkpointContext = null;
        if (!relaunch) {
          approveForMerge(args.retry);
        }
        await savePlan(plan);

        await orchestrator.resumePlan();

        return { content: [
          `Checkpoint "${checkpoint}" cleared. Job "${args.retry}" reset to ${retryJob.status}.`,
          '',
          `  ID:   ${plan.id}`,
          `  Mode: ${plan.mode}`,
          '',
          'Use mc_plan_status to monitor progress.',
        ].join('\n') };
      }

      const ctx = plan.checkpointContext;
      // Approving these without "retry" accepts the job as it is: its
      // touchSet violations, or its branch without the uncommitted changes.
      const accepted = ctx?.failureKind === 'touchset' || ctx?.failureKind === 'uncommitted_changes';
      if (ctx && accepted) {
        const job = plan.jobs.find(j => j.name === ctx.jobName);
        if (job && job.status === 'failed') {
          job.status = 'ready_to_merge';
          job.error = undefined;
        }
      }

      if (plan.mode === 'supervisor') {
        if (checkpoint === 'pre_merge') {
          for (const job of plan.jobs) {
            if (job.status === 'ready_to_merge') {
              approveForMerge(job.name);
            }
          }
        } else if (checkpoint === 'pre_pr') {
          plan.approvedPrePr = true;
        } else if (ctx && accepted && ctx.jobName) {
          approveForMerge(ctx.jobName);
        }
      }

      plan.status = 'running';
      plan.checkpoint = null;
      plan.checkpointContext = null;
      await savePlan(plan);

      await orchestrator.resumePlan();

      const acceptMsg = ctx?.failureKind === 'touchset'
        ? ` TouchSet violations for job "${ctx.jobName}" accepted.`
        : ctx?.failureKind === 'uncommitted_changes'
          ? ` Job "${ctx.jobName}" will be merged without its uncommitted changes.`
          : '';
      return { content: [
        `Checkpoint "${checkpoint}" cleared.${acceptMsg} Plan "${plan.name}" resuming.`,
        '',
        `  ID:   ${plan.id}`,
        `  Mode: ${plan.mode}`,
        '',
        'Use mc_plan_status to monitor progress.',
      ].join('\n') };
    }

    const integrationPostCreate = resolvePostCreateHook(config.worktreeSetup);
    const integration = plan.baseBranch
      ? await createIntegrationBranch(plan.id, integrationPostCreate, plan.baseBranch)
      : await createIntegrationBranch(plan.id, integrationPostCreate);
    plan.integrationBranch = integration.branch;
    plan.integrationWorktree = integration.worktreePath;
    plan.status = 'running';
    await savePlan(plan);

    await orchestrator.resumePlan();

    return { content: [
      `Plan "${plan.name}" approved and started.`,
      '',
      `  ID:   ${plan.id}`,
      `  Mode: ${plan.mode}`,
      `  Jobs: ${plan.jobs.length}`,
      '',
      'Use mc_plan_status to monitor progress.',
    ].join('\n') };
  },
};
