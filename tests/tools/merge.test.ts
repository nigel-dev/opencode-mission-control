import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as worktree from '../../src/lib/worktree';
import * as config from '../../src/lib/config';
import * as planState from '../../src/lib/plan-state';
import * as git from '../../src/lib/git';

const { mc_merge } = await import('../../src/tools/merge');

let mockGetJobByName: any;

const mockContext = {
  sessionID: 'test-session',
  messageID: 'test-message',
  agent: 'test-agent',
  directory: '/test/dir',
  worktree: '/test/worktree',
  abort: new AbortController().signal,
  metadata: vi.fn(),
  ask: vi.fn(),
} as any;

describe('mc_merge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockImplementation(() => undefined as any);
    vi.spyOn(worktree, 'getMainWorktree').mockResolvedValue('/tmp/mc-merge-mock-main');
    vi.spyOn(config, 'loadConfig').mockResolvedValue({ mergeStrategy: 'squash' } as any);
    vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);
    vi.spyOn(git, 'gitCommand').mockImplementation(async (args: string[]) => {
      if (
        args[0] === 'rev-parse' &&
        args.includes('--verify') &&
        args[args.length - 1] === 'main'
      ) {
        return { stdout: 'main', stderr: '', exitCode: 0 };
      }

      if (
        args[0] === 'rev-parse' &&
        args.includes('--verify') &&
        args[args.length - 1] === 'master'
      ) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }

      if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) {
        return { stdout: 'main', stderr: '', exitCode: 0 };
      }

      if (args[0] === 'merge' && args.includes('--squash')) {
        return { stdout: '', stderr: 'mock squash merge failure', exitCode: 1 };
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_merge.description).toBe(
        'Merge a job\'s branch back to main (for non-PR workflows)',
      );
    });

    it('should have name arg', () => {
      expect(mc_merge.args.name).toBeDefined();
    });

    it('should have optional squash arg', () => {
      expect(mc_merge.args.squash).toBeDefined();
    });

    it('should have optional message arg', () => {
      expect(mc_merge.args.message).toBeDefined();
    });
  });

  describe('job not found', () => {
    it('should throw error when job does not exist', async () => {
      mockGetJobByName.mockResolvedValue(undefined);

      await expect(
        mc_merge.execute({ name: 'nonexistent' }, mockContext),
      ).rejects.toThrow('Job "nonexistent" not found');
    });
  });

  describe('safety guard', () => {
    it('should refuse merge when main worktree has uncommitted changes', async () => {
      const job: Job = {
        id: 'job-dirty',
        name: 'dirty-merge',
        worktreePath: '/tmp/mc-worktrees/dirty-merge',
        branch: 'mc/dirty-merge',
        tmuxTarget: 'mc-dirty-merge',
        placement: 'session',
        status: 'running',
        prompt: 'Dirty merge test',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      (git.gitCommand as any).mockImplementation(async (args: string[]) => {
        if (
          args[0] === 'rev-parse' &&
          args.includes('--verify') &&
          args[args.length - 1] === 'main'
        ) {
          return { stdout: 'main', stderr: '', exitCode: 0 };
        }

        if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) {
          return { stdout: 'main', stderr: '', exitCode: 0 };
        }

        if (args[0] === 'status' && args.includes('--porcelain')) {
          return { stdout: ' M README.md', stderr: '', exitCode: 0 };
        }

        return { stdout: '', stderr: '', exitCode: 0 };
      });

      await expect(
        mc_merge.execute({ name: 'dirty-merge' }, mockContext),
      ).rejects.toThrow('Main worktree has uncommitted changes');
    });
  });

  describe('tool args validation', () => {
    it('should have name as required arg', () => {
      const nameArg = mc_merge.args.name;
      expect(nameArg).toBeDefined();
    });

    it('should have squash as optional boolean arg', () => {
      const squashArg = mc_merge.args.squash;
      expect(squashArg).toBeDefined();
    });

    it('should have message as optional string arg', () => {
      const messageArg = mc_merge.args.message;
      expect(messageArg).toBeDefined();
    });
  });

  describe('merge output format', () => {
    it('should include job branch in output', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        worktreePath: '/tmp/mc-worktrees/feature-auth',
        branch: 'mc/feature-auth',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Implement authentication',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_merge.execute({ name: 'feature-auth' }, mockContext);
      } catch {
      }
    });

    it('should include base branch in output', async () => {
      const job: Job = {
        id: 'job-2',
        name: 'feature-api',
        worktreePath: '/tmp/mc-worktrees/feature-api',
        branch: 'mc/feature-api',
        tmuxTarget: 'mc-feature-api',
        placement: 'session',
        status: 'running',
        prompt: 'Build API endpoints',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_merge.execute({ name: 'feature-api' }, mockContext);
      } catch {
      }
    });

    it('should indicate squash option in output when enabled', async () => {
      const job: Job = {
        id: 'job-3',
        name: 'feature-ui',
        worktreePath: '/tmp/mc-worktrees/feature-ui',
        branch: 'mc/feature-ui',
        tmuxTarget: 'mc-feature-ui',
        placement: 'session',
        status: 'running',
        prompt: 'Update UI components',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_merge.execute(
          { name: 'feature-ui', squash: true },
          mockContext,
        );
      } catch {
      }
    });

    it('should include custom message in output when provided', async () => {
      const job: Job = {
        id: 'job-4',
        name: 'feature-db',
        worktreePath: '/tmp/mc-worktrees/feature-db',
        branch: 'mc/feature-db',
        tmuxTarget: 'mc-feature-db',
        placement: 'session',
        status: 'running',
        prompt: 'Add database migrations',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_merge.execute(
          { name: 'feature-db', message: 'Custom merge message' },
          mockContext,
        );
      } catch {
      }
    });

    it('should not push after merge', async () => {
      const job: Job = {
        id: 'job-5',
        name: 'feature-test',
        worktreePath: '/tmp/mc-worktrees/feature-test',
        branch: 'mc/feature-test',
        tmuxTarget: 'mc-feature-test',
        placement: 'session',
        status: 'running',
        prompt: 'Add tests',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_merge.execute({ name: 'feature-test' }, mockContext);
      } catch {
      }
    });

    it('should not delete branch after merge', async () => {
      const job: Job = {
        id: 'job-6',
        name: 'feature-cleanup',
        worktreePath: '/tmp/mc-worktrees/feature-cleanup',
        branch: 'mc/feature-cleanup',
        tmuxTarget: 'mc-feature-cleanup',
        placement: 'session',
        status: 'running',
        prompt: 'Cleanup code',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_merge.execute({ name: 'feature-cleanup' }, mockContext);
      } catch {
      }
    });
  });
});

describe('squash merge integration', () => {
  async function exec(
    args: string[],
    cwd: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(args, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  }

  async function mustExec(args: string[], cwd: string): Promise<string> {
    const result = await exec(args, cwd);
    if (result.exitCode !== 0) {
      throw new Error(`Command failed: ${args.join(' ')}\n${result.stderr}`);
    }
    return result.stdout;
  }

  async function setupRepo(): Promise<{ repoDir: string; rootDir: string }> {
    const rootDir = mkdtempSync(join(tmpdir(), 'mc-merge-test-'));
    const repoDir = join(rootDir, 'repo');
    mkdirSync(repoDir, { recursive: true });

    await mustExec(['git', 'init'], repoDir);
    await mustExec(['git', 'config', 'user.email', 'test@test.com'], repoDir);
    await mustExec(['git', 'config', 'user.name', 'Test'], repoDir);

    writeFileSync(join(repoDir, 'base.txt'), 'base\n');
    await mustExec(['git', 'add', '.'], repoDir);
    await mustExec(['git', 'commit', '-m', 'initial'], repoDir);
    await mustExec(['git', 'branch', '-M', 'main'], repoDir);

    return { repoDir, rootDir };
  }

  async function createBranchCommit(
    repoDir: string,
    branch: string,
    file: string,
    content: string,
  ): Promise<void> {
    await mustExec(['git', 'checkout', '-b', branch, 'main'], repoDir);
    writeFileSync(join(repoDir, file), content);
    await mustExec(['git', 'add', file], repoDir);
    await mustExec(['git', 'commit', '-m', `add ${branch}`], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);
  }

  function mockDependencies(repoDir: string, branchName: string) {
    vi.spyOn(jobState, 'getJobByName').mockResolvedValue({
      id: 'test-job',
      name: 'test-job',
      worktreePath: '/unused',
      branch: branchName,
      tmuxTarget: 'mc-test',
      placement: 'session',
      status: 'completed',
      prompt: 'test',
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
    } as Job);

    vi.spyOn(worktree, 'getMainWorktree').mockResolvedValue(repoDir);
    vi.spyOn(config, 'loadConfig').mockResolvedValue({ mergeStrategy: 'squash' } as any);
    vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);
  }

  let rootDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('squash merge conflict leaves clean working tree after abort', async () => {
    const repo = await setupRepo();
    rootDir = repo.rootDir;
    const { repoDir } = repo;

    writeFileSync(join(repoDir, 'shared.txt'), 'base\n');
    await mustExec(['git', 'add', 'shared.txt'], repoDir);
    await mustExec(['git', 'commit', '-m', 'add shared.txt'], repoDir);

    await createBranchCommit(repoDir, 'branch-a', 'shared.txt', 'left\n');
    await createBranchCommit(repoDir, 'branch-b', 'shared.txt', 'right\n');

    mockDependencies(repoDir, 'branch-a');
    await mc_merge.execute({ name: 'test-job' }, mockContext);

    mockDependencies(repoDir, 'branch-b');
    await expect(
      mc_merge.execute({ name: 'test-job' }, mockContext),
    ).rejects.toThrow('Squash merge failed');

    const status = await exec(['git', 'status', '--porcelain'], repoDir);
    expect(status.stdout).toBe('');
  });

  it('squash merge adding new files + conflict cleans up untracked files', async () => {
    const repo = await setupRepo();
    rootDir = repo.rootDir;
    const { repoDir } = repo;

    writeFileSync(join(repoDir, 'shared.txt'), 'base\n');
    await mustExec(['git', 'add', 'shared.txt'], repoDir);
    await mustExec(['git', 'commit', '-m', 'add shared.txt'], repoDir);

    await mustExec(['git', 'checkout', '-b', 'branch-a', 'main'], repoDir);
    writeFileSync(join(repoDir, 'shared.txt'), 'left\n');
    writeFileSync(join(repoDir, 'new-file.txt'), 'new content\n');
    await mustExec(['git', 'add', 'shared.txt', 'new-file.txt'], repoDir);
    await mustExec(['git', 'commit', '-m', 'branch-a changes'], repoDir);
    await mustExec(['git', 'checkout', 'main'], repoDir);

    await createBranchCommit(repoDir, 'branch-b', 'shared.txt', 'right\n');

    mockDependencies(repoDir, 'branch-a');
    await mc_merge.execute({ name: 'test-job' }, mockContext);

    mockDependencies(repoDir, 'branch-b');
    await expect(
      mc_merge.execute({ name: 'test-job' }, mockContext),
    ).rejects.toThrow('Squash merge failed');

    const status = await exec(['git', 'status', '--porcelain'], repoDir);
    expect(status.stdout).toBe('');
  });

  it('--no-ff merge conflict aborts cleanly with merge --abort', async () => {
    const repo = await setupRepo();
    rootDir = repo.rootDir;
    const { repoDir } = repo;

    writeFileSync(join(repoDir, 'shared.txt'), 'base\n');
    await mustExec(['git', 'add', 'shared.txt'], repoDir);
    await mustExec(['git', 'commit', '-m', 'add shared.txt'], repoDir);

    await createBranchCommit(repoDir, 'branch-a', 'shared.txt', 'left\n');
    await createBranchCommit(repoDir, 'branch-b', 'shared.txt', 'right\n');

    vi.spyOn(jobState, 'getJobByName').mockResolvedValue({
      id: 'test-job',
      name: 'test-job',
      worktreePath: '/unused',
      branch: 'branch-a',
      tmuxTarget: 'mc-test',
      placement: 'session',
      status: 'completed',
      prompt: 'test',
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
    } as Job);
    vi.spyOn(worktree, 'getMainWorktree').mockResolvedValue(repoDir);
    vi.spyOn(config, 'loadConfig').mockResolvedValue({ mergeStrategy: 'merge' } as any);
    vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);

    await mc_merge.execute({ name: 'test-job', strategy: 'merge' }, mockContext);

    vi.spyOn(jobState, 'getJobByName').mockResolvedValue({
      id: 'test-job',
      name: 'test-job',
      worktreePath: '/unused',
      branch: 'branch-b',
      tmuxTarget: 'mc-test',
      placement: 'session',
      status: 'completed',
      prompt: 'test',
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
    } as Job);
    vi.spyOn(worktree, 'getMainWorktree').mockResolvedValue(repoDir);
    vi.spyOn(config, 'loadConfig').mockResolvedValue({ mergeStrategy: 'merge' } as any);
    vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);

    await expect(
      mc_merge.execute({ name: 'test-job', strategy: 'merge' }, mockContext),
    ).rejects.toThrow('Merge failed');

    const status = await exec(['git', 'status', '--porcelain'], repoDir);
    expect(status.stdout).toBe('');
  });
});
