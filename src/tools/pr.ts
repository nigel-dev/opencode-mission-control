import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getDefaultBranch } from '../lib/git';
import { getJobByName } from '../lib/job-state';

export async function executeGhCommand(args: string[]): Promise<string> {
  const proc = Bun.spawn(['gh', 'pr', 'create', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`gh pr create failed: ${stderr || stdout}`);
  }

  return stdout.trim();
}

export const mc_pr: ToolDefinition = tool({
  description: 'Create a pull request from a job\'s branch',
  args: {
    name: tool.schema
      .string()
      .describe('Job name'),
    title: tool.schema
      .string()
      .optional()
      .describe('PR title (defaults to job prompt)'),
    body: tool.schema
      .string()
      .optional()
      .describe('PR body'),
    draft: tool.schema
      .boolean()
      .optional()
      .describe('Create as draft PR'),
  },
  async execute(args) {
    // 1. Get job by name
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    // 2. Push branch to remote before creating PR
    const pushProc = Bun.spawn(['git', 'push', 'origin', job.branch], {
      cwd: job.worktreePath || undefined,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const pushStderr = await new Response(pushProc.stderr).text();
    const pushExitCode = await pushProc.exited;
    if (pushExitCode !== 0) {
      throw new Error(`Failed to push branch "${job.branch}": ${pushStderr}`);
    }

    // 3. Determine PR title (default to job prompt)
    const prTitle = args.title || job.prompt;

    // 4. Build gh pr create arguments
    const defaultBranch = await getDefaultBranch(job.worktreePath);
    const ghArgs: string[] = [
      '--title', prTitle,
      '--head', job.branch,
      '--base', defaultBranch,
    ];

    // 5. Add optional body
    if (args.body) {
      ghArgs.push('--body', args.body);
    }

    // 6. Add draft flag if specified
    if (args.draft) {
      ghArgs.push('--draft');
    }

    // 7. Execute gh pr create
    const prUrl = await executeGhCommand(ghArgs);

    return prUrl;
  },
});
