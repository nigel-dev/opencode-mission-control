import { z } from 'zod';
import { loadPlan } from '../lib/plan-state';
import { Orchestrator } from '../lib/orchestrator';
import { getSharedMonitor, getSharedOrchestratorCallbacks } from '../lib/orchestrator-singleton';
import { loadConfig } from '../lib/config';

export const mc_plan_cancel = {
  name: 'mc_plan_cancel',
  description: 'Cancel the active orchestrated plan and stop all its jobs',
  input: z.object({}).strict(),
  async execute() {
    const plan = await loadPlan();
    if (!plan) {
      return { content: 'No active plan to cancel.' };
    }

    const planName = plan.name;
    const planId = plan.id;

    const config = await loadConfig();
    const orchestrator = new Orchestrator(getSharedMonitor(), config, getSharedOrchestratorCallbacks());
    await orchestrator.cancelPlan();

    return { content: [
      `Plan "${planName}" canceled.`,
      '',
      `  ID: ${planId}`,
      '',
      'All running jobs have been stopped.',
      'Integration branch and worktrees cleaned up.',
    ].join('\n') };
  },
};
