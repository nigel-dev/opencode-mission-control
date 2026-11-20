import { randomUUID } from 'crypto';
import { loadConfig, type MCConfig } from './config';
import { addJob, loadJobState, removeJob, type Job } from './job-state';
import { parseModel, removeJobSession, startJobSession } from './job-runtime';
import { getCurrentModel } from './model-tracker';
import { removeReport } from './reports';
import { createWorktree, removeWorktree } from './worktree';
import { gitCommand } from './git';
import { resolvePostCreateHook } from './worktree-setup';
import { assertValidJobName } from './job-name';

export const AUTO_COMMIT_SUFFIX = `

IMPORTANT: When you have completed ALL of your work, you MUST commit your changes BEFORE you report completion with mc_report. Stage the files you modified or created for this task, then create a commit with a conventional commit message (e.g. "feat: ...", "fix: ...", "docs: ...", "refactor: ...", "chore: ..."). Do NOT skip this step: only committed work is taken from your branch.`;

export const MC_REPORT_SUFFIX = `

CRITICAL — STATUS REPORTING REQUIRED:
You MUST call the mc_report tool at these points — this is NOT optional:

1. IMMEDIATELY when you start: mc_report(status: "working", message: "Starting: <brief description>")
2. At each major milestone: mc_report(status: "progress", message: "<what you accomplished>", progress: <0-100>)
3. If you get stuck or need a decision: mc_report(status: "blocked", message: "<your question or what's blocking you>"), then STOP and end your turn. Do not ask interactively. The answer will arrive as a new message and you continue from there.
4. WHEN YOU ARE COMPLETELY DONE: mc_report(status: "completed", message: "<summary of what was done>")

The "completed" call is MANDATORY — it signals Mission Control that your job is finished. Without it, your job will appear stuck as "running" and block the pipeline. Always call mc_report(status: "completed", ...) as your FINAL action.

If your work needs human review before it can proceed: mc_report(status: "needs_review", message: "<what needs review>")`;

/**
 * The prompt actually sent to the job agent: the task plus reporting rules.
 * `setupArtifacts` are the paths Mission Control placed in the worktree; the
 * agent is told to keep them out of its commits (a symlinked `node_modules`
 * is not matched by a `node_modules/` ignore rule).
 */
export function buildJobPrompt(prompt: string, autoCommit?: boolean, setupArtifacts: string[] = []): string {
  let fullPrompt = prompt + MC_REPORT_SUFFIX;
  if (autoCommit !== false) {
    fullPrompt += AUTO_COMMIT_SUFFIX;
  }
  if (setupArtifacts.length > 0) {
    fullPrompt += `\n\nThese paths were placed in your worktree by Mission Control and are not part of your task. Never stage or commit them: ${setupArtifacts.join(', ')}.`;
  }
  return fullPrompt;
}

export interface LaunchJobOptions {
  name: string;
  /** The task. Stored on the job as-is; reporting rules are appended before sending. */
  prompt: string;
  /** Branch for the job (defaults to `mc/{name}`). */
  branch?: string;
  /** Branch or ref the job's branch starts from; recorded as the job's base. */
  baseBranch?: string;
  /**
   * Commit or ref to branch from without recording it as the job's base
   * (plan jobs start from the integration branch or the plan's base commit).
   * Takes precedence over `baseBranch` for the worktree's start point.
   */
  startPoint?: string;
  agent?: string;
  /** "provider/model" or "provider/model#variant". */
  model?: string;
  copyFiles?: string[];
  symlinkDirs?: string[];
  commands?: string[];
  /** Plan this job belongs to. */
  planId?: string;
  /** Session that launched the job; receives its notifications. */
  launchSessionID?: string;
  /** Reuse a loaded config instead of reading it again. */
  config?: MCConfig;
  /**
   * Run in this existing worktree instead of creating one (used to relaunch a
   * plan job on its branch). A reused worktree is never removed on failure.
   */
  worktreePath?: string;
  /**
   * Replace finished jobs that have the same name instead of rejecting the
   * launch. Plan jobs are relaunched under their original name on retry.
   */
  replaceFinished?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Launch a job: create its worktree, start an OpenCode session in it, and
 * record the job. `mc_launch` and the plan orchestrator both go through here.
 *
 * Model: explicit `model` → `config.defaultModel` → the launching session's
 * current model → the session default. Agent: explicit `agent` →
 * `config.defaultAgent` → the session default.
 */
export async function launchJob(options: LaunchJobOptions): Promise<Job> {
  // The name becomes a branch, a directory and a session title.
  assertValidJobName(options.name);

  const sameName = (await loadJobState()).jobs.filter((job) => job.name === options.name);
  const blocking = options.replaceFinished
    ? sameName.find((job) => job.status === 'running')
    : sameName[0];
  if (blocking) {
    throw new Error(
      `Job "${options.name}" already exists (status: ${blocking.status}). Use a different name or cleanup the existing job first.`,
    );
  }

  const config = options.config ?? (await loadConfig());

  const jobId = randomUUID();
  const branch = options.branch ?? `mc/${options.name}`;
  const agent = options.agent ?? config.defaultAgent;
  const modelString =
    options.model ?? config.defaultModel ?? getCurrentModel(options.launchSessionID);
  const model = parseModel(modelString);
  if (modelString && !model) {
    throw new Error(
      `Invalid model "${modelString}" for job "${options.name}": expected "provider/model" or "provider/model#variant".`,
    );
  }

  const ownsWorktree = !options.worktreePath;
  let worktreePath: string;
  let recordedBase = options.baseBranch;
  let setupArtifacts: string[] | undefined;
  if (options.worktreePath) {
    worktreePath = options.worktreePath;
    // The worktree was set up by the run being replaced.
    setupArtifacts = sameName.find((job) => job.worktreePath === worktreePath)?.setupArtifacts;
  } else {
    const postCreate = resolvePostCreateHook(config.worktreeSetup, {
      copyFiles: options.copyFiles,
      symlinkDirs: options.symlinkDirs,
      commands: options.commands,
    });
    setupArtifacts = [...(postCreate.copyFiles ?? []), ...(postCreate.symlinkDirs ?? [])];

    // A standalone job with no explicit base forks from the branch currently
    // checked out. Record that branch so mc_diff, mc_merge and mc_pr compare
    // against what the job actually started from, not the repo default.
    if (!recordedBase && !options.startPoint && !options.planId) {
      const head = await gitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
      if (head.exitCode === 0 && head.stdout && head.stdout !== 'HEAD') {
        recordedBase = head.stdout;
      }
    }

    try {
      worktreePath = await createWorktree({
        branch,
        postCreate,
        startPoint: options.startPoint ?? options.baseBranch,
      });
    } catch (error) {
      throw new Error(
        `Failed to create worktree for branch "${branch}": ${errorMessage(error)}`,
      );
    }
  }

  let sessionID: string | undefined;
  try {
    sessionID = await startJobSession({
      jobId,
      jobName: options.name,
      worktreePath,
      prompt: buildJobPrompt(options.prompt, config.autoCommit, setupArtifacts),
      agent,
      model,
      planId: options.planId,
      launchSessionID: options.launchSessionID,
    });

    if (options.replaceFinished) {
      for (const stale of sameName) {
        await removeReport(stale.id).catch((error: unknown) => {
          console.warn(`[Mission Control] Failed to remove the report of replaced job ${stale.id}:`, error);
        });
        await removeJob(stale.id);
      }
    }

    const job: Job = {
      id: jobId,
      name: options.name,
      worktreePath,
      branch,
      baseBranch: recordedBase,
      status: 'running',
      prompt: options.prompt,
      createdAt: new Date().toISOString(),
      planId: options.planId,
      launchSessionID: options.launchSessionID,
      sessionID,
      agent,
      model: modelString,
      ...(setupArtifacts ? { setupArtifacts } : {}),
    };

    await addJob(job);
    return job;
  } catch (error) {
    if (sessionID) {
      await removeJobSession(sessionID).catch((removeError: unknown) => {
        console.warn(
          `[Mission Control] Failed to remove session ${sessionID} after a failed launch of job "${options.name}":`,
          removeError,
        );
      });
    }
    if (ownsWorktree) {
      await removeWorktree(worktreePath, true).catch((removeError: unknown) => {
        console.warn(
          `[Mission Control] Failed to remove worktree ${worktreePath} after a failed launch of job "${options.name}":`,
          removeError,
        );
      });
    }
    throw new Error(`Failed to launch job "${options.name}": ${errorMessage(error)}`);
  }
}
