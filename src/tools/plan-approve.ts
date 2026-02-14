import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { loadPlan, savePlan } from '../lib/plan-state';
import { Orchestrator } from '../lib/orchestrator';
import { getSharedMonitor, getSharedNotifyCallback, setSharedOrchestrator } from '../lib/orchestrator-singleton';
import type { CheckpointType } from '../lib/plan-types';
import { loadConfig } from '../lib/config';
import { getCurrentModel } from '../lib/model-tracker';
import { createIntegrationBranch } from '../lib/integration';
import { resolvePostCreateHook } from '../lib/worktree-setup';
import { validateTouchSet } from '../lib/merge-train';

export const mc_plan_approve: ToolDefinition = tool({
  description:
    'Approve a pending copilot plan, clear a supervisor checkpoint, or retry/relaunch a failed job to continue execution',
  args: {
    checkpoint: tool.schema
      .enum(['pre_merge', 'on_error', 'pre_pr'])
      .optional()
      .describe('Specific checkpoint to clear (for supervisor mode)'),
    retry: tool.schema
      .string()
      .optional()
      .describe('Name of a failed, conflict, or needs_rebase job to retry after manual fix (re-validates touchSet)'),
    relaunch: tool.schema
      .string()
      .optional()
      .describe('Name of a touchSet-failed job to relaunch — spawns agent in existing worktree with correction prompt'),
  },
  async execute(args) {
    if (args.retry && args.relaunch) {
      throw new Error('Cannot specify both "retry" and "relaunch". Use "retry" for manual fixes (re-validates) or "relaunch" to spawn an agent to fix violations.');
    }

    const plan = await loadPlan();
    if (!plan) {
      throw new Error('No active plan to approve');
    }

    const targetJobName = args.retry ?? args.relaunch;
    if (targetJobName) {
      const job = plan.jobs.find((j) => j.name === targetJobName);
      if (!job) {
        throw new Error(`Job "${targetJobName}" not found in plan`);
      }
      if (job.status !== 'failed' && job.status !== 'conflict' && job.status !== 'needs_rebase') {
        throw new Error(`Job "${targetJobName}" is not in a retryable state (current: ${job.status}). Only failed, conflict, or needs_rebase jobs can be retried.`);
      }
    }

    if (plan.status === 'paused' && plan.checkpoint) {
      const checkpoint = (args.checkpoint ?? plan.checkpoint) as CheckpointType;
      const config = await loadConfig();

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
        await savePlan(plan);

        const orchestrator = new Orchestrator(getSharedMonitor(), config, { notify: getSharedNotifyCallback() ?? undefined });
        setSharedOrchestrator(orchestrator);
        orchestrator.setPlanModelSnapshot(getCurrentModel());

        await orchestrator.relaunchJobForCorrection(
          args.relaunch,
          ctx.touchSetViolations ?? [],
          ctx.touchSetPatterns ?? [],
        );
        await orchestrator.resumePlan();

        return [
          `Checkpoint "${checkpoint}" cleared. Job "${args.relaunch}" relaunched with correction prompt.`,
          '',
          `  ID:   ${plan.id}`,
          `  Mode: ${plan.mode}`,
          '',
          'The agent will fix touchSet violations in the existing worktree.',
          'Use mc_plan_status to monitor progress.',
        ].join('\n');
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

        const retryJob = plan.jobs.find(j => j.name === args.retry)!;
        retryJob.status = 'ready_to_merge';
        retryJob.error = undefined;

        plan.status = 'running';
        plan.checkpoint = null;
        plan.checkpointContext = null;
        await savePlan(plan);

        const orchestrator = new Orchestrator(getSharedMonitor(), config, { notify: getSharedNotifyCallback() ?? undefined });
        setSharedOrchestrator(orchestrator);
        orchestrator.setPlanModelSnapshot(getCurrentModel());
        await orchestrator.resumePlan();

        return [
          `Checkpoint "${checkpoint}" cleared. Job "${args.retry}" reset to ready_to_merge.`,
          '',
          `  ID:   ${plan.id}`,
          `  Mode: ${plan.mode}`,
          '',
          'Use mc_plan_status to monitor progress.',
        ].join('\n');
      }

      const ctx = plan.checkpointContext;
      if (ctx?.failureKind === 'touchset') {
        const job = plan.jobs.find(j => j.name === ctx.jobName);
        if (job && job.status === 'failed') {
          job.status = 'ready_to_merge';
          job.error = undefined;
        }
      }

      plan.status = 'running';
      plan.checkpoint = null;
      plan.checkpointContext = null;
      await savePlan(plan);

      const orchestrator = new Orchestrator(getSharedMonitor(), config, { notify: getSharedNotifyCallback() ?? undefined });
      setSharedOrchestrator(orchestrator);
      orchestrator.setPlanModelSnapshot(getCurrentModel());
      await orchestrator.resumePlan();

      const acceptMsg = ctx?.failureKind === 'touchset'
        ? ` TouchSet violations for job "${ctx.jobName}" accepted.`
        : '';
      return [
        `Checkpoint "${checkpoint}" cleared.${acceptMsg} Plan "${plan.name}" resuming.`,
        '',
        `  ID:   ${plan.id}`,
        `  Mode: ${plan.mode}`,
        '',
        'Use mc_plan_status to monitor progress.',
      ].join('\n');
    }

    if (plan.status !== 'pending') {
      throw new Error(
        `Plan "${plan.name}" is not pending or paused (current status: ${plan.status})`,
      );
    }

    const config = await loadConfig();
    const integrationPostCreate = resolvePostCreateHook(config.worktreeSetup);
    const integration = plan.baseBranch
      ? await createIntegrationBranch(plan.id, integrationPostCreate, plan.baseBranch)
      : await createIntegrationBranch(plan.id, integrationPostCreate);
    plan.integrationBranch = integration.branch;
    plan.integrationWorktree = integration.worktreePath;
    plan.status = 'running';
    await savePlan(plan);

    const orchestrator = new Orchestrator(getSharedMonitor(), config, { notify: getSharedNotifyCallback() ?? undefined });
    setSharedOrchestrator(orchestrator);
    orchestrator.setPlanModelSnapshot(getCurrentModel());
    await orchestrator.resumePlan();

    return [
      `Plan "${plan.name}" approved and started.`,
      '',
      `  ID:   ${plan.id}`,
      `  Mode: ${plan.mode}`,
      `  Jobs: ${plan.jobs.length}`,
      '',
      'Use mc_plan_status to monitor progress.',
    ].join('\n');
  },
});
