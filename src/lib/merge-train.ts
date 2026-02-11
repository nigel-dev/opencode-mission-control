import { join } from 'path';
import { existsSync, lstatSync, rmSync } from 'fs';
import type { JobSpec } from './plan-types';
import { gitCommand } from './git';
import { getIntegrationWorktree } from './integration';
import { extractConflicts } from './utils';

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
  mergeStrategy?: 'squash' | 'ff-only' | 'merge';
  setupCommands?: string[];
};

const DEFAULT_TEST_TIMEOUT_MS = 600000;

const INSTALL_COMMAND_BY_LOCKFILE = [
  { file: 'bun.lockb', command: 'bun install --frozen-lockfile' },
  { file: 'bun.lock', command: 'bun install --frozen-lockfile' },
  { file: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile' },
  { file: 'yarn.lock', command: 'yarn install --frozen-lockfile' },
  { file: 'package-lock.json', command: 'npm ci' },
  { file: 'npm-shrinkwrap.json', command: 'npm ci' },
] as const;



async function rollbackMerge(worktreePath: string): Promise<void> {
  // Try merge --abort first
  await gitCommand(['-C', worktreePath, 'merge', '--abort']).catch(() => {});

  // Always reset the index and working tree to be safe
  await gitCommand(['-C', worktreePath, 'reset', '--hard', 'HEAD']).catch(() => {});
  await gitCommand(['-C', worktreePath, 'clean', '-fd']).catch(() => {});
}

async function rollbackMergeToHead(worktreePath: string, targetHead: string): Promise<void> {
  // Try merge --abort first
  await gitCommand(['-C', worktreePath, 'merge', '--abort']).catch(() => {});

  // Reset to the target HEAD
  await gitCommand(['-C', worktreePath, 'reset', '--hard', targetHead]).catch(() => {});
  await gitCommand(['-C', worktreePath, 'clean', '-fd']).catch(() => {});
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

export async function detectInstallCommand(worktreePath: string): Promise<string | null> {
  try {
    for (const entry of INSTALL_COMMAND_BY_LOCKFILE) {
      const lockfile = Bun.file(join(worktreePath, entry.file));
      if (await lockfile.exists()) {
        return entry.command;
      }
    }

    const packageJsonFile = Bun.file(join(worktreePath, 'package.json'));
    if (!(await packageJsonFile.exists())) {
      return null;
    }

    const packageJson = JSON.parse(await packageJsonFile.text()) as {
      packageManager?: string;
    };
    const packageManager = packageJson.packageManager?.toLowerCase() ?? '';
    if (packageManager.startsWith('bun@')) {
      return 'bun install';
    }
    if (packageManager.startsWith('pnpm@')) {
      return 'pnpm install';
    }
    if (packageManager.startsWith('yarn@')) {
      return 'yarn install';
    }

    return null;
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

function normalizeCommands(commands?: string[]): string[] {
  if (!commands) {
    return [];
  }
  return [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
}

function getNodeModulesStatus(worktreePath: string): 'present' | 'missing' | 'dangling_symlink' {
  const nodeModulesPath = join(worktreePath, 'node_modules');
  if (existsSync(nodeModulesPath)) {
    return 'present';
  }

  try {
    const stat = lstatSync(nodeModulesPath);
    if (stat.isSymbolicLink()) {
      return 'dangling_symlink';
    }
  } catch {}

  return 'missing';
}

async function ensureTestDependencies(
  worktreePath: string,
  timeoutMs: number,
  setupCommands?: string[],
): Promise<{ success: boolean; output: string; timedOut: boolean }> {
  const configuredSetupCommands = normalizeCommands(setupCommands);
  if (configuredSetupCommands.length > 0) {
    for (const command of configuredSetupCommands) {
      const setupResult = await runTestCommand(worktreePath, command, timeoutMs);
      if (setupResult.success) {
        continue;
      }

      const prefix = setupResult.timedOut
        ? `Dependency setup command timed out after ${timeoutMs}ms`
        : 'Dependency setup command failed';

      return {
        ...setupResult,
        output: setupResult.output
          ? `${prefix} (${command})\n${setupResult.output}`
          : `${prefix} (${command})`,
      };
    }

    return {
      success: true,
      output: '',
      timedOut: false,
    };
  }

  const installCommand = await detectInstallCommand(worktreePath);
  if (!installCommand) {
    return {
      success: true,
      output: '',
      timedOut: false,
    };
  }

  const nodeModulesStatus = getNodeModulesStatus(worktreePath);
  if (nodeModulesStatus === 'present') {
    return {
      success: true,
      output: '',
      timedOut: false,
    };
  }

  if (nodeModulesStatus === 'dangling_symlink') {
    rmSync(join(worktreePath, 'node_modules'), {
      force: true,
      recursive: true,
    });
  }

  const installResult = await runTestCommand(worktreePath, installCommand, timeoutMs);
  if (installResult.success) {
    return installResult;
  }

  const prefix = installResult.timedOut
    ? `Dependency install timed out after ${timeoutMs}ms`
    : 'Dependency install failed';

  return {
    ...installResult,
    output: installResult.output
      ? `${prefix} (${installCommand})\n${installResult.output}`
      : `${prefix} (${installCommand})`,
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

    // Save the HEAD before the merge so we can rollback if needed
    const headBeforeMerge = await gitCommand(['-C', this.integrationWorktree, 'rev-parse', 'HEAD']);
    const headBeforeStr = headBeforeMerge.stdout.trim();

    const mergeStrategy = this.config?.mergeStrategy ?? 'squash';
    let mergeResult;

    if (mergeStrategy === 'squash') {
      // Squash: merge --squash then commit
      mergeResult = await gitCommand([
        '-C',
        this.integrationWorktree,
        'merge',
        '--squash',
        job.branch,
      ]);

      if (mergeResult.exitCode !== 0) {
        const conflicts = extractConflicts(
          [mergeResult.stdout, mergeResult.stderr].filter(Boolean).join('\n'),
        );
        await rollbackMerge(this.integrationWorktree);

        return {
          success: false,
          type: 'conflict',
          files: conflicts.length > 0 ? conflicts : undefined,
        };
      }

      // Commit the squashed changes
      const commitResult = await gitCommand([
        '-C',
        this.integrationWorktree,
        'commit',
        '-m',
        `Merge ${job.name}`,
      ]);

      if (commitResult.exitCode !== 0) {
        await rollbackMerge(this.integrationWorktree);
        return {
          success: false,
          type: 'test_failure',
          output: `Failed to commit squashed merge: ${commitResult.stderr || commitResult.stdout}`,
        };
      }
    } else if (mergeStrategy === 'ff-only') {
      // FF-only in merge train context: treat as squash since integration branch accumulates merges
      mergeResult = await gitCommand([
        '-C',
        this.integrationWorktree,
        'merge',
        '--squash',
        job.branch,
      ]);

      if (mergeResult.exitCode !== 0) {
        const conflicts = extractConflicts(
          [mergeResult.stdout, mergeResult.stderr].filter(Boolean).join('\n'),
        );
        await rollbackMerge(this.integrationWorktree);

        return {
          success: false,
          type: 'conflict',
          files: conflicts.length > 0 ? conflicts : undefined,
        };
      }

      // Commit the squashed changes
      const commitResult = await gitCommand([
        '-C',
        this.integrationWorktree,
        'commit',
        '-m',
        `Merge ${job.name}`,
      ]);

      if (commitResult.exitCode !== 0) {
        await rollbackMerge(this.integrationWorktree);
        return {
          success: false,
          type: 'test_failure',
          output: `Failed to commit squashed merge: ${commitResult.stderr || commitResult.stdout}`,
        };
      }
    } else {
      // Merge: standard merge with --no-ff to create merge commit
      mergeResult = await gitCommand([
        '-C',
        this.integrationWorktree,
        'merge',
        '--no-ff',
        '-m',
        `Merge ${job.name}`,
        job.branch,
      ]);

      if (mergeResult.exitCode !== 0) {
        const conflicts = extractConflicts(
          [mergeResult.stdout, mergeResult.stderr].filter(Boolean).join('\n'),
        );
        await rollbackMerge(this.integrationWorktree);

        return {
          success: false,
          type: 'conflict',
          files: conflicts.length > 0 ? conflicts : undefined,
        };
      }
    }

    const testCommand = this.config?.testCommand
      ? this.config.testCommand
      : await detectTestCommand(this.integrationWorktree);

    if (!testCommand) {
      console.warn(
        `No test command configured or detected in ${this.integrationWorktree}. Skipping test gating.`,
      );
      return {
        success: true,
        mergedAt: new Date().toISOString(),
      };
    }

    const timeoutMs = this.config?.testTimeout ?? DEFAULT_TEST_TIMEOUT_MS;
    const dependencySetupResult = await ensureTestDependencies(
      this.integrationWorktree,
      timeoutMs,
      this.config?.setupCommands,
    );

    if (!dependencySetupResult.success) {
      await rollbackMergeToHead(this.integrationWorktree, headBeforeStr);
      return {
        success: false,
        type: 'test_failure',
        output: dependencySetupResult.output,
      };
    }

    const testResult = await runTestCommand(this.integrationWorktree, testCommand, timeoutMs);

    if (testResult.timedOut) {
      await rollbackMergeToHead(this.integrationWorktree, headBeforeStr);
      return {
        success: false,
        type: 'test_failure',
        output: `Test timed out after ${timeoutMs}ms`,
      };
    }

    if (!testResult.success) {
      await rollbackMergeToHead(this.integrationWorktree, headBeforeStr);
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
