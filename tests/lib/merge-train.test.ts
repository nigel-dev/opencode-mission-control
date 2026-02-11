import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'path';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import type { JobSpec } from '../../src/lib/plan-types';
import { MergeTrain, detectInstallCommand, detectTestCommand } from '../../src/lib/merge-train';

type TestRepo = {
  rootDir: string;
  repoDir: string;
  integrationWorktree: string;
};

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

function makeJob(branch: string): JobSpec {
  return {
    id: `${branch}-id`,
    name: branch,
    prompt: `merge ${branch}`,
    status: 'ready_to_merge',
    branch,
  };
}

async function setupRepo(): Promise<TestRepo> {
  const rootDir = mkdtempSync(join(tmpdir(), 'mc-merge-train-'));
  const repoDir = join(rootDir, 'repo');
  const integrationWorktree = join(rootDir, 'integration-worktree');
  mkdirSync(repoDir, { recursive: true });

  await mustExec(['git', 'init'], repoDir);
  await mustExec(['git', 'config', 'user.email', 'test@test.com'], repoDir);
  await mustExec(['git', 'config', 'user.name', 'Test'], repoDir);

  writeFileSync(
    join(repoDir, 'package.json'),
    JSON.stringify({ scripts: { test: 'true' } }, null, 2),
  );
  writeFileSync(join(repoDir, '.gitignore'), 'node_modules\n');
  writeFileSync(join(repoDir, 'base.txt'), 'base\n');

  await mustExec(['git', 'add', '.'], repoDir);
  await mustExec(['git', 'commit', '-m', 'initial'], repoDir);
  await mustExec(['git', 'branch', '-M', 'main'], repoDir);

  await mustExec(['git', 'branch', 'integration'], repoDir);
  await mustExec(['git', 'worktree', 'add', integrationWorktree, 'integration'], repoDir);
  mkdirSync(join(integrationWorktree, 'node_modules'), { recursive: true });

  return { rootDir, repoDir, integrationWorktree };
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

describe('MergeTrain', () => {
  let testRepo: TestRepo;

  beforeEach(async () => {
    testRepo = await setupRepo();
  });

  afterEach(() => {
    rmSync(testRepo.rootDir, { recursive: true, force: true });
  });

  it('successful merge of single job', async () => {
    await createBranchCommit(testRepo.repoDir, 'feature-one', 'one.txt', 'one\n');

    const train = new MergeTrain(testRepo.integrationWorktree);
    train.enqueue(makeJob('feature-one'));

    const result = await train.processNext();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.testReport.status).toBe('passed');
      expect(result.testReport.command).toBe('true');
      expect(result.testReport.setup.status).toBe('skipped');
    }
    const status = await mustExec(
      ['git', 'status', '--porcelain'],
      testRepo.integrationWorktree,
    );
    expect(status).toBe('');
  });

  it('sequentially merges two non-conflicting jobs in FIFO order', async () => {
    await createBranchCommit(testRepo.repoDir, 'feature-a', 'a.txt', 'a\n');
    await createBranchCommit(testRepo.repoDir, 'feature-b', 'b.txt', 'b\n');

    const train = new MergeTrain(testRepo.integrationWorktree, { mergeStrategy: 'merge' });
    train.enqueue(makeJob('feature-a'));
    train.enqueue(makeJob('feature-b'));

    const first = await train.processNext();
    const second = await train.processNext();

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const log = await mustExec(
      ['git', 'log', '--merges', '--pretty=%s', '-2'],
      testRepo.integrationWorktree,
    );
    const lines = log.split('\n');
    expect(lines[0]).toContain('feature-b');
    expect(lines[1]).toContain('feature-a');
  });

  it('detects merge conflicts and aborts cleanly', async () => {
    writeFileSync(join(testRepo.repoDir, 'conflict.txt'), 'base\n');
    await mustExec(['git', 'add', 'conflict.txt'], testRepo.repoDir);
    await mustExec(['git', 'commit', '-m', 'add conflict file'], testRepo.repoDir);

    await createBranchCommit(
      testRepo.repoDir,
      'feature-left',
      'conflict.txt',
      'left\n',
    );
    await createBranchCommit(
      testRepo.repoDir,
      'feature-right',
      'conflict.txt',
      'right\n',
    );

    const train = new MergeTrain(testRepo.integrationWorktree);
    train.enqueue(makeJob('feature-left'));
    train.enqueue(makeJob('feature-right'));

    const first = await train.processNext();
    const second = await train.processNext();

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.type).toBe('conflict');
      expect(second.files).toContain('conflict.txt');
    }

    const status = await mustExec(
      ['git', 'status', '--porcelain'],
      testRepo.integrationWorktree,
    );
    expect(status).toBe('');
  });

  it('detects test command from package.json', async () => {
    writeFileSync(
      join(testRepo.integrationWorktree, 'package.json'),
      JSON.stringify({ scripts: { test: 'bun test tests/smoke.test.ts' } }, null, 2),
    );

    const command = await detectTestCommand(testRepo.integrationWorktree);
    expect(command).toBe('bun test tests/smoke.test.ts');
  });

  it('detects install command from lockfile', async () => {
    writeFileSync(
      join(testRepo.integrationWorktree, 'package-lock.json'),
      '{"name":"repo","lockfileVersion":3}',
    );

    const command = await detectInstallCommand(testRepo.integrationWorktree);
    expect(command).toBe('npm ci');
  });

  it('installs dependencies when node_modules is missing before tests', async () => {
    await createBranchCommit(testRepo.repoDir, 'feature-install', 'install.txt', 'install\n');

    rmSync(join(testRepo.integrationWorktree, 'node_modules'), {
      recursive: true,
      force: true,
    });

    writeFileSync(
      join(testRepo.integrationWorktree, 'package.json'),
      JSON.stringify(
        {
          name: 'repo',
          version: '1.0.0',
          packageManager: 'bun@1.0.0',
          scripts: { test: 'test -d node_modules' },
        },
        null,
        2,
      ),
    );

    const train = new MergeTrain(testRepo.integrationWorktree, {
      testCommand: 'test -d node_modules',
      testTimeout: 60000,
    });
    train.enqueue(makeJob('feature-install'));

    const result = await train.processNext();

    expect(result.success).toBe(true);
    expect(existsSync(join(testRepo.integrationWorktree, 'node_modules'))).toBe(true);
  });

  it('runs configured setup commands before tests', async () => {
    await createBranchCommit(testRepo.repoDir, 'feature-setup', 'setup.txt', 'setup\n');

    rmSync(join(testRepo.integrationWorktree, '.deps-ready'), {
      recursive: true,
      force: true,
    });

    const train = new MergeTrain(testRepo.integrationWorktree, {
      setupCommands: ['touch .deps-ready'],
      testCommand: 'test -f .deps-ready',
      testTimeout: 60000,
    });
    train.enqueue(makeJob('feature-setup'));

    const result = await train.processNext();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.testReport.setup.status).toBe('passed');
      expect(result.testReport.setup.commands).toEqual(['touch .deps-ready']);
    }
    expect(existsSync(join(testRepo.integrationWorktree, '.deps-ready'))).toBe(true);
  });

  it('reports skipped tests when no test command is configured or detected', async () => {
    await createBranchCommit(testRepo.repoDir, 'feature-skip-tests', 'skip.txt', 'skip\n');

    rmSync(join(testRepo.integrationWorktree, 'package.json'), {
      force: true,
    });

    const train = new MergeTrain(testRepo.integrationWorktree, {
      testTimeout: 60000,
    });
    train.enqueue(makeJob('feature-skip-tests'));

    const result = await train.processNext();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.testReport.status).toBe('skipped');
      expect(result.testReport.reason).toContain('No test command configured or detected');
      expect(result.testReport.setup.status).toBe('skipped');
    }
  });

  it('rolls back merge when setup command fails', async () => {
    await createBranchCommit(
      testRepo.repoDir,
      'feature-setup-fail',
      'setup-fail.txt',
      'setup-fail\n',
    );

    const headBefore = await mustExec(
      ['git', 'rev-parse', 'HEAD'],
      testRepo.integrationWorktree,
    );

    const train = new MergeTrain(testRepo.integrationWorktree, {
      setupCommands: ['false'],
      testCommand: 'true',
      testTimeout: 60000,
    });
    train.enqueue(makeJob('feature-setup-fail'));

    const result = await train.processNext();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.type).toBe('test_failure');
      expect(result.output).toContain('Dependency setup command failed');
      expect(result.testReport?.status).toBe('skipped');
      expect(result.testReport?.setup.status).toBe('failed');
    }

    const headAfter = await mustExec(
      ['git', 'rev-parse', 'HEAD'],
      testRepo.integrationWorktree,
    );
    expect(headAfter).toBe(headBefore);
  });

  it('rolls back merge when tests fail', async () => {
    await createBranchCommit(testRepo.repoDir, 'feature-fail', 'fail.txt', 'fail\n');

    writeFileSync(
      join(testRepo.integrationWorktree, 'package.json'),
      JSON.stringify({ scripts: { test: 'false' } }, null, 2),
    );

    const headBefore = await mustExec(
      ['git', 'rev-parse', 'HEAD'],
      testRepo.integrationWorktree,
    );

    const train = new MergeTrain(testRepo.integrationWorktree);
    train.enqueue(makeJob('feature-fail'));
    const result = await train.processNext();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.type).toBe('test_failure');
      expect(result.testReport?.status).toBe('failed');
      expect(result.testReport?.command).toBe('false');
    }

    const headAfter = await mustExec(
      ['git', 'rev-parse', 'HEAD'],
      testRepo.integrationWorktree,
    );
    expect(headAfter).toBe(headBefore);
  });

  it('kills timed out tests and rolls back merge', async () => {
    await createBranchCommit(testRepo.repoDir, 'feature-timeout', 'timeout.txt', 'timeout\n');

    const headBefore = await mustExec(
      ['git', 'rev-parse', 'HEAD'],
      testRepo.integrationWorktree,
    );

    const train = new MergeTrain(testRepo.integrationWorktree, {
      testCommand: 'sleep 2',
      testTimeout: 100,
    });

    train.enqueue(makeJob('feature-timeout'));
    const result = await train.processNext();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.type).toBe('test_failure');
      expect(result.output).toContain('timed out');
    }

    const headAfter = await mustExec(
      ['git', 'rev-parse', 'HEAD'],
      testRepo.integrationWorktree,
    );
    expect(headAfter).toBe(headBefore);
  });

  it('processAll processes entire queue', async () => {
    await createBranchCommit(testRepo.repoDir, 'feature-all-1', 'all-1.txt', 'all-1\n');
    await createBranchCommit(testRepo.repoDir, 'feature-all-2', 'all-2.txt', 'all-2\n');

    const train = new MergeTrain(testRepo.integrationWorktree);
    train.enqueue(makeJob('feature-all-1'));
    train.enqueue(makeJob('feature-all-2'));

    const results = await train.processAll();

    expect(results.length).toBe(2);
    expect(results[0].job.branch).toBe('feature-all-1');
    expect(results[1].job.branch).toBe('feature-all-2');
    expect(results.every((entry) => entry.result.success)).toBe(true);
    expect(train.getQueue().length).toBe(0);
  });

  it('getQueue returns a copy', () => {
    const train = new MergeTrain(testRepo.integrationWorktree);
    train.enqueue(makeJob('feature-copy'));

    const queue = train.getQueue();
    queue.length = 0;

    expect(train.getQueue().length).toBe(1);
  });
});
