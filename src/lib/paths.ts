import { homedir } from 'os';
import { basename, join, resolve, dirname } from 'path';
import { gitCommand } from './git';

const XDG_DATA_DIR = join(
  homedir(),
  '.local',
  'share',
  'opencode-mission-control',
);

export function getXdgDataDir(): string {
  return XDG_DATA_DIR;
}

export async function getProjectId(cwd?: string): Promise<string> {
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
    return basename(dirname(gitDir));
  }

  const result = await gitCommand(['rev-parse', '--show-toplevel'], { cwd });

  if (result.exitCode !== 0) {
    return basename(cwd ?? process.cwd());
  }

  return basename(result.stdout);
}

export async function getDataDir(cwd?: string): Promise<string> {
  const projectId = await getProjectId(cwd);
  const dir = join(XDG_DATA_DIR, projectId, 'state');
  const fs = await import('fs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
