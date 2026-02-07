import { tool, type ToolDefinition } from '@opencode-ai/plugin';
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

    // 2. Determine PR title (default to job prompt)
    const prTitle = args.title || job.prompt;

    // 3. Build gh pr create arguments
    const ghArgs: string[] = [
      '--title', prTitle,
      '--head', job.branch,
    ];

    // 4. Add optional body
    if (args.body) {
      ghArgs.push('--body', args.body);
    }

    // 5. Add draft flag if specified
    if (args.draft) {
      ghArgs.push('--draft');
    }

    // 6. Execute gh pr create
    const prUrl = await executeGhCommand(ghArgs);

    return prUrl;
  },
});
