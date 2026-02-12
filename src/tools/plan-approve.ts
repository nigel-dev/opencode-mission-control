import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { loadPlan, savePlan } from '../lib/plan-state';
import { Orchestrator } from '../lib/orchestrator';
import { getSharedMonitor, getSharedNotifyCallback, setSharedOrchestrator } from '../lib/orchestrator-singleton';
import type { CheckpointType } from '../lib/plan-types';
import { loadConfig } from '../lib/config';
import { getCurrentModel } from '../lib/model-tracker';
import { createIntegrationBranch } from '../lib/integration';
import { resolvePostCreateHook } from '../lib/worktree-setup';

export const mc_plan_approve: ToolDefinition = tool({
  description:
    'Approve a pending copilot plan or clear a supervisor checkpoint to continue execution',
  args: {
    checkpoint: tool.schema
      .enum(['pre_merge', 'on_error', 'pre_pr'])
      .optional()
      .describe('Specific checkpoint to clear (for supervisor mode)'),
  },
  async execute(args) {
    const plan = await loadPlan();
    if (!plan) {
      throw new Error('No active plan to approve');
    }

    if (plan.status === 'paused' && plan.checkpoint) {
      const checkpoint = (args.checkpoint ?? plan.checkpoint) as CheckpointType;
      plan.status = 'running';
      plan.checkpoint = null;
      await savePlan(plan);

      const config = await loadConfig();
      const orchestrator = new Orchestrator(getSharedMonitor(), config, { notify: getSharedNotifyCallback() ?? undefined });
      setSharedOrchestrator(orchestrator);
      orchestrator.setPlanModelSnapshot(getCurrentModel());
      await orchestrator.resumePlan();

      return [
        `Checkpoint "${checkpoint}" cleared. Plan "${plan.name}" resuming.`,
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
