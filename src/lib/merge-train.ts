import { join } from 'path';
import type { JobSpec } from './plan-types';
import { gitCommand } from './git';
import { getIntegrationWorktree } from './integration';

export type MergeResult =
  | { success: true; mergedAt: string }
  | {
      success: false;
      type: 'conflict' | 'test_failure';
      files?: string[];
      output?: string;
    };

type MergeTrainConfig = {
  testCommand?: string;
  testTimeout?: number;
};

const DEFAULT_TEST_TIMEOUT_MS = 600000;

function extractConflicts(stderr: string): string[] {
  const conflicts: string[] = [];
  const lines = stderr.split('\n');

  for (const line of lines) {
    const conflictMatch = line.match(/CONFLICT \(.*?\): (?:Merge conflict in )?(.+)/);
    if (conflictMatch) {
      conflicts.push(conflictMatch[1]);
    }
  }

  if (conflicts.length > 0) {
    return conflicts;
  }

  const fallback = stderr.trim();
  return fallback ? [fallback] : [];
}

async function rollbackMerge(worktreePath: string): Promise<void> {
  const abortResult = await gitCommand(['-C', worktreePath, 'merge', '--abort']);
  if (abortResult.exitCode === 0) {
    return;
  }

  await gitCommand(['-C', worktreePath, 'reset', '--hard', 'HEAD~1']);
}

export async function detectTestCommand(worktreePath: string): Promise<string | null> {
  try {
    const packageJsonFile = Bun.file(join(worktreePath, 'package.json'));
    if (!(await packageJsonFile.exists())) {
      return null;
    }

    const packageJson = JSON.parse(await packageJsonFile.text()) as {
      scripts?: Record<string, unknown>;
    };

    const testScript = packageJson.scripts?.test;
    return typeof testScript === 'string' && testScript.trim() !== ''
      ? testScript
      : null;
  } catch {
    return null;
  }
}

export async function runTestCommand(
  worktreePath: string,
  command: string,
  timeoutMs: number,
): Promise<{ success: boolean; output: string; timedOut: boolean }> {
  const proc = Bun.spawn(['sh', '-c', command], {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');

  return {
    success: !timedOut && exitCode === 0,
    output,
    timedOut,
  };
}

export class MergeTrain {
  private queue: JobSpec[] = [];

  constructor(
    private readonly integrationWorktree: string,
    private readonly config?: MergeTrainConfig,
  ) {}

  static async forPlan(planId: string, config?: MergeTrainConfig): Promise<MergeTrain> {
    const integrationWorktree = await getIntegrationWorktree(planId);
    return new MergeTrain(integrationWorktree, config);
  }

  enqueue(job: JobSpec): void {
    this.queue.push(job);
  }

  getQueue(): JobSpec[] {
    return [...this.queue];
  }

  clear(): void {
    this.queue = [];
  }

  async processNext(): Promise<MergeResult> {
    if (this.queue.length === 0) {
      throw new Error('No jobs in queue');
    }

    const job = this.queue.shift()!;

    if (!job.branch) {
      return {
        success: false,
        type: 'test_failure',
        output: `Job ${job.name} has no branch`,
      };
    }

    const mergeResult = await gitCommand([
      '-C',
      this.integrationWorktree,
      'merge',
      '--no-ff',
      job.branch,
    ]);

    if (mergeResult.exitCode !== 0) {
      const conflicts = extractConflicts(
        [mergeResult.stdout, mergeResult.stderr].filter(Boolean).join('\n'),
      );
      await gitCommand(['-C', this.integrationWorktree, 'merge', '--abort']).catch(() => {});

      return {
        success: false,
        type: 'conflict',
        files: conflicts.length > 0 ? conflicts : undefined,
      };
    }

    const testCommand = this.config?.testCommand
      ? this.config.testCommand
      : await detectTestCommand(this.integrationWorktree);

    if (!testCommand) {
      console.warn(
        `No test command found in ${this.integrationWorktree}/package.json. Skipping test gating.`,
      );
      return {
        success: true,
        mergedAt: new Date().toISOString(),
      };
    }

    const timeoutMs = this.config?.testTimeout ?? DEFAULT_TEST_TIMEOUT_MS;
    const testResult = await runTestCommand(this.integrationWorktree, testCommand, timeoutMs);

    if (testResult.timedOut) {
      await rollbackMerge(this.integrationWorktree);
      return {
        success: false,
        type: 'test_failure',
        output: `Test timed out after ${timeoutMs}ms`,
      };
    }

    if (!testResult.success) {
      await rollbackMerge(this.integrationWorktree);
      return {
        success: false,
        type: 'test_failure',
        output: testResult.output,
      };
    }

    return {
      success: true,
      mergedAt: new Date().toISOString(),
    };
  }

  async processAll(): Promise<Array<{ job: JobSpec; result: MergeResult }>> {
    const results: Array<{ job: JobSpec; result: MergeResult }> = [];

    while (this.queue.length > 0) {
      const job = this.queue[0];
      const result = await this.processNext();
      results.push({ job, result });
    }

    return results;
  }
}
