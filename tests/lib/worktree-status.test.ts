import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as configMod from '../../src/lib/config';
import { findUncommittedChanges, parsePorcelainStatus } from '../../src/lib/worktree-status';

async function exec(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${args.join(' ')} failed: ${stderr}`);
  }
}

describe('parsePorcelainStatus', () => {
  it('reads paths from NUL-separated entries, keeping a leading-space status intact', () => {
    expect(parsePorcelainStatus(' M src/a.ts\0?? new file.txt\0A  staged.ts\0')).toEqual([
      'src/a.ts',
      'new file.txt',
      'staged.ts',
    ]);
  });

  it('skips the source path that follows a rename or a copy', () => {
    expect(parsePorcelainStatus('R  new-name.ts\0old-name.ts\0 M other.ts\0')).toEqual(['new-name.ts', 'other.ts']);
  });

  it('returns nothing for a clean tree', () => {
    expect(parsePorcelainStatus('')).toEqual([]);
  });
});

describe('findUncommittedChanges', () => {
  let repo: string;
  let elsewhere: string;

  beforeEach(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'mc-status-repo-')));
    elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'mc-status-main-')));
    await exec(['git', 'init'], repo);
    await exec(['git', 'config', 'user.email', 'test@test.com'], repo);
    await exec(['git', 'config', 'user.name', 'Test'], repo);
    // As most projects have it: this rule matches a directory, not a symlink.
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(repo, 'tracked.txt'), 'v1\n');
    await exec(['git', 'add', '.'], repo);
    await exec(['git', 'commit', '-m', 'initial'], repo);

    vi.spyOn(configMod, 'loadConfig').mockResolvedValue({ pollInterval: 10000, worktreeBasePath: '/tmp' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(repo, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('finds nothing in a clean worktree', async () => {
    expect(await findUncommittedChanges({ worktreePath: repo, setupArtifacts: [] })).toEqual([]);
  });

  it('finds modified, staged and untracked files', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    writeFileSync(join(repo, 'staged.txt'), 'new\n');
    await exec(['git', 'add', 'staged.txt'], repo);
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'untracked.ts'), 'export {};\n');

    const changes = await findUncommittedChanges({ worktreePath: repo, setupArtifacts: [] });

    expect(changes.sort()).toEqual(['src', 'staged.txt', 'tracked.txt']);
  });

  it("leaves out what Mission Control placed in the worktree, but not the job's own files", async () => {
    // A symlinked node_modules is NOT ignored by `node_modules/`, so git lists it.
    mkdirSync(join(elsewhere, 'node_modules'));
    symlinkSync(join(elsewhere, 'node_modules'), join(repo, 'node_modules'));
    mkdirSync(join(elsewhere, '.opencode'));
    symlinkSync(join(elsewhere, '.opencode'), join(repo, '.opencode'));
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');
    mkdirSync(join(repo, '.hindsight'));
    writeFileSync(join(repo, '.hindsight', 'memory.json'), '{}\n');
    writeFileSync(join(repo, 'work.ts'), 'export {};\n');

    const changes = await findUncommittedChanges({
      worktreePath: repo,
      setupArtifacts: ['.env', '.opencode', 'node_modules'],
    });

    expect(changes).toEqual(['work.ts']);
  });

  it('uses the configured worktree setup for a job recorded without its artifacts', async () => {
    vi.spyOn(configMod, 'loadConfig').mockResolvedValue({
      pollInterval: 10000,
      worktreeBasePath: '/tmp',
      worktreeSetup: { copyFiles: ['.env'], symlinkDirs: ['vendor/'] },
    });
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');
    mkdirSync(join(elsewhere, 'vendor'));
    symlinkSync(join(elsewhere, 'vendor'), join(repo, 'vendor'));
    writeFileSync(join(repo, 'work.ts'), 'export {};\n');

    expect(await findUncommittedChanges({ worktreePath: repo })).toEqual(['work.ts']);
  });

  it('does not ignore a file that merely starts with an artifact name', async () => {
    writeFileSync(join(repo, '.env.production'), 'SECRET=2\n');

    expect(await findUncommittedChanges({ worktreePath: repo, setupArtifacts: ['.env'] })).toEqual(['.env.production']);
  });

  it('throws when the worktree cannot be inspected', async () => {
    await expect(
      findUncommittedChanges({ worktreePath: join(elsewhere, 'gone'), setupArtifacts: [] }),
    ).rejects.toThrow('Cannot check worktree status');
  });
});
