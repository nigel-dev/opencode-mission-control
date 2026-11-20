import * as fs from 'fs';
import { homedir } from 'os';
import { basename, join, resolve, dirname } from 'path';
import { gitCommand } from './git';
import { getProjectDirectory } from './project-context';

const XDG_DATA_DIR = join(
  homedir(),
  '.local',
  'share',
  'opencode-mission-control',
);

export function getXdgDataDir(): string {
  return XDG_DATA_DIR;
}

/**
 * `path` with symlinks resolved. For a path that does not exist (yet, or any
 * more) the deepest existing ancestor is resolved and the rest appended. Use
 * it on both sides of a path comparison: the host hands plugins real paths,
 * while paths built from `homedir()` may go through a symlink.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.length > 0 ? join(real, ...missing.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) {
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          console.warn(`[Mission Control] Could not resolve ${path}:`, error);
        }
        return absolute;
      }
      missing.push(basename(current));
      current = parent;
    }
  }
}

// The project ID of a directory inside a repository never changes while the
// server runs, and computing it costs one or two git processes. Every state
// and report read needs it, so it is resolved once per directory.
const projectIds = new Map<string, Promise<string>>();

export function getProjectId(cwd?: string): Promise<string> {
  const directory = cwd ?? getProjectDirectory();
  const cached = projectIds.get(directory);
  if (cached) {
    return cached;
  }

  const resolved = resolveProjectId(directory);
  const projectId = resolved.then((result) => result.id);
  projectIds.set(directory, projectId);
  resolved.then(
    (result) => {
      // Outside a repository the ID is only a guess from the directory name;
      // ask git again next time.
      if (!result.fromGit && projectIds.get(directory) === projectId) {
        projectIds.delete(directory);
      }
    },
    () => {
      // Never cache a failure. The caller sees the error through `projectId`.
      if (projectIds.get(directory) === projectId) {
        projectIds.delete(directory);
      }
    },
  );
  return projectId;
}

/** Forget cached project IDs. For tests that reuse one directory for different repositories. */
export function clearProjectIdCache(): void {
  projectIds.clear();
}

async function resolveProjectId(cwd: string): Promise<{ id: string; fromGit: boolean }> {
  // --git-common-dir returns the shared .git dir across all worktrees,
  // so we always resolve to the same project ID regardless of which worktree we're in.
  // In worktrees it returns a path like: /repo/.git/worktrees/<name> (absolute or relative)
  // In the main worktree it returns: .git (or /repo/.git)
  const commonDirResult = await gitCommand(['rev-parse', '--git-common-dir'], { cwd });

  if (commonDirResult.exitCode === 0) {
    let commonDir = commonDirResult.stdout;

    if (!commonDir.startsWith('/')) {
      const toplevelResult = await gitCommand(['rev-parse', '--show-toplevel'], { cwd });
      if (toplevelResult.exitCode === 0) {
        commonDir = resolve(toplevelResult.stdout, commonDir);
      }
    }

    // Strip /worktrees/<name> suffix for linked worktrees, then go up from .git to repo root
    const gitDir = commonDir.replace(/\/worktrees\/[^/]+$/, '');
    return { id: basename(dirname(gitDir)), fromGit: true };
  }

  const result = await gitCommand(['rev-parse', '--show-toplevel'], { cwd });

  if (result.exitCode !== 0) {
    return { id: basename(cwd), fromGit: false };
  }

  return { id: basename(result.stdout), fromGit: true };
}

export async function getDataDir(cwd?: string): Promise<string> {
  const projectId = await getProjectId(cwd);
  const dir = join(XDG_DATA_DIR, projectId, 'state');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
