import { spawn } from "bun";

/**
 * Check if tmux is installed and available
 */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    const proc = spawn(["tmux", "-V"]);
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
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
  const tmuxEnv = process.env.TMUX;
  if (!tmuxEnv) return undefined;

  // TMUX env var format: /path/to/socket,pid,index
  const parts = tmuxEnv.split(",");
  if (parts.length < 3) return undefined;

  // Extract session name from socket path
  // Format: /tmp/tmux-uid/socket-name
  const socketPath = parts[0];
  const sessionName = socketPath.split("/").pop();
  return sessionName;
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
    const proc = spawn(["tmux", ...args]);
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
    const proc = spawn(["tmux", ...args]);
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
 * Check if a tmux session exists
 */
export async function sessionExists(name: string): Promise<boolean> {
  try {
    const proc = spawn(["tmux", "has-session", "-t", name]);
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
    const proc = spawn(["tmux", "has-session", "-t", target]);
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
    const proc = spawn(["tmux", "kill-session", "-t", name]);
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
    const proc = spawn(["tmux", "kill-window", "-t", target]);
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

    const proc = spawn(["tmux", ...args]);
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

/**
 * Send keys to a tmux pane
 */
export async function sendKeys(target: string, keys: string): Promise<void> {
  try {
    const proc = spawn(["tmux", "send-keys", "-t", target, keys]);
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
    ]);
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
    ]);
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

/**
 * Check if a tmux pane is running
 */
export async function isPaneRunning(target: string): Promise<boolean> {
  try {
    const proc = spawn([
      "tmux",
      "display-message",
      "-t",
      target,
      "-p",
      "#{pane_dead}",
    ]);
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return false;
    }

    const outputStr = output.trim();
    if (!outputStr || outputStr === "") {
      return false;
    }

    // pane_dead returns 1 if dead, 0 if running
    const isDead = outputStr === "1";
    return !isDead;
  } catch {
    return false;
  }
}
