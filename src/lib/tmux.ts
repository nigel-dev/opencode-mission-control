import { spawn, spawnSync } from "bun";

/**
 * Check if tmux is installed and available
 */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    const proc = spawn(["tmux", "-V"], { stderr: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Validate tmux availability and return a descriptive error or null if available
 */
export async function validateTmux(): Promise<string | null> {
  try {
    const proc = spawn(["tmux", "-V"], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return "tmux is not installed or not in PATH";
    }
    return null;
  } catch {
    return "tmux is not installed or not in PATH";
  }
}

/**
 * Check if we're currently inside a tmux session
 */
export function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * Get the current tmux session name
 */
export function getCurrentSession(): string | undefined {
  if (!process.env.TMUX) return undefined;

  try {
    const proc = spawnSync(["tmux", "display-message", "-p", "#{session_name}"], {
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      const name = proc.stdout.toString().trim();
      if (name) return name;
    }
  } catch {}

  return undefined;
}

/**
 * Create a new tmux session
 */
export async function createSession(opts: {
  name: string;
  workdir: string;
  command?: string;
}): Promise<void> {
  const args = ["new-session", "-d", "-s", opts.name, "-c", opts.workdir];
  if (opts.command) {
    args.push(opts.command);
  }

  try {
    const proc = spawn(["tmux", ...args], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`tmux new-session failed with exit code ${exitCode}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to create tmux session: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Create a new window in an existing tmux session
 */
export async function createWindow(opts: {
  session: string;
  name: string;
  workdir: string;
  command?: string;
}): Promise<void> {
  const args = [
    "new-window",
    "-t",
    opts.session,
    "-n",
    opts.name,
    "-c",
    opts.workdir,
  ];
  if (opts.command) {
    args.push(opts.command);
  }

  try {
    const proc = spawn(["tmux", ...args], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`tmux new-window failed with exit code ${exitCode}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to create tmux window: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Set a user option on a tmux window for ownership tracking
 */
export async function setWindowOption(target: string, option: string, value: string): Promise<void> {
  try {
    const proc = spawn(["tmux", "set-option", "-w", "-t", target, option, value], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`tmux set-option failed with exit code ${exitCode}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to set tmux window option: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Find and kill all tmux windows tagged with a specific job ID
 */
export async function killTaggedWindows(jobId: string): Promise<number> {
  try {
    const proc = spawn(
      ["tmux", "list-windows", "-a", "-F", "#{session_name}:#{window_index} #{@mc_job_id}"],
      { stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return 0;
    }

    let killed = 0;
    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;
      const [target, taggedId] = line.split(' ', 2);
      if (taggedId === jobId && target) {
        try {
          const killProc = spawn(["tmux", "kill-window", "-t", target], { stderr: "pipe" });
          await killProc.exited;
          killed++;
        } catch {
          // Best-effort: window may already be gone
        }
      }
    }
    return killed;
  } catch {
    return 0;
  }
}

/**
 * Check if a tmux session exists
 */
export async function sessionExists(name: string): Promise<boolean> {
  try {
    const proc = spawn(["tmux", "has-session", "-t", name], { stderr: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if a window exists in a session
 */
export async function windowExists(
  session: string,
  window: string
): Promise<boolean> {
  try {
    const target = `${session}:${window}`;
    const proc = spawn(["tmux", "has-session", "-t", target], { stderr: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Kill a tmux session
 */
export async function killSession(name: string): Promise<void> {
  try {
    const proc = spawn(["tmux", "kill-session", "-t", name], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`tmux kill-session failed with exit code ${exitCode}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to kill tmux session: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Kill a window in a tmux session
 */
export async function killWindow(
  session: string,
  window: string
): Promise<void> {
  try {
    const target = `${session}:${window}`;
    const proc = spawn(["tmux", "kill-window", "-t", target], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`tmux kill-window failed with exit code ${exitCode}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to kill tmux window: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Capture pane output
 */
export async function capturePane(
  target: string,
  lines?: number
): Promise<string> {
  try {
    const args = ["capture-pane", "-t", target, "-p"];
    if (lines !== undefined && lines > 0) {
      args.push(`-S-${lines}`);
    }

    const proc = spawn(["tmux", ...args], { stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`tmux capture-pane failed with exit code ${exitCode}`);
    }

    return output;
  } catch (error) {
    throw new Error(
      `Failed to capture pane: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function sendKeys(target: string, keys: string): Promise<void> {
  try {
    const proc = spawn(["tmux", "send-keys", "-t", target, keys], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`tmux send-keys failed with exit code ${exitCode}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to send keys: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Set a pane-died hook
 */
export async function setPaneDiedHook(
  target: string,
  callback: string
): Promise<void> {
  try {
    const proc = spawn([
      "tmux",
      "set-hook",
      "-t",
      target,
      "pane-died",
      callback,
    ], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`tmux set-hook failed with exit code ${exitCode}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to set pane-died hook: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get the PID of a tmux pane
 */
export async function getPanePid(
  target: string
): Promise<number | undefined> {
  try {
    const proc = spawn([
      "tmux",
      "display-message",
      "-t",
      target,
      "-p",
      "#{pane_pid}",
    ], { stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return undefined;
    }

    const pid = parseInt(output.trim(), 10);
    return isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

/** Stderr patterns that indicate the pane/session genuinely does not exist */
const PANE_NOT_FOUND_PATTERNS = [
  "can't find pane",
  "no such session",
  "session not found",
  "window not found",
  "can't find window",
  "no current target",
  "no server running",
];

function isPaneNotFoundError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return PANE_NOT_FOUND_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Check if a tmux pane is running.
 * Returns false when pane genuinely doesn't exist. Throws on tmux infrastructure failures.
 * Retries once (500ms delay) to handle transient errors.
 */
export async function isPaneRunning(target: string): Promise<boolean> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    try {
      const proc = spawn([
        "tmux",
        "display-message",
        "-t",
        target,
        "-p",
        "#{pane_dead}",
      ], { stderr: "pipe" });
      const [output, stderrBuf] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = stderrBuf.trim();
        if (isPaneNotFoundError(stderr)) {
          return false;
        }
        // Unknown tmux error — store and retry
        lastError = new Error(
          `tmux display-message failed (exit ${exitCode}): ${stderr || "(no stderr)"}`,
        );
        continue;
      }

      const outputStr = output.trim();
      if (!outputStr || outputStr === "") {
        return false;
      }

      // pane_dead returns 1 if dead, 0 if running
      const isDead = outputStr === "1";
      return !isDead;
    } catch (error) {
      lastError = error instanceof Error
        ? error
        : new Error(String(error));
      continue;
    }
  }

  // Both attempts failed with a non-"pane not found" error — propagate
  throw lastError ?? new Error("isPaneRunning failed after retries");
}

/**
 * Check if the tmux server is responsive
 */
export async function isTmuxHealthy(): Promise<boolean> {
  try {
    const proc = spawn(["tmux", "list-sessions"], { stderr: "pipe", stdout: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Capture the exit status of a dead tmux pane
 * Returns the exit code if available, or undefined if pane is still running or status unavailable
 */
export async function captureExitStatus(target: string): Promise<number | undefined> {
  try {
    // Try to get pane_dead_status (exit code of dead pane)
    const proc = spawn([
      "tmux",
      "display-message",
      "-t",
      target,
      "-p",
      "#{pane_dead_status}",
    ], { stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return undefined;
    }

    const outputStr = output.trim();
    if (!outputStr || outputStr === "") {
      return undefined;
    }

    // pane_dead_status returns the exit code as a string, or empty if pane is running
    const status = parseInt(outputStr, 10);
    return isNaN(status) ? undefined : status;
  } catch {
    return undefined;
  }
}
