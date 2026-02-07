import { spawn } from 'bun';
import { join, resolve } from 'path';
import { GitMutex } from './git-mutex';
import { getProjectId, getXdgDataDir } from './paths';
import type {
  WorktreeInfo,
  SyncResult,
  PostCreateHook,
  WorktreeProvider,
} from './providers/worktree-provider';

export type { WorktreeInfo, SyncResult, PostCreateHook };

const XDG_DATA_DIR = getXdgDataDir();

const mutex = new GitMutex();

async function git(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; exitCode: number }> {
  return mutex.withLock(async () => {
    const proc = spawn(['git', ...args], {
      cwd: opts?.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), exitCode };
  });
}

async function gitUnsafe(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(['git', ...args], {
    cwd: opts?.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

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
  const { stdout, exitCode } = await git(['worktree', 'list', '--porcelain']);
  if (exitCode !== 0) {
    throw new Error('Failed to list worktrees');
  }
  return parseWorktreeListPorcelain(stdout);
}

export async function createWorktree(opts: {
  branch: string;
  basePath?: string;
  postCreate?: PostCreateHook;
}): Promise<string> {
  const projectId = await getProjectId();
  const sanitizedBranch = opts.branch.replace(/\//g, '-');
  const worktreePath =
    opts.basePath ?? join(XDG_DATA_DIR, projectId, sanitizedBranch);

  const fs = await import('fs');
  fs.mkdirSync(join(worktreePath, '..'), { recursive: true });

  const { stdout: existingBranches } = await git(['branch', '--list', opts.branch]);
  const branchExists = existingBranches.includes(opts.branch);

  let result;
  if (branchExists) {
    result = await git(['worktree', 'add', worktreePath, opts.branch]);
  } else {
    result = await git([
      'worktree',
      'add',
      '-b',
      opts.branch,
      worktreePath,
    ]);
  }

  if (result.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${result.stdout}`);
  }

  if (opts.postCreate) {
    await runPostCreateHooks(worktreePath, opts.postCreate);
  }

  return worktreePath;
}

async function runPostCreateHooks(
  worktreePath: string,
  hooks: PostCreateHook,
): Promise<void> {
  const mainPath = await getMainWorktree();
  const fs = await import('fs');

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
    for (const cmd of hooks.commands) {
      const proc = spawn(['sh', '-c', cmd], {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
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
    const { stdout, exitCode } = await gitUnsafe(
      ['-C', path, 'status', '--porcelain'],
    );
    if (exitCode !== 0) {
      throw new Error(`Cannot check worktree status at ${path}`);
    }
    if (stdout.length > 0) {
      throw new Error(
        `Worktree at ${path} has uncommitted changes. Use force=true to remove anyway.`,
      );
    }
  }

  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];
  const { exitCode } = await git(args);
  if (exitCode !== 0) {
    throw new Error(`Failed to remove worktree at ${path}`);
  }
}

export async function isInManagedWorktree(
  path: string,
): Promise<{ isManaged: boolean; worktreePath?: string; jobName?: string }> {
  const resolvedPath = resolve(path);
  if (!resolvedPath.startsWith(XDG_DATA_DIR)) {
    return { isManaged: false };
  }

  const relativeParts = resolvedPath.slice(XDG_DATA_DIR.length + 1).split('/');
  if (relativeParts.length < 2) {
    return { isManaged: false };
  }

  const [_projectId, branchSlug] = relativeParts;
  const worktreePath = join(XDG_DATA_DIR, _projectId, branchSlug);

  return {
    isManaged: true,
    worktreePath,
    jobName: branchSlug,
  };
}

export async function getWorktreeForBranch(
  branch: string,
): Promise<WorktreeInfo | undefined> {
  const worktrees = await listWorktrees();
  return worktrees.find((wt) => wt.branch === branch);
}

export async function syncWorktree(
  path: string,
  strategy: 'rebase' | 'merge',
): Promise<SyncResult> {
  const { stdout: baseBranch, exitCode: baseExit } = await git(
    ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD@{upstream}'],
  );

  let targetBranch: string;
  if (baseExit !== 0) {
    const { stdout: defaultBranch } = await git([
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ]);
    targetBranch = defaultBranch || 'main';
  } else {
    targetBranch = baseBranch;
  }

  const fetchResult = await git(['-C', path, 'fetch', 'origin']);
  if (fetchResult.exitCode !== 0) {
    return { success: false, conflicts: ['Failed to fetch from origin'] };
  }

  const syncResult = await gitUnsafe(
    ['-C', path, strategy, targetBranch],
  );

  if (syncResult.exitCode !== 0) {
    const conflicts = extractConflicts(syncResult.stderr);

    if (strategy === 'rebase') {
      await gitUnsafe(['-C', path, 'rebase', '--abort']);
    } else {
      await gitUnsafe(['-C', path, 'merge', '--abort']);
    }

    return { success: false, conflicts };
  }

  return { success: true };
}

function extractConflicts(stderr: string): string[] {
  const conflicts: string[] = [];
  const lines = stderr.split('\n');
  for (const line of lines) {
    const conflictMatch = line.match(/CONFLICT \(.*?\): (?:Merge conflict in )?(.+)/);
    if (conflictMatch) {
      conflicts.push(conflictMatch[1]);
    }
  }
  return conflicts.length > 0 ? conflicts : [stderr];
}

export class GitWorktreeProvider implements WorktreeProvider {
  async create(opts: {
    branch: string;
    basePath?: string;
    postCreate?: PostCreateHook;
  }): Promise<string> {
    return createWorktree(opts);
  }

  async remove(path: string, force?: boolean): Promise<void> {
    return removeWorktree(path, force);
  }

  async list(): Promise<WorktreeInfo[]> {
    return listWorktrees();
  }

  async sync(path: string, strategy: 'rebase' | 'merge'): Promise<SyncResult> {
    return syncWorktree(path, strategy);
  }
}
