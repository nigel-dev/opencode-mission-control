import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName } from '../lib/job-state';
import { gitCommand } from '../lib/git';

async function executeGitDiff(
  worktreePath: string,
  branch: string,
  stat: boolean = false,
  baseBranch?: string,
): Promise<string> {
  let base: string;
  if (baseBranch) {
    base = baseBranch;
  } else {
    const baseResult = await gitCommand(
      ['rev-parse', '--abbrev-ref', 'origin/HEAD'],
      { cwd: worktreePath },
    );
    base = 'main';
    if (baseResult.exitCode === 0) {
      const match = baseResult.stdout.match(/origin\/(.+)/);
      if (match) {
        base = match[1];
      }
    }
  }

  const args = ['diff'];
  if (stat) {
    args.push('--stat');
  }
  args.push(`origin/${base}..${branch}`);

  const diffResult = await gitCommand(args, { cwd: worktreePath });

  if (diffResult.exitCode !== 0) {
    throw new Error(`git diff failed: ${diffResult.stderr || diffResult.stdout}`);
  }

  return diffResult.stdout;
}

export const mc_diff: ToolDefinition = tool({
  description: 'Show changes in a job\'s branch compared to base',
  args: {
    name: tool.schema
      .string()
      .describe('Job name'),
    stat: tool.schema
      .boolean()
      .optional()
      .describe('Show diffstat only'),
  },
  async execute(args) {
    // 1. Get job by name
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    // 2. Execute git diff
    const diff = await executeGitDiff(job.worktreePath, job.branch, args.stat, job.baseBranch);

    // 3. Return diff output
    return diff || '(no changes)';
  },
});
