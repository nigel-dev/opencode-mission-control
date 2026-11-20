import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { PlanSpec, JobSpec } from '../lib/plan-types';
import { clearPlan, loadPlan, savePlan, validateGhAuth } from '../lib/plan-state';
import { deleteIntegrationBranch } from '../lib/integration';
import { hasCircularDependency } from '../lib/orchestrator';
import { replaceSharedOrchestrator } from '../lib/orchestrator-singleton';
import { validateJobName } from '../lib/job-name';
import { loadConfig } from '../lib/config';
import { getDefaultBranch, gitCommand } from '../lib/git';
import { getCurrentModel } from '../lib/model-tracker';
import { assertToolPermission, type ToolCallContext } from '../lib/job-runtime';
import { describeCommandWarnings } from '../lib/worktree-setup';

export const mc_plan = {
  name: 'mc_plan',
  description:
    'Create and start a multi-job orchestrated plan with dependency management',
  input: z.object({
    name: z.string().describe('Plan name — used as the PR title. Use Conventional Commits format (e.g. "feat: add search", "fix: resolve auth bugs").'),
    jobs: z.array(z.object({
      name: z.string().describe('Unique job name'),
      prompt: z.string().describe('Task prompt for the AI agent'),
      dependsOn: z.array(z.string()).optional().describe('Names of jobs this depends on'),
      touchSet: z.array(z.string()).optional().describe('File globs this job expects to modify'),
      copyFiles: z.array(z.string()).optional().describe('Files to copy from main worktree (e.g. [".env"])'),
      symlinkDirs: z.array(z.string()).optional().describe('Directories to symlink from main worktree (e.g. ["node_modules"])'),
      commands: z.array(z.string()).optional().describe('Shell commands to run in worktree after creation'),
      agent: z.string().optional().describe('Agent for this job (defaults to the defaultAgent config, then the session default)'),
      model: z.string().optional().describe('Model for this job as "provider/model" or "provider/model#variant" (defaults to the model of the session that created the plan)'),
    }).strict()).describe('Array of jobs to execute'),
    mode: z.enum(['autopilot', 'copilot', 'supervisor']).optional().describe('Execution mode (default: autopilot)'),
    baseBranch: z.string().optional().describe('Base branch for the integration branch (defaults to default branch)'),
  }).strict(),
  async execute(args: {
    name: string;
    jobs: {
      name: string;
      prompt: string;
      dependsOn?: string[];
      touchSet?: string[];
      copyFiles?: string[];
      symlinkDirs?: string[];
      commands?: string[];
      agent?: string;
      model?: string;
    }[];
    mode?: 'autopilot' | 'copilot' | 'supervisor';
    baseBranch?: string;
  }, context?: ToolCallContext) {
    const mode = args.mode ?? 'autopilot';

    // 1. Validate jobs: names that are safe as branch and directory names, and unique
    if (args.jobs.length === 0) {
      throw new Error('A plan needs at least one job');
    }
    for (const job of args.jobs) {
      const problem = validateJobName(job.name);
      if (problem) {
        throw new Error(`Invalid job name "${job.name}": ${problem}`);
      }
    }
    const jobNames = args.jobs.map((j) => j.name);
    if (new Set(jobNames).size !== jobNames.length) {
      throw new Error('Job names must be unique');
    }

    // Setup commands run through a shell on the user's machine, outside any
    // job session. Hold them to the calling session's shell permission.
    const customCommands = [...new Set(args.jobs.flatMap((job) => job.commands ?? []))];
    if (customCommands.length > 0) {
      await assertToolPermission(context, 'shell', customCommands);
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
      agent: j.agent,
      model: j.model,
      status: 'queued' as const,
    }));

    if (hasCircularDependency(jobSpecs)) {
      throw new Error('Plan contains circular dependencies');
    }

    // 4. Check if active plan exists
    const existingPlan = await loadPlan();
    if (existingPlan?.status === 'completed') {
      // A finished plan has nothing left to do: its PR exists and its branch is
      // on the remote. Retire it so the next plan can start. Its jobs stay
      // listed until mc_cleanup removes them.
      await deleteIntegrationBranch(existingPlan.id);
      await clearPlan();
    } else if (existingPlan) {
      throw new Error(
        `Plan "${existingPlan.name}" is still active (status: ${existingPlan.status}). ` +
          'Finish it, or discard it with mc_plan_cancel, before starting another.',
      );
    }

    // 5. Validate gh auth
    const ghAuthenticated = await validateGhAuth();

    // 6. Root jobs start from the same commit the integration branch does: the
    // plan's base branch, not whatever happens to be checked out. Otherwise a
    // plan created from a feature branch would merge that branch into the PR.
    const baseRef = args.baseBranch ?? await getDefaultBranch();
    const baseResult = await gitCommand(['rev-parse', '--verify', baseRef]);
    if (baseResult.exitCode !== 0) {
      throw new Error(`Base branch "${baseRef}" was not found in this repository.`);
    }
    const baseCommit = baseResult.stdout.trim();

    // 7. Construct PlanSpec
    const planId = randomUUID();
    const spec: PlanSpec = {
      id: planId,
      name: args.name,
      mode,
      baseBranch: args.baseBranch,
      status: 'pending',
      jobs: jobSpecs,
      integrationBranch: `mc/integration-${planId}`,
      baseCommit,
      createdAt: new Date().toISOString(),
      launchSessionID: context?.sessionID,
      // Stored on the plan so jobs launched after a restart or an approval
      // still run on the model of the session that created it.
      model: getCurrentModel(context?.sessionID),
    };

    const config = await loadConfig();
    const setupCommands = [...(config.worktreeSetup?.commands ?? []), ...customCommands];
    const commandWarnings = config.allowUnsafeCommands === true ? [] : describeCommandWarnings(setupCommands);
    const warningLines = commandWarnings.length > 0
      ? ['', 'Warning: these setup commands will run and contain risky shell syntax:', ...commandWarnings.map((line) => `  ${line}`)]
      : [];

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

      return { content: [
        `Plan "${args.name}" created (pending approval).`,
        '',
        `  ID:     ${planId}`,
        `  Mode:   ${mode}`,
        `  Jobs:   ${spec.jobs.length}`,
        `  gh auth: ${ghAuthenticated ? 'yes' : 'no'}`,
        '',
        'Jobs:',
        jobSummary,
        ...warningLines,
        '',
        'Use mc_plan_approve to start execution.',
      ].join('\n') };
    }

    // autopilot or supervisor: start immediately
    const orchestrator = await replaceSharedOrchestrator(config);
    await orchestrator.startPlan(spec);

    const jobSummary = spec.jobs
      .map((j) => {
        const deps =
          j.dependsOn?.length ? ` (depends on: ${j.dependsOn.join(', ')})` : '';
        return `  - ${j.name}${deps}`;
      })
      .join('\n');

    return { content: [
      `Plan "${args.name}" started.`,
      '',
      `  ID:     ${planId}`,
      `  Mode:   ${mode}`,
      `  Jobs:   ${spec.jobs.length}`,
      `  gh auth: ${ghAuthenticated ? 'yes' : 'no'}`,
      '',
      'Jobs:',
      jobSummary,
      ...warningLines,
      '',
      'Use mc_plan_status to monitor progress.',
    ].join('\n') };
  },
};
