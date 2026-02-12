import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { loadPlan, savePlan, updatePlanJob } from '../lib/plan-state';
import { Orchestrator } from '../lib/orchestrator';
import { getSharedMonitor, getSharedNotifyCallback, setSharedOrchestrator } from '../lib/orchestrator-singleton';
import type { CheckpointType } from '../lib/plan-types';
import { loadConfig } from '../lib/config';
import { getCurrentModel } from '../lib/model-tracker';
import { createIntegrationBranch } from '../lib/integration';
import { resolvePostCreateHook } from '../lib/worktree-setup';

export const mc_plan_approve: ToolDefinition = tool({
  description:
    'Approve a pending copilot plan, clear a supervisor checkpoint, or retry a failed job to continue execution',
  args: {
    checkpoint: tool.schema
      .enum(['pre_merge', 'on_error', 'pre_pr'])
      .optional()
      .describe('Specific checkpoint to clear (for supervisor mode)'),
    retry: tool.schema
      .string()
      .optional()
      .describe('Name of a failed, conflict, or needs_rebase job to retry'),
  },
  async execute(args) {
    const plan = await loadPlan();
    if (!plan) {
      throw new Error('No active plan to approve');
    }

    if (args.retry) {
      const job = plan.jobs.find((j) => j.name === args.retry);
      if (!job) {
        throw new Error(`Job "${args.retry}" not found in plan`);
      }
      if (job.status !== 'failed' && job.status !== 'conflict' && job.status !== 'needs_rebase') {
        throw new Error(`Job "${args.retry}" is not in a retryable state (current: ${job.status}). Only failed, conflict, or needs_rebase jobs can be retried.`);
      }
    }

    if (plan.status === 'paused' && plan.checkpoint) {
      const checkpoint = (args.checkpoint ?? plan.checkpoint) as CheckpointType;

      if (args.retry) {
        const job = plan.jobs.find(j => j.name === args.retry);
        if (!job) {
          throw new Error(`Job "${args.retry}" not found in plan`);
        }
        if (job.status !== 'failed' && job.status !== 'conflict' && job.status !== 'needs_rebase') {
          throw new Error(`Job "${args.retry}" is not in a retryable state (current: ${job.status}). Only failed, conflict, or needs_rebase jobs can be retried.`);
        }
        await updatePlanJob(plan.id, args.retry, { status: 'ready_to_merge', error: undefined });
      }

      plan.status = 'running';
      plan.checkpoint = null;
      await savePlan(plan);

      const config = await loadConfig();
      const orchestrator = new Orchestrator(getSharedMonitor(), config, { notify: getSharedNotifyCallback() ?? undefined });
      setSharedOrchestrator(orchestrator);
      orchestrator.setPlanModelSnapshot(getCurrentModel());
      await orchestrator.resumePlan();

      const retryMsg = args.retry ? ` Job "${args.retry}" reset to ready_to_merge.` : '';
      return [
        `Checkpoint "${checkpoint}" cleared.${retryMsg} Plan "${plan.name}" resuming.`,
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

    // Create integration infrastructure that copilot mode skipped
    const config = await loadConfig();
    const integrationPostCreate = resolvePostCreateHook(config.worktreeSetup);
    const integration = await createIntegrationBranch(plan.id, integrationPostCreate);
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
