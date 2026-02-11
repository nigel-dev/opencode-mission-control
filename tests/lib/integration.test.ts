import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import {
  createIntegrationBranch,
  getIntegrationWorktree,
  deleteIntegrationBranch,
  refreshIntegrationFromMain,
} from '../../src/lib/integration';

const TEST_REPO_DIR = join(tmpdir(), '.tmp-integration-test-repo');

async function exec(
  args: string[],
  cwdOrOpts?: string | { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = typeof cwdOrOpts === 'string' ? cwdOrOpts : cwdOrOpts?.cwd;
  const proc = Bun.spawn(args, {
    cwd,
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

async function mustExec(
  args: string[],
  cwdOrOpts?: string | { cwd?: string },
): Promise<string> {
  const result = await exec(args, cwdOrOpts);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${args.join(' ')}\n${result.stderr}`);
  }
  return result.stdout;
}

async function setupTestRepo(): Promise<void> {
  const fs = await import('fs');
  if (fs.existsSync(TEST_REPO_DIR)) {
    fs.rmSync(TEST_REPO_DIR, { recursive: true });
  }
  fs.mkdirSync(TEST_REPO_DIR, { recursive: true });

  const bareRepoDir = join(TEST_REPO_DIR, 'bare.git');
  fs.mkdirSync(bareRepoDir, { recursive: true });
  await mustExec(['git', 'init', '--bare'], bareRepoDir);

  const mainRepoDir = join(TEST_REPO_DIR, 'main');
  fs.mkdirSync(mainRepoDir, { recursive: true });
  await mustExec(['git', 'init'], mainRepoDir);
  await mustExec(['git', 'branch', '-M', 'main'], mainRepoDir);
  await mustExec(['git', 'config', 'user.email', 'test@test.com'], mainRepoDir);
  await mustExec(['git', 'config', 'user.name', 'Test'], mainRepoDir);
  await mustExec(['git', 'remote', 'add', 'origin', bareRepoDir], mainRepoDir);

  fs.writeFileSync(join(mainRepoDir, 'test.txt'), 'initial content');
  await mustExec(['git', 'add', '.'], mainRepoDir);
  await mustExec(['git', 'commit', '-m', 'initial'], mainRepoDir);
  await mustExec(['git', 'push', '-u', 'origin', 'main'], mainRepoDir);

  process.chdir(mainRepoDir);
}

async function cleanupTestRepo(): Promise<void> {
  const fs = await import('fs');
  const mainRepoDir = join(TEST_REPO_DIR, 'main');

  if (fs.existsSync(mainRepoDir)) {
    const { stdout } = await exec(
      ['git', 'worktree', 'list', '--porcelain'],
      mainRepoDir,
    );
    const wtPaths = stdout
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length))
      .filter((p) => p !== mainRepoDir);

    for (const wt of wtPaths) {
      await exec(['git', 'worktree', 'remove', '--force', wt], mainRepoDir);
    }
  }

  if (fs.existsSync(TEST_REPO_DIR)) {
    fs.rmSync(TEST_REPO_DIR, { recursive: true });
  }
}

describe('integration', () => {
  let originalCwd: string;
  let mainRepoDir: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    await setupTestRepo();
    mainRepoDir = join(TEST_REPO_DIR, 'main');
    vi.spyOn(paths, 'getProjectId').mockResolvedValue('test-project');
    vi.spyOn(paths, 'getXdgDataDir').mockReturnValue(
      join(TEST_REPO_DIR, '.xdg-data'),
    );
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await cleanupTestRepo();
  });

  describe('createIntegrationBranch', () => {
    it('should create integration branch from main HEAD', async () => {
      const planId = 'test-plan-1';
      const result = await createIntegrationBranch(planId);

      expect(result.branch).toBe(`mc/integration-${planId}`);
      expect(result.worktreePath).toContain(`mc-integration-${planId}`);

      const { stdout } = await exec(['git', 'branch', '--list'], mainRepoDir);
      expect(stdout).toContain(`mc/integration-${planId}`);
    });

    it('should create worktree at expected path', async () => {
      const planId = 'test-plan-2';
      const result = await createIntegrationBranch(planId);

      const { stdout } = await exec(
        ['git', 'worktree', 'list', '--porcelain'],
        mainRepoDir,
      );
      expect(stdout).toContain(result.worktreePath);
    });

    it('should recreate branch when it already exists', async () => {
      const planId = 'test-plan-3';

      const result1 = await createIntegrationBranch(planId);
      const result2 = await createIntegrationBranch(planId);

      expect(result2.branch).toBe(result1.branch);
      expect(result2.worktreePath).toBe(result1.worktreePath);

      const { stdout } = await exec(['git', 'branch', '--list'], mainRepoDir);
      const branchLines = stdout
        .split('\n')
        .filter((line) => line.includes(`mc/integration-${planId}`));
      expect(branchLines.length).toBe(1);
    });
  });

  describe('getIntegrationWorktree', () => {
    it('should return worktree path for existing integration branch', async () => {
      const planId = 'test-plan-4';
      const createResult = await createIntegrationBranch(planId);
      const worktreePath = await getIntegrationWorktree(planId);

      expect(worktreePath).toBe(createResult.worktreePath);
    });

    it('should throw when worktree does not exist', async () => {
      const planId = 'non-existent-plan';

      try {
        await getIntegrationWorktree(planId);
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e instanceof Error).toBe(true);
        expect((e as Error).message).toContain('not found');
      }
    });
  });

  describe('deleteIntegrationBranch', () => {
    it('should delete integration branch and worktree', async () => {
      const planId = 'test-plan-5';
      const createResult = await createIntegrationBranch(planId);

      let { stdout } = await exec(['git', 'branch', '--list'], mainRepoDir);
      expect(stdout).toContain(`mc/integration-${planId}`);

      await deleteIntegrationBranch(planId);

      ({ stdout } = await exec(['git', 'branch', '--list'], mainRepoDir));
      expect(stdout).not.toContain(`mc/integration-${planId}`);

      const { stdout: wtStdout } = await exec(
        ['git', 'worktree', 'list', '--porcelain'],
        mainRepoDir,
      );
      expect(wtStdout).not.toContain(createResult.worktreePath);
    });

    it('should handle deletion gracefully when already deleted', async () => {
      const planId = 'test-plan-6';
      await createIntegrationBranch(planId);

      await deleteIntegrationBranch(planId);
      await deleteIntegrationBranch(planId);
    });
  });

  describe('refreshIntegrationFromMain', () => {
    it('should refresh without conflicts', async () => {
      const planId = 'test-plan-7';
      await createIntegrationBranch(planId);

      const filePath = join(mainRepoDir, 'test.txt');
      const fs = await import('fs');
      fs.writeFileSync(filePath, 'updated content');
      await mustExec(['git', 'add', 'test.txt'], mainRepoDir);
      await mustExec(['git', 'commit', '-m', 'update on main'], mainRepoDir);
      await mustExec(['git', 'push', 'origin', 'main'], mainRepoDir);

      const result = await refreshIntegrationFromMain(planId);

      expect(result.success).toBe(true);
      expect(result.conflicts).toBeUndefined();
    });

    it('should detect conflicts during refresh', async () => {
      const planId = 'test-plan-8';
      const createResult = await createIntegrationBranch(planId);

      const filePath = join(mainRepoDir, 'test.txt');
      const fs = await import('fs');
      fs.writeFileSync(filePath, 'main version');
      await mustExec(['git', 'add', 'test.txt'], mainRepoDir);
      await mustExec(['git', 'commit', '-m', 'main change'], mainRepoDir);
      await mustExec(['git', 'push', 'origin', 'main'], mainRepoDir);

      const integrationFilePath = join(createResult.worktreePath, 'test.txt');
      fs.writeFileSync(integrationFilePath, 'integration version');
      await mustExec(['git', 'add', 'test.txt'], {
        cwd: createResult.worktreePath,
      });
      await mustExec(['git', 'commit', '-m', 'integration change'], {
        cwd: createResult.worktreePath,
      });

      const result = await refreshIntegrationFromMain(planId);

      expect(result.success).toBe(false);
      expect(result.conflicts).toBeDefined();
      expect(result.conflicts!.length).toBeGreaterThan(0);

      const { stdout } = await exec(['git', 'status', '--porcelain'], {
        cwd: createResult.worktreePath,
      });
      expect(stdout).not.toContain('REBASE');
    });
  });
});
