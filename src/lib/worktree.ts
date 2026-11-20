import * as fs from 'fs';
import { spawn } from 'bun';
import { join, resolve } from 'path';
import { canonicalPath, getProjectId, getXdgDataDir } from './paths';
import { gitCommand, getDefaultBranch } from './git';
import type {
  WorktreeInfo,
  SyncResult,
  PostCreateHook,
} from './providers/worktree-provider';
import { extractConflicts } from './utils';
import { validateCommand } from './worktree-setup';
import { loadConfig } from './config';

export type { WorktreeInfo, SyncResult, PostCreateHook };

const XDG_DATA_DIR = getXdgDataDir();

function parseWorktreeListPorcelain(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  const blocks = output.split('\n\n').filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n');
    let path = '';
    let head = '';
    let branch = '';
    let isMain = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).replace('refs/heads/', '');
      } else if (line === 'bare') {
        isMain = true;
      }
    }

    if (path) {
      const isFirstEntry = worktrees.length === 0;
      if (isFirstEntry) {
        isMain = true;
      }
      worktrees.push({ path, branch, head, isMain });
    }
  }

  return worktrees;
}

export async function getMainWorktree(): Promise<string> {
  const worktrees = await listWorktrees();
  const main = worktrees.find((wt) => wt.isMain);
  if (!main) {
    throw new Error('Could not determine main worktree');
  }
  return main.path;
}

export async function listWorktrees(): Promise<WorktreeInfo[]> {
  const result = await gitCommand(['worktree', 'list', '--porcelain']);
  if (result.exitCode !== 0) {
    throw new Error('Failed to list worktrees');
  }
  return parseWorktreeListPorcelain(result.stdout);
}

export async function createWorktree(opts: {
  branch: string;
  basePath?: string;
  startPoint?: string;
  postCreate?: PostCreateHook;
}): Promise<string> {
  const projectId = await getProjectId();
  const sanitizedBranch = opts.branch.replace(/\//g, '-');
  const worktreePath =
    opts.basePath ?? join(XDG_DATA_DIR, projectId, sanitizedBranch);

  fs.mkdirSync(join(worktreePath, '..'), { recursive: true });

  const branchCheckResult = await gitCommand(['branch', '--list', opts.branch]);
  const branchExists = branchCheckResult.stdout.includes(opts.branch);

  let createResult;
  if (branchExists) {
    createResult = await gitCommand(['worktree', 'add', worktreePath, opts.branch]);
  } else {
    const args = ['worktree', 'add', '-b', opts.branch, worktreePath];
    if (opts.startPoint) args.push(opts.startPoint);
    createResult = await gitCommand(args);
  }

  if (createResult.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${createResult.stderr || createResult.stdout}`);
  }

  if (opts.postCreate) {
    try {
      await runPostCreateHooks(worktreePath, opts.postCreate);
    } catch (error) {
      // Do not leave a half-set-up worktree (and a branch we just created) behind.
      const removeResult = await gitCommand(['worktree', 'remove', '--force', worktreePath]);
      if (removeResult.exitCode !== 0) {
        console.warn(`[Mission Control] Could not remove worktree ${worktreePath} after a failed setup: ${removeResult.stderr}`);
      } else if (!branchExists) {
        await gitCommand(['branch', '-D', opts.branch]);
      }
      throw error;
    }
  }

  return worktreePath;
}

async function runPostCreateHooks(
  worktreePath: string,
  hooks: PostCreateHook,
): Promise<void> {
  const mainPath = await getMainWorktree();

  if (hooks.copyFiles) {
    for (const file of hooks.copyFiles) {
      const src = join(mainPath, file);
      const dest = join(worktreePath, file);
      if (fs.existsSync(src)) {
        fs.mkdirSync(join(dest, '..'), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }
  }

  if (hooks.symlinkDirs) {
    for (const dir of hooks.symlinkDirs) {
      const src = join(mainPath, dir);
      const dest = join(worktreePath, dir);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.mkdirSync(join(dest, '..'), { recursive: true });
        fs.symlinkSync(resolve(src), dest);
      }
    }
  }

  if (hooks.commands) {
    const config = await loadConfig();
    const suppressWarnings = config.allowUnsafeCommands === true;

    for (const cmd of hooks.commands) {
      if (!suppressWarnings) {
        const validation = validateCommand(cmd);
        if (!validation.safe) {
          const warnings = validation.warnings.join(', ');
          // Also shown to the caller in the launch output (see job-launcher).
          console.warn(
            `[mc] Warning: potentially unsafe worktree command: "${cmd}" (${warnings})`,
          );
        }
      }

      const proc = spawn(['sh', '-c', cmd], {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      // Drain both pipes while the command runs: a command that fills an
      // unread pipe blocks forever.
      const [, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(
          `Post-create command failed: "${cmd}" (exit ${exitCode}): ${stderr}`,
        );
      }
    }
  }
}

export async function removeWorktree(
  path: string,
  force = false,
): Promise<void> {
  if (!force) {
    const statusResult = await gitCommand(['-C', path, 'status', '--porcelain']);
    if (statusResult.exitCode !== 0) {
      throw new Error(`Cannot check worktree status at ${path}`);
    }
    if (statusResult.stdout.length > 0) {
      throw new Error(
        `Worktree at ${path} has uncommitted changes. Use force=true to remove anyway.`,
      );
    }
  }

  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];
  const removeResult = await gitCommand(args);
  if (removeResult.exitCode !== 0) {
    throw new Error(`Failed to remove worktree at ${path}`);
  }
}

/** Directories under a project's data directory that hold state, not worktrees. */
const NON_WORKTREE_DIRS = new Set(['state', 'reports']);

export async function isInManagedWorktree(
  path: string,
): Promise<{ isManaged: boolean; worktreePath?: string; jobName?: string }> {
  // Compare real paths: the host reports a session's real location, while the
  // data directory is built from the home directory, which may be a symlink.
  const root = canonicalPath(XDG_DATA_DIR);
  const resolvedPath = canonicalPath(path);
  if (!resolvedPath.startsWith(`${root}/`)) {
    return { isManaged: false };
  }

  const relativeParts = resolvedPath.slice(root.length + 1).split('/');
  if (relativeParts.length < 2) {
    return { isManaged: false };
  }

  const [_projectId, branchSlug] = relativeParts;
  if (!branchSlug || NON_WORKTREE_DIRS.has(branchSlug)) {
    return { isManaged: false };
  }
  // Job records store worktree paths in the unresolved form.
  const worktreePath = join(XDG_DATA_DIR, _projectId, branchSlug);

  return {
    isManaged: true,
    worktreePath,
    jobName: branchSlug,
  };
}

export async function syncWorktree(
  path: string,
  strategy: 'rebase' | 'merge',
  baseBranch?: string,
  source: 'local' | 'origin' = 'local',
): Promise<SyncResult> {
  const base = baseBranch ?? (await getDefaultBranch());
  const useOrigin = source === 'origin';
  const targetBranch = useOrigin ? `origin/${base}` : base;

  if (useOrigin) {
    const fetchResult = await gitCommand(['-C', path, 'fetch', 'origin']);
    if (fetchResult.exitCode !== 0) {
      return { success: false, conflicts: ['Failed to fetch from origin'] };
    }
  }

  const syncResult = await gitCommand(['-C', path, strategy, targetBranch]);

  if (syncResult.exitCode !== 0) {
    const conflicts = extractConflicts(syncResult.stderr);

    // Leave the worktree as it was. The exit code does not matter: when the
    // sync failed before it started there is nothing to abort.
    try {
      await gitCommand(['-C', path, strategy, '--abort']);
    } catch (error) {
      console.warn(`[Mission Control] Could not abort the ${strategy} in ${path}:`, error);
    }

    return { success: false, conflicts };
  }

  return { success: true };
}
