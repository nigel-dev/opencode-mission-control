import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import * as git from '../../src/lib/git';
import { canonicalPath, clearProjectIdCache, getProjectId } from '../../src/lib/paths';
import { isInManagedWorktree } from '../../src/lib/worktree';

describe('canonicalPath', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-paths-')));
    mkdirSync(join(root, 'real', 'project'), { recursive: true });
    // Stands in for a home directory that is a symlink (as on Fedora Silverblue).
    symlinkSync(join(root, 'real'), join(root, 'home'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves symlinks in an existing path', () => {
    expect(canonicalPath(join(root, 'home', 'project'))).toBe(join(root, 'real', 'project'));
  });

  it('resolves the existing part of a path that does not exist yet', () => {
    expect(canonicalPath(join(root, 'home', 'project', 'not', 'there'))).toBe(
      join(root, 'real', 'project', 'not', 'there'),
    );
  });

  it('gives the same answer for the real path and the path through the symlink', () => {
    // The host reports a session's real location; the data directory is built
    // from the home directory. Both sides of that comparison must agree.
    expect(canonicalPath(join(root, 'home', 'project'))).toBe(canonicalPath(join(root, 'real', 'project')));
  });

  it('leaves a path with nothing to resolve unchanged', () => {
    expect(canonicalPath(join(root, 'real', 'project'))).toBe(join(root, 'real', 'project'));
  });
});

describe('isInManagedWorktree with symlinks', () => {
  it('recognizes a worktree reached through a symlink into the data directory', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-managed-')));
    try {
      const { homedir } = await import('os');
      const dataDir = join(homedir(), '.local', 'share', 'opencode-mission-control');
      // A different spelling of the same directory, as a symlinked home gives.
      symlinkSync(canonicalPath(dataDir), join(root, 'data'));

      const viaLink = await isInManagedWorktree(join(root, 'data', 'my-project', 'mc-job'));
      const direct = await isInManagedWorktree(join(dataDir, 'my-project', 'mc-job'));

      expect(direct).toEqual({
        isManaged: true,
        worktreePath: join(dataDir, 'my-project', 'mc-job'),
        jobName: 'mc-job',
      });
      // Only resolvable when the data directory exists on this machine; on a
      // fresh machine the link dangles and the path is, correctly, not managed.
      const { existsSync } = await import('fs');
      if (existsSync(dataDir)) {
        expect(viaLink).toEqual(direct);
      } else {
        expect(viaLink.isManaged).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('getProjectId', () => {
  beforeEach(() => {
    clearProjectIdCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearProjectIdCache();
  });

  it('asks git once per directory and then answers from memory', async () => {
    const gitCommand = vi
      .spyOn(git, 'gitCommand')
      .mockResolvedValue({ stdout: '/repos/alpha/.git', stderr: '', exitCode: 0 });

    expect(await getProjectId('/repos/alpha')).toBe('alpha');
    expect(await getProjectId('/repos/alpha')).toBe('alpha');
    expect(await getProjectId('/repos/alpha/src')).toBe('alpha');

    // One call for /repos/alpha, one for /repos/alpha/src; none for the repeat.
    expect(gitCommand).toHaveBeenCalledTimes(2);
  });

  it('shares one lookup between concurrent callers', async () => {
    const gitCommand = vi
      .spyOn(git, 'gitCommand')
      .mockResolvedValue({ stdout: '/repos/beta/.git', stderr: '', exitCode: 0 });

    const ids = await Promise.all([getProjectId('/repos/beta'), getProjectId('/repos/beta'), getProjectId('/repos/beta')]);

    expect(ids).toEqual(['beta', 'beta', 'beta']);
    expect(gitCommand).toHaveBeenCalledTimes(1);
  });

  it('does not remember a guess made outside a repository', async () => {
    const gitCommand = vi
      .spyOn(git, 'gitCommand')
      .mockResolvedValue({ stdout: '', stderr: 'not a git repository', exitCode: 128 });

    expect(await getProjectId('/tmp/not-a-repo')).toBe(basename('/tmp/not-a-repo'));
    const callsForFirstLookup = gitCommand.mock.calls.length;
    expect(await getProjectId('/tmp/not-a-repo')).toBe('not-a-repo');

    expect(gitCommand.mock.calls.length).toBe(callsForFirstLookup * 2);
  });

  it('does not remember a failed lookup', async () => {
    const gitCommand = vi.spyOn(git, 'gitCommand').mockRejectedValueOnce(new Error('git is not installed'));

    await expect(getProjectId('/repos/gamma')).rejects.toThrow('git is not installed');

    gitCommand.mockResolvedValue({ stdout: '/repos/gamma/.git', stderr: '', exitCode: 0 });
    expect(await getProjectId('/repos/gamma')).toBe('gamma');
  });
});
