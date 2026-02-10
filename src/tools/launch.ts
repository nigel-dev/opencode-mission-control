import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { randomUUID } from 'crypto';
import { getJobByName, addJob, type Job } from '../lib/job-state';
import { createWorktree, removeWorktree } from '../lib/worktree';
import {
  createSession,
  createWindow,
  setPaneDiedHook,
  sendKeys,
  getCurrentSession,
  isInsideTmux,
  isTmuxAvailable,
} from '../lib/tmux';
import { loadConfig } from '../lib/config';
import { detectOMO } from '../lib/omo';
import { copyPlansToWorktree } from '../lib/plan-copier';
import { resolvePostCreateHook } from '../lib/worktree-setup';
import { writePromptFile, cleanupPromptFile, writeLauncherScript, cleanupLauncherScript } from '../lib/prompt-file';
import { getCurrentModel } from '../lib/model-tracker';

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const AUTO_COMMIT_SUFFIX = `

IMPORTANT: When you have completed ALL of your work, you MUST commit your changes before finishing. Stage all modified and new files, then create a commit with a conventional commit message (e.g. "feat: ...", "fix: ...", "docs: ...", "refactor: ...", "chore: ..."). Do NOT skip this step.`;

const MC_REPORT_SUFFIX = `

CRITICAL — STATUS REPORTING REQUIRED:
You MUST call the mc_report tool at these points — this is NOT optional:

1. IMMEDIATELY when you start: mc_report(status: "working", message: "Starting: <brief description>")
2. At each major milestone: mc_report(status: "progress", message: "<what you accomplished>", progress: <0-100>)
3. If you get stuck or need input: mc_report(status: "blocked", message: "<what's blocking you>")
4. WHEN YOU ARE COMPLETELY DONE: mc_report(status: "completed", message: "<summary of what was done>")

The "completed" call is MANDATORY — it signals Mission Control that your job is finished. Without it, your job will appear stuck as "running" and block the pipeline. Always call mc_report(status: "completed", ...) as your FINAL action.

If your work needs human review before it can proceed: mc_report(status: "needs_review", message: "<what needs review>")`;

function buildFullPrompt(opts: {
  prompt: string;
  mode: string;
  planFile?: string;
  autoCommit?: boolean;
}): string {
  let prompt = opts.prompt + MC_REPORT_SUFFIX;
  if (opts.autoCommit !== false) {
    prompt += AUTO_COMMIT_SUFFIX;
  }

  switch (opts.mode) {
    case 'plan':
      if (opts.planFile) {
        return `${prompt} Plan file: ${opts.planFile}`;
      }
      return prompt;
    case 'ralph':
      return `/ralph-loop ${prompt}`;
    case 'ulw':
      return `/ulw-loop ${prompt}`;
    case 'vanilla':
    default:
      return prompt;
  }
}

export const mc_launch: ToolDefinition = tool({
  description:
    'Launch a new parallel AI coding session in an isolated worktree',
  args: {
    name: tool.schema
      .string()
      .describe('Job name (used for branch and tmux)'),
    prompt: tool.schema.string().describe('Task prompt for the AI agent'),
    branch: tool.schema
      .string()
      .optional()
      .describe('Branch name (defaults to mc/{name})'),
    placement: tool.schema
      .enum(['session', 'window'])
      .optional()
      .describe('tmux placement: session (default) or window'),
    mode: tool.schema
      .enum(['vanilla', 'plan', 'ralph', 'ulw'])
      .optional()
      .describe('Execution mode'),
    planFile: tool.schema
      .string()
      .optional()
      .describe('Plan file to use (for plan mode)'),
    copyFiles: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe('Files to copy from main worktree (e.g. [".env", ".env.local"])'),
    symlinkDirs: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe('Directories to symlink from main worktree (e.g. ["node_modules"]). .opencode is always included.'),
    commands: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe('Shell commands to run in worktree after creation (e.g. ["bun install"])'),
  },
  async execute(args, context) {
    // 0. Validate tmux is available
    const tmuxFound = await isTmuxAvailable();
    if (!tmuxFound) {
      throw new Error(
        'tmux is required but not found. Install tmux to use Mission Control: https://github.com/tmux/tmux',
      );
    }

    // 1. Validate name uniqueness
    const existing = await getJobByName(args.name);
    if (existing) {
      throw new Error(
        `Job "${args.name}" already exists (status: ${existing.status}). Use a different name or cleanup the existing job first.`,
      );
    }

    // 2. Load config for defaults
    const config = await loadConfig();

    // 3. Resolve parameters
    const jobId = randomUUID();
    const branch = args.branch ?? `mc/${args.name}`;
    const placement = args.placement ?? config.defaultPlacement;
    const mode = args.mode ?? config.omo.defaultMode;
    const sanitizedName = args.name.replace(/[^a-zA-Z0-9_-]/g, '-');

    // tmux target naming
    const tmuxSessionName = `mc-${sanitizedName}`;
    const tmuxTarget =
      placement === 'session'
        ? tmuxSessionName
        : (() => {
            const currentSession = getCurrentSession();
            if (!currentSession && !isInsideTmux()) {
              throw new Error(
                'Window placement requires being inside a tmux session. Use session placement instead, or run from within tmux.',
              );
            }
            return `${currentSession}:${sanitizedName}`;
          })();

    // 4. Create worktree with setup hooks
    const postCreate = resolvePostCreateHook(
      config.worktreeSetup,
      {
        copyFiles: args.copyFiles,
        symlinkDirs: args.symlinkDirs,
        commands: args.commands,
      },
    );

    let worktreePath: string;
    try {
      worktreePath = await createWorktree({ branch, postCreate });
    } catch (error) {
      throw new Error(
        `Failed to create worktree for branch "${branch}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 5. Handle OMO modes (copy plans if needed)
    if (mode !== 'vanilla') {
      const omoStatus = await detectOMO();
      if (!omoStatus.detected) {
        try {
          await removeWorktree(worktreePath, true);
        } catch {
          // Best-effort cleanup
        }
        throw new Error(
          `OMO mode "${mode}" requires Oh-My-OpenCode to be installed and detected`,
        );
      }

      if (mode === 'plan' || mode === 'ralph' || mode === 'ulw') {
        try {
          const sourcePlansPath = './.sisyphus/plans';
          const targetPlansPath = `${worktreePath}/.sisyphus/plans`;
          await copyPlansToWorktree(sourcePlansPath, targetPlansPath);
        } catch {
          // Non-fatal: plans might not exist
        }
      }
    }

    // 6. Write launcher script before creating tmux session
    let promptFilePath: string | undefined;
    let launcherPath: string | undefined;
    try {
      const fullPrompt = buildFullPrompt({
        prompt: args.prompt,
        mode,
        planFile: args.planFile,
        autoCommit: config.autoCommit,
      });
      promptFilePath = await writePromptFile(worktreePath, fullPrompt);
      const model = getCurrentModel(context?.sessionID);
      launcherPath = await writeLauncherScript(worktreePath, promptFilePath, model);
    } catch (error) {
      if (promptFilePath) {
        cleanupPromptFile(promptFilePath, 0);
      }
      try {
        await removeWorktree(worktreePath, true);
      } catch {
        // Best-effort cleanup
      }
      throw new Error(
        `Failed to write launch files: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 7. Create tmux session/window with launcher as initial command
    const initialCommand = `bash '${launcherPath}'`;
    try {
      if (placement === 'session') {
        await createSession({
          name: tmuxSessionName,
          workdir: worktreePath,
          command: initialCommand,
        });
      } else {
        const currentSession = getCurrentSession()!;
        await createWindow({
          session: currentSession,
          name: sanitizedName,
          workdir: worktreePath,
          command: initialCommand,
        });
      }
    } catch (error) {
      cleanupPromptFile(promptFilePath!, 0);
      cleanupLauncherScript(worktreePath, 0);
      try {
        await removeWorktree(worktreePath, true);
      } catch {
        // Best-effort cleanup
      }
      throw new Error(
        `Failed to create tmux ${placement}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 8. Set up pane-died hook for completion detection
    try {
      const hookCommand = `run-shell "echo '${jobId}' >> .mission-control/completed-jobs.log"`;
      await setPaneDiedHook(tmuxTarget, hookCommand);
    } catch {
      // Non-fatal: pane-died hook is supplementary; polling is primary
    }

    cleanupPromptFile(promptFilePath!);
    cleanupLauncherScript(worktreePath);

    // 9. For OMO modes, send follow-up commands after opencode starts
    if (mode !== 'vanilla') {
      try {
        await sleep(2000);
        switch (mode) {
          case 'plan':
            await sendKeys(tmuxTarget, '/start-work');
            await sendKeys(tmuxTarget, 'Enter');
            break;
          case 'ralph':
            await sendKeys(tmuxTarget, '/ralph-loop');
            await sendKeys(tmuxTarget, 'Enter');
            break;
          case 'ulw':
            await sendKeys(tmuxTarget, '/ulw-loop');
            await sendKeys(tmuxTarget, 'Enter');
            break;
        }
      } catch {
        // Non-fatal: OMO command delivery is best-effort
      }
    }

    // 9. Create and persist job
    const job: Job = {
      id: jobId,
      name: args.name,
      worktreePath,
      branch,
      tmuxTarget,
      placement,
      status: 'running',
      prompt: args.prompt,
      mode,
      planFile: args.planFile,
      createdAt: new Date().toISOString(),
    };

    await addJob(job);

    // 10. Return job info
    return [
      `Job "${args.name}" launched successfully.`,
      '',
      `  ID:        ${jobId}`,
      `  Branch:    ${branch}`,
      `  Worktree:  ${worktreePath}`,
      `  tmux:      ${tmuxTarget}`,
      `  Placement: ${placement}`,
      `  Mode:      ${mode}`,
      '',
      placement === 'session'
        ? `Attach with: tmux attach -t ${tmuxSessionName}`
        : `Switch with: tmux select-window -t ${tmuxTarget}`,
    ].join('\n');
  },
});
