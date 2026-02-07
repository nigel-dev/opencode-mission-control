import { join } from 'path';

export interface TestResult {
  success: boolean;
  output: string;
  timedOut: boolean;
}

/**
 * Detect test command from package.json in the given worktree path.
 * Returns the test command string, or null if not found.
 */
export async function detectTestCommand(worktreePath: string): Promise<string | null> {
  try {
    const packageJsonPath = join(worktreePath, 'package.json');
    const file = Bun.file(packageJsonPath);
    const exists = await file.exists();

    if (!exists) {
      return null;
    }

    const content = await file.text();
    const packageJson = JSON.parse(content) as { scripts?: Record<string, string> };

    if (!packageJson.scripts || !packageJson.scripts.test) {
      return null;
    }

    return packageJson.scripts.test;
  } catch {
    // Handle errors gracefully: file not found, invalid JSON, etc.
    return null;
  }
}

/**
 * Run tests in the given worktree path.
 * Uses provided command, or auto-detects from package.json.
 * If no command found, returns success with skip message.
 * Respects timeout: kills process if it exceeds timeoutMs.
 */
export async function runTests(
  worktreePath: string,
  command?: string,
  timeoutMs?: number
): Promise<TestResult> {
  let testCommand = command;
  if (!testCommand) {
    const detected = await detectTestCommand(worktreePath);
    testCommand = detected ?? undefined;
  }

  // If no test command found, skip tests
  if (!testCommand) {
    return {
      success: true,
      output: 'No test command configured',
      timedOut: false,
    };
  }

  // Default timeout: 10 minutes
  const timeout = timeoutMs ?? 600000;

  try {
    // Spawn test process
    const proc = Bun.spawn(testCommand.split(' '), {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Set up timeout
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout);

    // Capture output
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    // Wait for process to finish
    const exitCode = await proc.exited;

    // Clear timeout if process finished before timeout
    clearTimeout(timeoutHandle);

    return {
      success: exitCode === 0 && !timedOut,
      output: stdout + stderr,
      timedOut,
    };
  } catch (error) {
    return {
      success: false,
      output: `Error running tests: ${error instanceof Error ? error.message : String(error)}`,
      timedOut: false,
    };
  }
}
