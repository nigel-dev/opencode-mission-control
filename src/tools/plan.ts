import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { randomUUID } from 'crypto';
import type { PlanSpec, JobSpec } from '../lib/plan-types';
import { loadPlan, savePlan, validateGhAuth } from '../lib/plan-state';
import { Orchestrator, hasCircularDependency } from '../lib/orchestrator';
import { getSharedMonitor, getSharedNotifyCallback, setSharedOrchestrator } from '../lib/orchestrator-singleton';
import { loadConfig } from '../lib/config';
import { gitCommand } from '../lib/git';

export const mc_plan: ToolDefinition = tool({
  description:
    'Create and start a multi-job orchestrated plan with dependency management',
  args: {
    name: tool.schema.string().describe('Plan name'),
    jobs: tool.schema
      .array(
        tool.schema.object({
          name: tool.schema.string().describe('Unique job name'),
          prompt: tool.schema.string().describe('Task prompt for the AI agent'),
          dependsOn: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe('Names of jobs this depends on'),
          touchSet: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe('File globs this job expects to modify'),
          copyFiles: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe('Files to copy from main worktree (e.g. [".env"])'),
          symlinkDirs: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe('Directories to symlink from main worktree (e.g. ["node_modules"])'),
          commands: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe('Shell commands to run in worktree after creation'),
        }),
      )
      .describe('Array of jobs to execute'),
    mode: tool.schema
      .enum(['autopilot', 'copilot', 'supervisor'])
      .optional()
      .describe('Execution mode (default: autopilot)'),
    placement: tool.schema
      .enum(['session', 'window'])
      .optional()
      .describe('tmux placement for jobs: session (default) or window in current session'),
  },
  async execute(args) {
    const mode = args.mode ?? 'autopilot';

    // 1. Validate jobs: unique names
    const jobNames = args.jobs.map((j) => j.name);
    if (new Set(jobNames).size !== jobNames.length) {
      throw new Error('Job names must be unique');
    }

    // 2. Validate deps reference existing job names
    const nameSet = new Set(jobNames);
    for (const job of args.jobs) {
      for (const dep of job.dependsOn ?? []) {
        if (!nameSet.has(dep)) {
          throw new Error(
            `Job "${job.name}" depends on unknown job "${dep}"`,
          );
        }
      }
    }

    // 3. Check circular deps
    const jobSpecs: JobSpec[] = args.jobs.map((j) => ({
      id: randomUUID(),
      name: j.name,
      prompt: j.prompt,
      dependsOn: j.dependsOn,
      touchSet: j.touchSet,
      copyFiles: j.copyFiles,
      symlinkDirs: j.symlinkDirs,
      commands: j.commands,
      status: 'queued' as const,
    }));

    if (hasCircularDependency(jobSpecs)) {
      throw new Error('Plan contains circular dependencies');
    }

    // 4. Check if active plan exists
    const existingPlan = await loadPlan();
    if (existingPlan) {
      throw new Error('Active plan already exists');
    }

    // 5. Validate gh auth
    const ghAuthenticated = await validateGhAuth();

    // 6. Get base commit from main HEAD
    const headResult = await gitCommand(['rev-parse', 'HEAD']);
    const baseCommit =
      headResult.exitCode === 0 ? headResult.stdout.trim() : 'unknown';

    // 7. Construct PlanSpec
    const planId = randomUUID();
    const spec: PlanSpec = {
      id: planId,
      name: args.name,
      mode,
      placement: args.placement,
      status: 'pending',
      jobs: jobSpecs,
      integrationBranch: `mc/integration/${planId.slice(0, 8)}`,
      baseCommit,
      createdAt: new Date().toISOString(),
    };

    // 8. Handle mode
    if (mode === 'copilot') {
      // Persist plan with pending status, return summary for approval
      await savePlan(spec);

      const jobSummary = spec.jobs
        .map((j) => {
          const deps =
            j.dependsOn?.length ? ` (depends on: ${j.dependsOn.join(', ')})` : '';
          return `  - ${j.name}${deps}`;
        })
        .join('\n');

      return [
        `Plan "${args.name}" created (pending approval).`,
        '',
        `  ID:     ${planId}`,
        `  Mode:   ${mode}`,
        `  Jobs:   ${spec.jobs.length}`,
        `  gh auth: ${ghAuthenticated ? 'yes' : 'no'}`,
        '',
        'Jobs:',
        jobSummary,
        '',
        'Use mc_plan_approve to start execution.',
      ].join('\n');
    }

    // autopilot or supervisor: start immediately
    const config = await loadConfig();
    const orchestrator = new Orchestrator(getSharedMonitor(), config, { notify: getSharedNotifyCallback() ?? undefined });
    setSharedOrchestrator(orchestrator);
    await orchestrator.startPlan(spec);

    const jobSummary = spec.jobs
      .map((j) => {
        const deps =
          j.dependsOn?.length ? ` (depends on: ${j.dependsOn.join(', ')})` : '';
        return `  - ${j.name}${deps}`;
      })
      .join('\n');

    return [
      `Plan "${args.name}" started.`,
      '',
      `  ID:     ${planId}`,
      `  Mode:   ${mode}`,
      `  Jobs:   ${spec.jobs.length}`,
      `  gh auth: ${ghAuthenticated ? 'yes' : 'no'}`,
      '',
      'Jobs:',
      jobSummary,
      '',
      'Use mc_plan_status to monitor progress.',
    ].join('\n');
  },
});
