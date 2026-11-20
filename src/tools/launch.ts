import { z } from 'zod';
import { loadConfig } from '../lib/config';
import { launchJob } from '../lib/job-launcher';
import { assertToolPermission, type ToolCallContext } from '../lib/job-runtime';
import { describeCommandWarnings } from '../lib/worktree-setup';

export const mc_launch = {
  name: 'mc_launch',
  description:
    'Launch a new parallel AI coding session in an isolated worktree',
  input: z.object({
    name: z.string().describe('Job name (used for the branch and the session title)'),
    prompt: z.string().describe('Task prompt for the AI agent'),
    branch: z.string().optional().describe('Branch name (defaults to mc/{name})'),
    baseBranch: z.string().optional().describe('Branch or ref to start from (defaults to default branch)'),
    agent: z.string().optional().describe('Agent to run the job with (defaults to the defaultAgent config, then the session default)'),
    model: z.string().optional().describe('Model as "provider/model" or "provider/model#variant" (defaults to the defaultModel config, then the current model)'),
    copyFiles: z.array(z.string()).optional().describe('Files to copy from main worktree (e.g. [".env", ".env.local"])'),
    symlinkDirs: z.array(z.string()).optional().describe('Directories to symlink from main worktree (e.g. ["node_modules"]). .opencode is always included.'),
    commands: z.array(z.string()).optional().describe('Shell commands to run in worktree after creation (e.g. ["bun install"])'),
  }).strict(),
  async execute(
    args: {
      name: string;
      prompt: string;
      branch?: string;
      baseBranch?: string;
      agent?: string;
      model?: string;
      copyFiles?: string[];
      symlinkDirs?: string[];
      commands?: string[];
    },
    context?: ToolCallContext,
  ) {
    if (args.commands && args.commands.length > 0) {
      // Setup commands run through a shell on the user's machine, outside any
      // job session. Hold them to the calling session's shell permission.
      await assertToolPermission(context, 'shell', args.commands);
    }

    const job = await launchJob({
      name: args.name,
      prompt: args.prompt,
      branch: args.branch,
      baseBranch: args.baseBranch,
      agent: args.agent,
      model: args.model,
      copyFiles: args.copyFiles,
      symlinkDirs: args.symlinkDirs,
      commands: args.commands,
      launchSessionID: context?.sessionID,
    });

    const config = await loadConfig();
    const setupCommands = [...(config.worktreeSetup?.commands ?? []), ...(args.commands ?? [])];
    const warnings = config.allowUnsafeCommands === true ? [] : describeCommandWarnings(setupCommands);

    const infoLines = [
      `Job "${job.name}" launched successfully.`,
      '',
      `  ID:        ${job.id}`,
      `  Branch:    ${job.branch}`,
      ...(job.baseBranch ? [`  Base:      ${job.baseBranch}`] : []),
      `  Worktree:  ${job.worktreePath}`,
      `  Session:   ${job.sessionID}`,
      ...(job.agent ? [`  Agent:     ${job.agent}`] : []),
      ...(job.model ? [`  Model:     ${job.model}`] : []),
      ...(warnings.length > 0
        ? ['', 'Warning: these setup commands were run and contain risky shell syntax:', ...warnings.map((line) => `  ${line}`)]
        : []),
      '',
      'Watch it with:',
      `  mc_status(name: "${job.name}")   detailed status`,
      `  mc_capture(name: "${job.name}")  recent transcript`,
      `  mc_attach(name: "${job.name}")   how to open the job's session`,
    ];

    return { content: infoLines.join('\n') };
  },
};
