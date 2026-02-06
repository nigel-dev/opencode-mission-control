import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName } from '../lib/job-state';

async function executeGitDiff(
  worktreePath: string,
  branch: string,
  stat: boolean = false,
): Promise<string> {
  const baseProc = Bun.spawn(['git', '-C', worktreePath, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const baseOutput = await new Response(baseProc.stdout).text();
  const baseExitCode = await baseProc.exited;

  let baseBranch = 'main';
  if (baseExitCode === 0) {
    const match = baseOutput.trim().match(/origin\/(.+)/);
    if (match) {
      baseBranch = match[1];
    }
  }

  const args = ['-C', worktreePath, 'diff'];
  if (stat) {
    args.push('--stat');
  }
  args.push(`origin/${baseBranch}..${branch}`);

  const diffProc = Bun.spawn(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(diffProc.stdout).text();
  const stderr = await new Response(diffProc.stderr).text();
  const exitCode = await diffProc.exited;

  if (exitCode !== 0) {
    throw new Error(`git diff failed: ${stderr || stdout}`);
  }

  return stdout;
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
    const diff = await executeGitDiff(job.worktreePath, job.branch, args.stat);

    // 3. Return diff output
    return diff || '(no changes)';
  },
});
