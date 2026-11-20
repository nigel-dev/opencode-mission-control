import { join } from 'path';
import { existsSync, lstatSync, rmSync } from 'fs';
import type { JobSpec } from './plan-types';
import { gitCommand } from './git';
import { extractConflicts } from './utils';
import { promptJobSession } from './job-runtime';

export type MergeResult =
  | { success: true; mergedAt: string; testReport: MergeTestReport }
  | {
      success: false;
      type: 'conflict' | 'test_failure';
      files?: string[];
      output?: string;
      testReport?: MergeTestReport;
    };

type MergeSetupReport = {
  status: 'passed' | 'failed' | 'skipped';
  commands: string[];
  output?: string;
};

export type MergeTestReport = {
  status: 'passed' | 'failed' | 'skipped';
  command?: string;
  output?: string;
  timedOut?: boolean;
  reason?: string;
  setup: MergeSetupReport;
};

type MergeTrainConfig = {
  testCommand?: string;
  testTimeout?: number;
  mergeStrategy?: 'squash' | 'ff-only' | 'merge';
  setupCommands?: string[];
  fixBeforeRollbackTimeout?: number;
};

const DEFAULT_TEST_TIMEOUT_MS = 600000;
const DEFAULT_FIX_BEFORE_ROLLBACK_TIMEOUT_MS = 120000;

const INSTALL_COMMAND_BY_LOCKFILE = [
  { file: 'bun.lockb', command: 'bun install --frozen-lockfile' },
  { file: 'bun.lock', command: 'bun install --frozen-lockfile' },
  { file: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile' },
  { file: 'yarn.lock', command: 'yarn install --frozen-lockfile' },
  { file: 'package-lock.json', command: 'npm ci' },
  { file: 'npm-shrinkwrap.json', command: 'npm ci' },
] as const;



export async function validateTouchSet(
  jobBranch: string,
  baseBranch: string,
  touchSet: string[],
  opts?: { cwd?: string },
): Promise<{ valid: boolean; violations?: string[]; changedFiles?: string[] }> {
  if (touchSet.length === 0) {
    return { valid: true };
  }

  const diffResult = await gitCommand(['diff', '--name-only', `${baseBranch}...${jobBranch}`], opts);
  if (diffResult.exitCode !== 0) {
    return { valid: false, violations: [`Failed to diff: ${diffResult.stderr}`] };
  }

  const changedFiles = diffResult.stdout.split('\n').map(f => f.trim()).filter(Boolean);
  if (changedFiles.length === 0) {
    return { valid: true, changedFiles: [] };
  }

  const violations: string[] = [];
  for (const file of changedFiles) {
    const matchesAny = touchSet.some(pattern => {
      // Trailing slash means "this directory and everything inside it"
      const normalized = pattern.endsWith('/') ? `${pattern}**` : pattern;
      const glob = new Bun.Glob(normalized);
      return glob.match(file);
    });
    if (!matchesAny) {
      violations.push(file);
    }
  }

  return {
    valid: violations.length === 0,
    violations: violations.length > 0 ? violations : undefined,
    changedFiles,
  };
}

/**
 * Run a cleanup command whose exit code does not matter ("no merge to abort"
 * is not an error). Only a git that cannot be started at all is reported.
 */
async function cleanupGit(args: string[]): Promise<void> {
  try {
    await gitCommand(args);
  } catch (error) {
    console.warn(`[MergeTrain] Could not run git ${args.join(' ')}:`, error);
  }
}

export async function checkMergeability(
  integrationWorktree: string,
  jobBranch: string,
): Promise<{ canMerge: boolean; conflicts?: string[] }> {
  const testMerge = await gitCommand([
    '-C', integrationWorktree,
    'merge', '--no-commit', '--no-ff', jobBranch,
  ]);

  // Always clean up — leave worktree pristine
  await cleanupGit(['-C', integrationWorktree, 'merge', '--abort']);
  await cleanupGit(['-C', integrationWorktree, 'reset', '--hard', 'HEAD']);
  await cleanupGit(['-C', integrationWorktree, 'clean', '-fd']);

  if (testMerge.exitCode !== 0) {
    const conflicts = extractConflicts(
      [testMerge.stdout, testMerge.stderr].filter(Boolean).join('\n'),
    );
    return {
      canMerge: false,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    };
  }

  return { canMerge: true };
}

/** Whether a squash merge staged nothing (the job's branch adds no tracked changes). */
async function nothingStaged(worktreePath: string): Promise<boolean> {
  const diff = await gitCommand(['-C', worktreePath, 'diff', '--cached', '--quiet']);
  return diff.exitCode === 0;
}

function noChangesMerged(jobName: string): MergeResult {
  const reason = `Job ${jobName} added no tracked changes; nothing to merge`;
  return {
    success: true,
    mergedAt: new Date().toISOString(),
    testReport: {
      status: 'skipped',
      reason,
      setup: { status: 'skipped', commands: [] },
    },
  };
}

async function rollbackMerge(worktreePath: string): Promise<void> {
  // Try merge --abort first
  await cleanupGit(['-C', worktreePath, 'merge', '--abort']);

  // Always reset the index and working tree to be safe
  await cleanupGit(['-C', worktreePath, 'reset', '--hard', 'HEAD']);
  await cleanupGit(['-C', worktreePath, 'clean', '-fd']);
}

async function rollbackMergeToHead(worktreePath: string, targetHead: string): Promise<void> {
  // Try merge --abort first
  await cleanupGit(['-C', worktreePath, 'merge', '--abort']);

  // Reset to the target HEAD
  await cleanupGit(['-C', worktreePath, 'reset', '--hard', targetHead]);
  await cleanupGit(['-C', worktreePath, 'clean', '-fd']);
}

type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

const PACKAGE_MANAGER_BY_LOCKFILE: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
];

const TEST_COMMAND_BY_MANAGER: Record<PackageManager, string> = {
  bun: 'bun run test',
  pnpm: 'pnpm test',
  yarn: 'yarn test',
  npm: 'npm test',
};

/** The project's package manager: from its lockfile, then `packageManager`, then npm. */
async function detectPackageManager(
  worktreePath: string,
  packageJson: { packageManager?: unknown },
): Promise<PackageManager> {
  for (const entry of PACKAGE_MANAGER_BY_LOCKFILE) {
    if (await Bun.file(join(worktreePath, entry.file)).exists()) {
      return entry.manager;
    }
  }

  const declared = typeof packageJson.packageManager === 'string' ? packageJson.packageManager.toLowerCase() : '';
  for (const manager of ['bun', 'pnpm', 'yarn', 'npm'] as const) {
    if (declared.startsWith(`${manager}@`)) {
      return manager;
    }
  }
  return 'npm';
}

/**
 * The command that runs the project's `test` script, or null when it has none.
 * The script runs through the package manager (`bun run test`, `npm test`, ...)
 * so binaries in `node_modules/.bin` resolve; its raw text is never executed.
 */
export async function detectTestCommand(worktreePath: string): Promise<string | null> {
  let packageJson: { scripts?: Record<string, unknown>; packageManager?: unknown };
  try {
    const packageJsonFile = Bun.file(join(worktreePath, 'package.json'));
    if (!(await packageJsonFile.exists())) {
      return null;
    }
    packageJson = JSON.parse(await packageJsonFile.text());
  } catch (error) {
    console.warn(`[MergeTrain] Could not read package.json in ${worktreePath}; no test command detected:`, error);
    return null;
  }

  const testScript = packageJson.scripts?.test;
  if (typeof testScript !== 'string' || testScript.trim() === '') {
    return null;
  }

  return TEST_COMMAND_BY_MANAGER[await detectPackageManager(worktreePath, packageJson)];
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
  } catch (error) {
    console.warn(`[MergeTrain] Could not detect an install command in ${worktreePath}:`, error);
    return null;
  }
}

/** Kill a command and everything it started. The command leads its own process group. */
function killProcessGroup(proc: { pid: number; kill: (signal?: number | NodeJS.Signals) => void }): void {
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch (error) {
    // No such group (the command already exited) or no permission to signal
    // it: fall back to the command itself.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.warn(`[MergeTrain] Could not kill process group ${proc.pid}:`, error);
    }
    proc.kill('SIGKILL');
  }
}

export async function runTestCommand(
  worktreePath: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ success: boolean; output: string; timedOut: boolean; aborted: boolean }> {
  if (signal?.aborted) {
    return { success: false, output: '', timedOut: false, aborted: true };
  }

  // Detached: the shell leads its own process group, so a timeout can kill the
  // test runner's children too. Killing only `sh` leaves them running and
  // holding the output pipes open, which would hang this call.
  const proc = Bun.spawn(['sh', '-c', command], {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  let timedOut = false;
  let aborted = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    killProcessGroup(proc);
  }, timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    killProcessGroup(proc);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);
  signal?.removeEventListener('abort', onAbort);

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');

  return {
    success: !timedOut && !aborted && exitCode === 0,
    output,
    timedOut,
    aborted,
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
  } catch {
    // lstat throws when the path does not exist at all: that is 'missing'.
  }

  return 'missing';
}

async function ensureTestDependencies(
  worktreePath: string,
  timeoutMs: number,
  setupCommands?: string[],
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  commands: string[];
  status: 'passed' | 'failed' | 'skipped';
}> {
  const configuredSetupCommands = normalizeCommands(setupCommands);
  if (configuredSetupCommands.length > 0) {
    for (const command of configuredSetupCommands) {
      const setupResult = await runTestCommand(worktreePath, command, timeoutMs, signal);
      if (setupResult.success) {
        continue;
      }

      const prefix = setupResult.timedOut
        ? `Dependency setup command timed out after ${timeoutMs}ms`
        : 'Dependency setup command failed';

      return {
        ...setupResult,
        commands: configuredSetupCommands,
        status: 'failed',
        output: setupResult.output
          ? `${prefix} (${command})\n${setupResult.output}`
          : `${prefix} (${command})`,
      };
    }

    return {
      success: true,
      output: '',
      timedOut: false,
      aborted: false,
      commands: configuredSetupCommands,
      status: 'passed',
    };
  }

  const installCommand = await detectInstallCommand(worktreePath);
  if (!installCommand) {
    return {
      success: true,
      output: '',
      timedOut: false,
      aborted: false,
      commands: [],
      status: 'skipped',
    };
  }

  const nodeModulesStatus = getNodeModulesStatus(worktreePath);
  if (nodeModulesStatus === 'present') {
    return {
      success: true,
      output: '',
      timedOut: false,
      aborted: false,
      commands: [],
      status: 'skipped',
    };
  }

  if (nodeModulesStatus === 'dangling_symlink') {
    rmSync(join(worktreePath, 'node_modules'), {
      force: true,
      recursive: true,
    });
  }

  const installResult = await runTestCommand(worktreePath, installCommand, timeoutMs, signal);
  if (installResult.success) {
    return {
      ...installResult,
      commands: [installCommand],
      status: 'passed',
    };
  }

  const prefix = installResult.timedOut
    ? `Dependency install timed out after ${timeoutMs}ms`
    : 'Dependency install failed';

  return {
    ...installResult,
    commands: [installCommand],
    status: 'failed',
    output: installResult.output
      ? `${prefix} (${installCommand})\n${installResult.output}`
      : `${prefix} (${installCommand})`,
  };
}

export class MergeTrain {
  private queue: JobSpec[] = [];
  private readonly abortController = new AbortController();

  constructor(
    private readonly integrationWorktree: string,
    private readonly config?: MergeTrainConfig,
  ) {}

  enqueue(job: JobSpec): void {
    if (this.stopped) {
      return;
    }
    this.queue.push(job);
  }

  /**
   * Stop for good: drop queued jobs, refuse new ones, and abort a setup or
   * test command that is running. The merge in progress is rolled back.
   */
  stop(): void {
    this.queue = [];
    this.abortController.abort();
  }

  get stopped(): boolean {
    return this.abortController.signal.aborted;
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
    const signal = this.abortController.signal;

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

      // A job whose work is all in untracked or ignored files (shared through
      // a symlinked directory, say) has nothing to merge: a no-op, not an error.
      if (await nothingStaged(this.integrationWorktree)) {
        return noChangesMerged(job.name);
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

      // A job whose work is all in untracked or ignored files (shared through
      // a symlinked directory, say) has nothing to merge: a no-op, not an error.
      if (await nothingStaged(this.integrationWorktree)) {
        return noChangesMerged(job.name);
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
        testReport: {
          status: 'skipped',
          reason: 'No test command configured or detected',
          setup: {
            status: 'skipped',
            commands: [],
          },
        },
      };
    }

    const timeoutMs = this.config?.testTimeout ?? DEFAULT_TEST_TIMEOUT_MS;
    const dependencySetupResult = await ensureTestDependencies(
      this.integrationWorktree,
      timeoutMs,
      this.config?.setupCommands,
      signal,
    );

    if (!dependencySetupResult.success) {
      await rollbackMergeToHead(this.integrationWorktree, headBeforeStr);
      return {
        success: false,
        type: 'test_failure',
        output: dependencySetupResult.output,
        testReport: {
          status: 'skipped',
          command: testCommand,
          reason: 'Dependency setup failed before tests could run',
          setup: {
            status: dependencySetupResult.status,
            commands: dependencySetupResult.commands,
            output: dependencySetupResult.output,
          },
        },
      };
    }

    const testResult = await runTestCommand(this.integrationWorktree, testCommand, timeoutMs, signal);

    if (testResult.aborted) {
      await rollbackMergeToHead(this.integrationWorktree, headBeforeStr);
      return {
        success: false,
        type: 'test_failure',
        output: 'The merge train was stopped before the tests finished',
      };
    }

    if (testResult.timedOut) {
      await rollbackMergeToHead(this.integrationWorktree, headBeforeStr);
      return {
        success: false,
        type: 'test_failure',
        output: `Test timed out after ${timeoutMs}ms`,
        testReport: {
          status: 'failed',
          command: testCommand,
          timedOut: true,
          output: testResult.output,
          reason: `Test timed out after ${timeoutMs}ms`,
          setup: {
            status: dependencySetupResult.status,
            commands: dependencySetupResult.commands,
            output: dependencySetupResult.output || undefined,
          },
        },
      };
    }

    if (!testResult.success) {
      const fixTimeout = this.config?.fixBeforeRollbackTimeout ?? DEFAULT_FIX_BEFORE_ROLLBACK_TIMEOUT_MS;
      const hasSession = job.sessionID !== undefined;

      if (hasSession && fixTimeout > 0) {
        const fixPrompt = this.buildFixPrompt(job.name, testCommand, testResult.output);
        const fixPrompted = await this.promptAgentForFix(job, fixPrompt);

        if (fixPrompted) {
          await this.sleep(fixTimeout, signal);

          const retestResult = await runTestCommand(this.integrationWorktree, testCommand, timeoutMs, signal);

          if (retestResult.success) {
            return {
              success: true,
              mergedAt: new Date().toISOString(),
              testReport: {
                status: 'passed',
                command: testCommand,
                output: retestResult.output || undefined,
                setup: {
                  status: dependencySetupResult.status,
                  commands: dependencySetupResult.commands,
                  output: dependencySetupResult.output || undefined,
                },
              },
            };
          }
        }
      }

      await rollbackMergeToHead(this.integrationWorktree, headBeforeStr);
      return {
        success: false,
        type: 'test_failure',
        output: testResult.output,
        testReport: {
          status: 'failed',
          command: testCommand,
          output: testResult.output,
          setup: {
            status: dependencySetupResult.status,
            commands: dependencySetupResult.commands,
            output: dependencySetupResult.output || undefined,
          },
        },
      };
    }

    return {
      success: true,
      mergedAt: new Date().toISOString(),
      testReport: {
        status: 'passed',
        command: testCommand,
        output: testResult.output || undefined,
        setup: {
          status: dependencySetupResult.status,
          commands: dependencySetupResult.commands,
          output: dependencySetupResult.output || undefined,
        },
      },
    };
  }

  private buildFixPrompt(jobName: string, testCommand: string, testOutput: string): string {
    return `[AUTO-GENERATED] Test Failure in Merge Train

Job "${jobName}" failed during merge train testing.

Test Command: ${testCommand}

Test Output:
${testOutput.slice(0, 2000)}

Please fix the failing tests. You have a limited time window to apply fixes before the merge is rolled back. Focus on the most critical failures first.`;
  }

  private async promptAgentForFix(job: JobSpec, prompt: string): Promise<boolean> {
    if (!job.sessionID) {
      return false;
    }

    try {
      await promptJobSession(job.sessionID, prompt);
      return true;
    } catch (error) {
      console.warn(`[MergeTrain] Could not prompt job "${job.name}" for a fix:`, error);
      return false;
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
