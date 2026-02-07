import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import {
  listWorktrees,
  getMainWorktree,
  createWorktree,
  removeWorktree,
  isInManagedWorktree,
  getWorktreeForBranch,
  syncWorktree,
  GitWorktreeProvider,
} from '../../src/lib/worktree';
import type { WorktreeInfo } from '../../src/lib/providers/worktree-provider';

const TEST_REPO_DIR = join(import.meta.dir, '..', '.tmp-test-repo');
const TEST_WORKTREE_DIR = join(import.meta.dir, '..', '.tmp-test-worktrees');

async function exec(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

async function setupTestRepo(): Promise<void> {
  const fs = await import('fs');
  if (fs.existsSync(TEST_REPO_DIR)) {
    fs.rmSync(TEST_REPO_DIR, { recursive: true });
  }
  fs.mkdirSync(TEST_REPO_DIR, { recursive: true });

  await exec(['git', 'init'], TEST_REPO_DIR);
  await exec(['git', 'config', 'user.email', 'test@test.com'], TEST_REPO_DIR);
  await exec(['git', 'config', 'user.name', 'Test'], TEST_REPO_DIR);

  fs.writeFileSync(join(TEST_REPO_DIR, 'README.md'), '# Test');
  await exec(['git', 'add', '.'], TEST_REPO_DIR);
  await exec(['git', 'commit', '-m', 'initial'], TEST_REPO_DIR);
}

async function cleanupTestRepo(): Promise<void> {
  const fs = await import('fs');

  if (fs.existsSync(TEST_WORKTREE_DIR)) {
    fs.rmSync(TEST_WORKTREE_DIR, { recursive: true });
  }

  if (fs.existsSync(TEST_REPO_DIR)) {
    const { stdout } = await exec(
      ['git', 'worktree', 'list', '--porcelain'],
      TEST_REPO_DIR,
    );
    const paths = stdout
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length))
      .filter((p) => p !== TEST_REPO_DIR);

    for (const wt of paths) {
      await exec(['git', 'worktree', 'remove', '--force', wt], TEST_REPO_DIR);
    }
    fs.rmSync(TEST_REPO_DIR, { recursive: true });
  }
}

describe('worktree', () => {
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    await setupTestRepo();
    process.chdir(TEST_REPO_DIR);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await cleanupTestRepo();
  });

  describe('listWorktrees', () => {
    it('should list the main worktree', async () => {
      const worktrees = await listWorktrees();
      expect(worktrees.length).toBeGreaterThanOrEqual(1);
      expect(worktrees[0].isMain).toBe(true);
      expect(worktrees[0].path).toBe(TEST_REPO_DIR);
    });

    it('should include branch and head info', async () => {
      const worktrees = await listWorktrees();
      const main = worktrees[0];
      expect(main.head).toMatch(/^[0-9a-f]{40}$/);
      expect(main.branch).toBeTruthy();
    });
  });

  describe('getMainWorktree', () => {
    it('should return path to main worktree', async () => {
      const mainPath = await getMainWorktree();
      expect(mainPath).toBe(TEST_REPO_DIR);
    });
  });

  describe('createWorktree', () => {
    it('should create a worktree for a new branch', async () => {
      const worktreePath = join(TEST_WORKTREE_DIR, 'test-branch');
      const result = await createWorktree({
        branch: 'test-branch',
        basePath: worktreePath,
      });

      expect(result).toBe(worktreePath);
      const fs = await import('fs');
      expect(fs.existsSync(join(worktreePath, 'README.md'))).toBe(true);
    });

    it('should create a worktree for an existing branch', async () => {
      await exec(
        ['git', 'branch', 'existing-branch'],
        TEST_REPO_DIR,
      );

      const worktreePath = join(TEST_WORKTREE_DIR, 'existing-branch');
      const result = await createWorktree({
        branch: 'existing-branch',
        basePath: worktreePath,
      });

      expect(result).toBe(worktreePath);
    });

    it('should run postCreate copyFiles hooks', async () => {
      const fs = await import('fs');
      fs.writeFileSync(join(TEST_REPO_DIR, '.env.example'), 'KEY=value');

      const worktreePath = join(TEST_WORKTREE_DIR, 'hook-copy');
      await createWorktree({
        branch: 'hook-copy',
        basePath: worktreePath,
        postCreate: {
          copyFiles: ['.env.example'],
        },
      });

      expect(fs.existsSync(join(worktreePath, '.env.example'))).toBe(true);
      const content = fs.readFileSync(
        join(worktreePath, '.env.example'),
        'utf-8',
      );
      expect(content).toBe('KEY=value');
    });

    it('should run postCreate symlinkDirs hooks', async () => {
      const fs = await import('fs');
      const nodeModulesDir = join(TEST_REPO_DIR, 'node_modules');
      fs.mkdirSync(nodeModulesDir, { recursive: true });
      fs.writeFileSync(join(nodeModulesDir, 'marker'), 'exists');

      const worktreePath = join(TEST_WORKTREE_DIR, 'hook-symlink');
      await createWorktree({
        branch: 'hook-symlink',
        basePath: worktreePath,
        postCreate: {
          symlinkDirs: ['node_modules'],
        },
      });

      const symlinkTarget = join(worktreePath, 'node_modules');
      expect(fs.lstatSync(symlinkTarget).isSymbolicLink()).toBe(true);
    });

    it('should run postCreate commands', async () => {
      const worktreePath = join(TEST_WORKTREE_DIR, 'hook-cmd');
      await createWorktree({
        branch: 'hook-cmd',
        basePath: worktreePath,
        postCreate: {
          commands: ['touch .setup-complete'],
        },
      });

      const fs = await import('fs');
      expect(fs.existsSync(join(worktreePath, '.setup-complete'))).toBe(true);
    });
  });

  describe('removeWorktree', () => {
    it('should remove a clean worktree', async () => {
      const worktreePath = join(TEST_WORKTREE_DIR, 'to-remove');
      await createWorktree({
        branch: 'to-remove',
        basePath: worktreePath,
      });

      await removeWorktree(worktreePath);

      const worktrees = await listWorktrees();
      const removed = worktrees.find((wt) => wt.path === worktreePath);
      expect(removed).toBeUndefined();
    });

    it('should refuse to remove dirty worktree without force', async () => {
      const worktreePath = join(TEST_WORKTREE_DIR, 'dirty-wt');
      await createWorktree({
        branch: 'dirty-wt',
        basePath: worktreePath,
      });

      const fs = await import('fs');
      fs.writeFileSync(join(worktreePath, 'dirty-file.txt'), 'uncommitted');

      await expect(removeWorktree(worktreePath)).rejects.toThrow(
        /uncommitted changes/,
      );
    });

    it('should remove dirty worktree with force=true', async () => {
      const worktreePath = join(TEST_WORKTREE_DIR, 'force-remove');
      await createWorktree({
        branch: 'force-remove',
        basePath: worktreePath,
      });

      const fs = await import('fs');
      fs.writeFileSync(join(worktreePath, 'dirty-file.txt'), 'uncommitted');

      await removeWorktree(worktreePath, true);

      const worktrees = await listWorktrees();
      const removed = worktrees.find((wt) => wt.path === worktreePath);
      expect(removed).toBeUndefined();
    });
  });

  describe('getWorktreeForBranch', () => {
    it('should find worktree by branch name', async () => {
      const worktreePath = join(TEST_WORKTREE_DIR, 'find-branch');
      await createWorktree({
        branch: 'find-branch',
        basePath: worktreePath,
      });

      const found = await getWorktreeForBranch('find-branch');
      expect(found).toBeDefined();
      expect(found!.path).toBe(worktreePath);
      expect(found!.branch).toBe('find-branch');
    });

    it('should return undefined for non-existent branch worktree', async () => {
      const found = await getWorktreeForBranch('no-such-branch');
      expect(found).toBeUndefined();
    });
  });

  describe('isInManagedWorktree', () => {
    it('should detect managed worktree paths', async () => {
      const xdgPath = join(
        homedir(),
        '.local',
        'share',
        'opencode-mission-control',
        'my-project',
        'feature-branch',
        'src',
        'file.ts',
      );

      const result = await isInManagedWorktree(xdgPath);
      expect(result.isManaged).toBe(true);
      expect(result.jobName).toBe('feature-branch');
    });

    it('should not detect non-managed paths', async () => {
      const result = await isInManagedWorktree('/tmp/some/random/path');
      expect(result.isManaged).toBe(false);
      expect(result.worktreePath).toBeUndefined();
    });
  });

  describe('GitWorktreeProvider', () => {
    it('should implement WorktreeProvider interface', async () => {
      const provider = new GitWorktreeProvider();

      const worktrees = await provider.list();
      expect(worktrees.length).toBeGreaterThanOrEqual(1);
      expect(worktrees[0].isMain).toBe(true);
    });

    it('should create and remove worktrees through provider', async () => {
      const provider = new GitWorktreeProvider();
      const worktreePath = join(TEST_WORKTREE_DIR, 'provider-test');

      const path = await provider.create({
        branch: 'provider-test',
        basePath: worktreePath,
      });
      expect(path).toBe(worktreePath);

      const worktrees = await provider.list();
      const created = worktrees.find((wt) => wt.branch === 'provider-test');
      expect(created).toBeDefined();

      await provider.remove(worktreePath);
      const afterRemove = await provider.list();
      const removed = afterRemove.find((wt) => wt.branch === 'provider-test');
      expect(removed).toBeUndefined();
    });
  });
});
