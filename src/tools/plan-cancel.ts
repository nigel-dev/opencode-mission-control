import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { loadPlan } from '../lib/plan-state';
import { Orchestrator } from '../lib/orchestrator';
import { JobMonitor } from '../lib/monitor';
import { loadConfig } from '../lib/config';

export const mc_plan_cancel: ToolDefinition = tool({
  description: 'Cancel the active orchestrated plan and stop all its jobs',
  args: {},
  async execute() {
    const plan = await loadPlan();
    if (!plan) {
      return 'No active plan to cancel.';
    }

    const planName = plan.name;
    const planId = plan.id;

    const config = await loadConfig();
    const monitor = new JobMonitor();
    const orchestrator = new Orchestrator(monitor, config);
    await orchestrator.cancelPlan();

    return [
      `Plan "${planName}" canceled.`,
      '',
      `  ID: ${planId}`,
      '',
      'All running jobs have been stopped.',
      'Integration branch and worktrees cleaned up.',
    ].join('\n');
  },
});
