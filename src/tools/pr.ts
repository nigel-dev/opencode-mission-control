import { existsSync } from 'fs';
import { z } from 'zod';
import { loadPrTemplate } from '../lib/pr-template';
import { getDefaultBranch } from '../lib/git';
import { getJobByName, type Job } from '../lib/job-state';
import { assertToolPermission, type ToolCallContext } from '../lib/job-runtime';
import { getProjectDirectory } from '../lib/project-context';

export async function executeGhCommand(args: string[]): Promise<string> {
  const proc = Bun.spawn(['gh', 'pr', 'create', ...args], {
    cwd: getProjectDirectory(),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`gh pr create failed: ${stderr || stdout}`);
  }

  return stdout.trim();
}

function buildDefaultBody(job: Job): string {
  return [
    '## Summary',
    '',
    job.prompt,
    '',
    '## Changes',
    '',
    `Branch: \`${job.branch}\``,
    '',
    '---',
    '',
    '🚀 *Created by [Mission Control](https://github.com/nigel-dev/opencode-mission-control)*',
  ].join('\n');
}

export const mc_pr = {
  name: 'mc_pr',
  description: 'Create a pull request from a job\'s branch',
  input: z.object({
    name: z.string().describe('Job name'),
    title: z.string().optional().describe('PR title — use Conventional Commits format (e.g. "feat: add login", "fix: resolve timeout"). Defaults to job name.'),
    body: z.string().optional().describe('PR body (defaults to PR template or generated summary)'),
    draft: z.boolean().optional().describe('Create as draft PR'),
    baseBranch: z.string().optional().describe('Target branch for the PR (defaults to the job\'s base branch, or the repo default branch)'),
  }).strict(),
  async execute(
    args: { name: string; title?: string; body?: string; draft?: boolean; baseBranch?: string },
    context?: ToolCallContext,
  ) {
    // 1. Get job by name
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    // Pushing and opening a PR publishes the user's code: ask first.
    await assertToolPermission(context, 'mission-control.pr', [job.branch]);

    // The job's worktree when it still exists (it has the PR template of the
    // branch), otherwise the project itself. Never the server's own cwd.
    const cwd = job.worktreePath && existsSync(job.worktreePath) ? job.worktreePath : getProjectDirectory();

    // 2. Push branch to remote before creating PR
    const pushProc = Bun.spawn(['git', 'push', 'origin', job.branch], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [, pushStderr, pushExitCode] = await Promise.all([
      new Response(pushProc.stdout).text(),
      new Response(pushProc.stderr).text(),
      pushProc.exited,
    ]);
    if (pushExitCode !== 0) {
      throw new Error(`Failed to push branch "${job.branch}": ${pushStderr}`);
    }

    // 3. Determine PR title (conventional commit format)
    const prTitle = args.title || job.name;

    // 4. Build gh pr create arguments
    const baseBranch = args.baseBranch ?? job.baseBranch ?? await getDefaultBranch(cwd);
    const ghArgs: string[] = [
      '--title', prTitle,
      '--head', job.branch,
      '--base', baseBranch,
    ];

    // 5. Build PR body — use explicit body, or fall back to default
    const mcAttribution = '\n\n---\n\n🚀 *Created by [Mission Control](https://github.com/nigel-dev/opencode-mission-control)*';
    if (args.body) {
      ghArgs.push('--body', args.body + mcAttribution);
    } else {
      const template = await loadPrTemplate(cwd);
      if (template) {
        ghArgs.push('--body', template + mcAttribution);
      } else {
        ghArgs.push('--body', buildDefaultBody(job));
      }
    }

    // 6. Add draft flag if specified
    if (args.draft) {
      ghArgs.push('--draft');
    }

    // 7. Execute gh pr create
    const prUrl = await executeGhCommand(ghArgs);

    return { content: prUrl };
  },
};
