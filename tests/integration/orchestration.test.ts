import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn, type Mock } from 'bun:test';
import type { Job } from '../../src/lib/job-state';
import { addJob, loadJobState, updateJob } from '../../src/lib/job-state';
import { Orchestrator } from '../../src/lib/orchestrator';
import { loadPlan, updatePlanJob } from '../../src/lib/plan-state';
import type { JobSpec, PlanSpec } from '../../src/lib/plan-types';
import * as pathsMod from '../../src/lib/paths';
import * as tmuxMod from '../../src/lib/tmux';

type TestRepo = {
  path: string;
  cleanup: () => void;
  rootDir: string;
};

type MockTmuxResult = {
  createSession: Mock<any>;
  sendKeys: Mock<any>;
  killSession: Mock<any>;
  isPaneRunning: Mock<any>;
};

type MockGhResult = {
  prCreate: Mock<any>;
};

class FakeMonitor extends EventEmitter {}

const DEFAULT_CONFIG = {
  defaultPlacement: 'session' as const,
  pollInterval: 10_000,
  idleThreshold: 300_000,
  worktreeBasePath: '/tmp',
  omo: { enabled: false, defaultMode: 'vanilla' as const },
  maxParallel: 3,
};

if (process.env.MC_ORCHESTRATION_ISOLATED !== '1') {
  describe('orchestration integration suite', () => {
    it('runs in an isolated subprocess', () => {
      const result = spawnSync('bun', ['test', 'tests/integration/orchestration.test.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, MC_ORCHESTRATION_ISOLATED: '1' },
        encoding: 'utf8',
      });

      if (result.status !== 0) {
        throw new Error([result.stdout, result.stderr].filter(Boolean).join('\n'));
      }

      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      expect(output).toContain('4 pass');
      expect(output).toContain('0 fail');
    }, 120000);
  });
} else {

let originalCwd = process.cwd();
let activeRepo: TestRepo | null = null;
let activeProjectId = '';
let activeStateDir = '';
let activeOrchestrators: Orchestrator[] = [];

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

async function createTestRepo(): Promise<{ path: string; cleanup: () => void }> {
  const rootDir = mkdtempSync(join(tmpdir(), 'mc-orchestration-it-'));
  const bareRepoPath = join(rootDir, 'remote.git');
  const repoPath = join(rootDir, 'repo');

  mkdirSync(bareRepoPath, { recursive: true });
  await mustExec(['git', 'init', '--bare'], bareRepoPath);

  mkdirSync(repoPath, { recursive: true });
  await mustExec(['git', 'init'], repoPath);
  await mustExec(['git', 'config', 'user.email', 'test@test.com'], repoPath);
  await mustExec(['git', 'config', 'user.name', 'Test User'], repoPath);

  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({ scripts: { test: "echo 'Tests pass'" } }, null, 2),
  );
  writeFileSync(join(repoPath, 'README.md'), '# Mission Control\n');
  writeFileSync(join(repoPath, 'src', 'index.ts'), "export const value = 'initial';\n");

  await mustExec(['git', 'add', '.'], repoPath);
  await mustExec(['git', 'commit', '-m', 'initial commit'], repoPath);
  await mustExec(['git', 'branch', '-M', 'main'], repoPath);
  await mustExec(['git', 'remote', 'add', 'origin', bareRepoPath], repoPath);
  await mustExec(['git', 'push', '-u', 'origin', 'main'], repoPath);

  const cleanup = () => {
    rmSync(rootDir, { recursive: true, force: true });
  };

  activeRepo = { path: repoPath, cleanup, rootDir };
  return { path: repoPath, cleanup };
}

function mockTmux(): MockTmuxResult {
  const createSession = spyOn(tmuxMod, 'createSession').mockResolvedValue(undefined);
  spyOn(tmuxMod, 'createWindow').mockResolvedValue(undefined);
  spyOn(tmuxMod, 'getCurrentSession').mockReturnValue('main');
  spyOn(tmuxMod, 'isInsideTmux').mockReturnValue(true);
  spyOn(tmuxMod, 'isTmuxHealthy').mockResolvedValue(true);
  const sendKeys = spyOn(tmuxMod, 'sendKeys').mockResolvedValue(undefined);
  const killSession = spyOn(tmuxMod, 'killSession').mockResolvedValue(undefined);
  spyOn(tmuxMod, 'killWindow').mockResolvedValue(undefined);
  spyOn(tmuxMod, 'setPaneDiedHook').mockResolvedValue(undefined);
  const isPaneRunning = spyOn(tmuxMod, 'isPaneRunning').mockResolvedValue(true);

  return {
    createSession: createSession as unknown as Mock<any>,
    sendKeys: sendKeys as unknown as Mock<any>,
    killSession: killSession as unknown as Mock<any>,
    isPaneRunning: isPaneRunning as unknown as Mock<any>,
  };
}

function mockGh(orchestrator: Orchestrator): MockGhResult {
  const prCreate = mock(async (command: string[]) => {
    expect(command).toEqual(['gh', 'pr', 'create']);
    return 'https://github.com/example/repo/pull/1';
  });

  spyOn(orchestrator as any, 'createPR').mockImplementation(async () => {
    return prCreate(['gh', 'pr', 'create']);
  });

  return { prCreate: prCreate as unknown as Mock<any> };
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const plan = await loadPlan();
  const statuses = plan?.jobs.map((job) => `${job.id}:${job.status}`).join(', ') ?? 'no-plan';
  throw new Error(`Condition not met within ${timeoutMs}ms (plan=${plan?.status ?? 'none'} jobs=${statuses})`);
}

async function kickReconciler(orchestrator: Orchestrator): Promise<void> {
  const reconcile = (orchestrator as any).reconcile;
  if (typeof reconcile === 'function') {
    await reconcile.call(orchestrator);
  }
}

async function simulateJobCompletion(
  jobId: string,
  monitor: FakeMonitor,
  orchestrator: Orchestrator,
): Promise<void> {
  const plan = await loadPlan();
  if (!plan) {
    throw new Error('No active plan found');
  }

  const jobSpec = plan.jobs.find((job) => job.id === jobId);
  if (!jobSpec) {
    throw new Error(`Job ${jobId} not found in plan`);
  }

  const state = await loadJobState();
  const runningJob = state.jobs.find(
    (job) => job.planId === plan.id && job.name === jobSpec.name,
  );

  if (!runningJob) {
    throw new Error(`Running job state not found for ${jobSpec.name}`);
  }

  await updateJob(runningJob.id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
  });

  monitor.emit('complete', {
    id: runningJob.id,
    name: jobSpec.name,
    planId: plan.id,
    status: 'completed',
    completedAt: new Date().toISOString(),
  } as Job);

  await new Promise((resolve) => setTimeout(resolve, 0));
  await kickReconciler(orchestrator);
}

async function commitInJobWorktree(jobId: string, filePath: string, content: string): Promise<void> {
  const plan = await loadPlan();
  if (!plan) {
    throw new Error('No active plan');
  }

  const job = plan.jobs.find((entry) => entry.id === jobId);
  if (!job?.worktreePath) {
    throw new Error(`No worktree for job ${jobId}`);
  }

  const fullPath = join(job.worktreePath, filePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  await mustExec(['git', 'add', '.'], job.worktreePath);
  await mustExec(['git', 'commit', '-m', `update ${job.name}`], job.worktreePath);
}

async function getPlanJob(jobId: string): Promise<JobSpec | undefined> {
  const plan = await loadPlan();
  return plan?.jobs.find((job) => job.id === jobId);
}

async function buildPlan(jobs: JobSpec[], name: string): Promise<PlanSpec> {
  if (!activeRepo) {
    throw new Error('No active repo');
  }
  const baseCommit = await mustExec(['git', 'rev-parse', 'main'], activeRepo.path);
  return {
    id: `plan-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name,
    mode: 'autopilot',
    status: 'pending',
    jobs,
    integrationBranch: '',
    baseCommit,
    createdAt: new Date().toISOString(),
  };
}

function installLaunchJobStub(orchestrator: Orchestrator): void {
  spyOn(orchestrator as any, 'launchJob').mockImplementation(async (job: JobSpec) => {
    const plan = await loadPlan();
    if (!plan) {
      throw new Error('No active plan for launch');
    }

    const branch = job.branch ?? `mc/${job.id}`;
    const slug = branch.replace(/[^a-zA-Z0-9_-]/g, '-');
    const worktreePath = join((activeRepo as TestRepo).rootDir, 'job-worktrees', slug);
    mkdirSync(dirname(worktreePath), { recursive: true });

    const branchExists = await exec(['git', 'branch', '--list', branch], activeRepo!.path);
    if (branchExists.stdout.includes(branch)) {
      await mustExec(['git', 'worktree', 'add', worktreePath, branch], activeRepo!.path);
    } else {
      await mustExec(['git', 'worktree', 'add', '-b', branch, worktreePath, 'main'], activeRepo!.path);
    }

    await addJob({
      id: `job-state-${job.id}`,
      name: job.name,
      worktreePath,
      branch,
      tmuxTarget: `mc-${slug}`,
      placement: 'session',
      status: 'running',
      prompt: job.prompt,
      mode: 'vanilla',
      createdAt: new Date().toISOString(),
      planId: plan.id,
    });

    await updatePlanJob(plan.id, job.name, {
      status: 'running',
      branch,
      worktreePath,
      tmuxTarget: `mc-${slug}`,
    });
  });
}

describe('orchestration integration', () => {
  beforeEach(async () => {
    originalCwd = process.cwd();
    const repo = await createTestRepo();
    process.chdir(repo.path);

    activeProjectId = `orchestration-it-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    activeStateDir = join((activeRepo as TestRepo).rootDir, 'state');
    mkdirSync(activeStateDir, { recursive: true });

    spyOn(pathsMod, 'getProjectId').mockResolvedValue(activeProjectId);
    spyOn(pathsMod, 'getDataDir').mockResolvedValue(activeStateDir);
    activeOrchestrators = [];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const orchestrator of activeOrchestrators) {
      const stopReconciler = (orchestrator as any).stopReconciler;
      if (typeof stopReconciler === 'function') {
        stopReconciler.call(orchestrator);
      }
    }
    mock.restore();
    if (activeRepo) {
      activeRepo.cleanup();
      activeRepo = null;
    }

    if (activeProjectId) {
      const integrationDir = join(
        homedir(),
        '.local',
        'share',
        'opencode-mission-control',
        activeProjectId,
      );
      rmSync(integrationDir, { recursive: true, force: true });
    }

    activeProjectId = '';
    activeStateDir = '';
  });

  it('runs full orchestration flow from parallel jobs to PR', async () => {
    const monitor = new FakeMonitor();
    const tmux = mockTmux();
    const orchestrator = new Orchestrator(monitor as any, {
      ...DEFAULT_CONFIG,
      maxParallel: 2,
    } as any);
    activeOrchestrators.push(orchestrator);
    installLaunchJobStub(orchestrator);
    const gh = mockGh(orchestrator);

    const plan = await buildPlan(
      [
        {
          id: 'job-a',
          name: 'Update README',
          prompt: 'Update README details',
          status: 'queued',
          branch: 'mc/update-readme',
        },
        {
          id: 'job-b',
          name: 'Fix bug in index.ts',
          prompt: 'Fix bug in src/index.ts',
          status: 'queued',
          branch: 'mc/fix-index-bug',
        },
        {
          id: 'job-c',
          name: 'Add feature',
          prompt: 'Add feature module',
          status: 'queued',
          dependsOn: ['Fix bug in index.ts'],
          branch: 'mc/add-feature',
        },
      ],
      'Full orchestration plan',
    );

    await orchestrator.startPlan(plan);
    await kickReconciler(orchestrator);

    await waitForCondition(async () => {
      const a = await getPlanJob('job-a');
      const b = await getPlanJob('job-b');
      const c = await getPlanJob('job-c');
      return a?.status === 'running' && b?.status === 'running' && c?.status === 'waiting_deps';
    }, 5000);

    await commitInJobWorktree('job-a', 'README.md', '# Mission Control\n\nUpdated by job A\n');
    await commitInJobWorktree('job-b', 'src/index.ts', "export const value = 'bug-fixed';\n");

    await simulateJobCompletion('job-a', monitor, orchestrator);
    await waitForCondition(async () => (await getPlanJob('job-a'))?.status === 'merged', 5000);

    await simulateJobCompletion('job-b', monitor, orchestrator);
    await waitForCondition(async () => (await getPlanJob('job-b'))?.status === 'merged', 8000);
    await kickReconciler(orchestrator);
    await waitForCondition(async () => (await getPlanJob('job-c'))?.status === 'running', 5000);

    await commitInJobWorktree('job-c', 'src/feature.ts', 'export const featureEnabled = true;\n');
    await simulateJobCompletion('job-c', monitor, orchestrator);

    await waitForCondition(async () => (await loadPlan())?.status === 'completed', 20000);

    const finalPlan = await loadPlan();
    expect(finalPlan?.status).toBe('completed');
    expect(finalPlan?.integrationWorktree).toBeTruthy();

    const integrationWorktree = finalPlan!.integrationWorktree!;
    const readmeText = await Bun.file(join(integrationWorktree, 'README.md')).text();
    const indexText = await Bun.file(join(integrationWorktree, 'src', 'index.ts')).text();
    const featureText = await Bun.file(join(integrationWorktree, 'src', 'feature.ts')).text();
    expect(readmeText).toContain('Updated by job A');
    expect(indexText).toContain('bug-fixed');
    expect(featureText).toContain('featureEnabled');

    const commitCount = await mustExec(
      ['git', 'rev-list', '--count', `${finalPlan!.baseCommit}..${finalPlan!.integrationBranch}`],
      activeRepo!.path,
    );
    expect(Number(commitCount)).toBeGreaterThanOrEqual(3);

    expect(gh.prCreate).toHaveBeenCalledTimes(1);
    const ghCommand = gh.prCreate.mock.calls[0][0] as string[];
    expect(ghCommand).toContain('gh');
    expect(ghCommand).toContain('pr');
    expect(ghCommand).toContain('create');

    expect(tmux.createSession).toHaveBeenCalledTimes(0);
    expect(tmux.sendKeys).toHaveBeenCalledTimes(0);
  }, 30000);

  it('pauses plan on merge conflict for retry instead of failing', async () => {
    const monitor = new FakeMonitor();
    mockTmux();
    const orchestrator = new Orchestrator(monitor as any, {
      ...DEFAULT_CONFIG,
      maxParallel: 2,
    } as any);
    activeOrchestrators.push(orchestrator);
    installLaunchJobStub(orchestrator);
    mockGh(orchestrator);

    const plan = await buildPlan(
      [
        {
          id: 'job-1',
          name: 'Conflicting update one',
          prompt: 'Update README first way',
          status: 'queued',
          branch: 'mc/conflict-one',
        },
        {
          id: 'job-2',
          name: 'Conflicting update two',
          prompt: 'Update README second way',
          status: 'queued',
          branch: 'mc/conflict-two',
        },
      ],
      'Conflict plan',
    );

    await orchestrator.startPlan(plan);
    await kickReconciler(orchestrator);

    await waitForCondition(async () => {
      const first = await getPlanJob('job-1');
      const second = await getPlanJob('job-2');
      return first?.status === 'running' && second?.status === 'running';
    }, 5000);

    await commitInJobWorktree('job-1', 'README.md', '# Mission Control\n\nConflict from job one\n');
    await commitInJobWorktree('job-2', 'README.md', '# Mission Control\n\nConflict from job two\n');

    await simulateJobCompletion('job-1', monitor, orchestrator);
    await waitForCondition(async () => (await getPlanJob('job-1'))?.status === 'merged', 5000);

    await simulateJobCompletion('job-2', monitor, orchestrator);
    await waitForCondition(async () => {
      const currentPlan = await loadPlan();
      const second = currentPlan?.jobs.find((job) => job.id === 'job-2');
      return currentPlan?.status === 'paused' && second?.status === 'needs_rebase';
    }, 8000);

    const pausedPlan = await loadPlan();
    expect(pausedPlan?.status).toBe('paused');
    expect(pausedPlan?.checkpoint).toBe('on_error');
    expect(pausedPlan?.jobs.find((job) => job.id === 'job-2')?.status).toBe('needs_rebase');

    const status = await mustExec(
      ['git', 'status', '--porcelain'],
      pausedPlan!.integrationWorktree!,
    );
    expect(status).toBe('');

    const mergeHead = await exec(
      ['git', 'rev-parse', '-q', '--verify', 'MERGE_HEAD'],
      pausedPlan!.integrationWorktree!,
    );
    expect(mergeHead.exitCode).not.toBe(0);
  }, 30000);

  it('resumes a persisted plan after orchestrator restart', async () => {
    const monitor1 = new FakeMonitor();
    const monitor2 = new FakeMonitor();
    const tmux = mockTmux();

    const orchestrator1 = new Orchestrator(monitor1 as any, {
      ...DEFAULT_CONFIG,
      maxParallel: 3,
    } as any);
    activeOrchestrators.push(orchestrator1);
    installLaunchJobStub(orchestrator1);
    mockGh(orchestrator1);

    const plan = await buildPlan(
      [
        {
          id: 'job-a',
          name: 'Resume A',
          prompt: 'Complete resume A',
          status: 'queued',
          branch: 'mc/resume-a',
        },
        {
          id: 'job-b',
          name: 'Resume B',
          prompt: 'Complete resume B',
          status: 'queued',
          branch: 'mc/resume-b',
        },
        {
          id: 'job-c',
          name: 'Resume C',
          prompt: 'Complete resume C',
          status: 'queued',
          branch: 'mc/resume-c',
        },
      ],
      'Resume plan',
    );

    await orchestrator1.startPlan(plan);
    await kickReconciler(orchestrator1);

    await waitForCondition(async () => {
      const a = await getPlanJob('job-a');
      const b = await getPlanJob('job-b');
      const c = await getPlanJob('job-c');
      return a?.status === 'running' && b?.status === 'running' && c?.status === 'running';
    }, 5000);

    await commitInJobWorktree('job-a', 'README.md', '# Mission Control\n\nResume A done\n');
    await simulateJobCompletion('job-a', monitor1, orchestrator1);
    await waitForCondition(async () => (await getPlanJob('job-a'))?.status === 'merged', 8000);

    const planFile = Bun.file(join(activeStateDir, 'plan.json'));
    const jobsFile = Bun.file(join(activeStateDir, 'jobs.json'));
    expect(await planFile.exists()).toBe(true);
    expect(await jobsFile.exists()).toBe(true);

    const orchestrator2 = new Orchestrator(monitor2 as any, {
      ...DEFAULT_CONFIG,
      maxParallel: 3,
    } as any);
    activeOrchestrators.push(orchestrator2);
    installLaunchJobStub(orchestrator2);
    mockGh(orchestrator2);

    await orchestrator2.resumePlan();

    const resumedPlan = await loadPlan();
    expect(resumedPlan?.jobs.find((job) => job.id === 'job-a')?.status).toBe('merged');
    expect(resumedPlan?.jobs.find((job) => job.id === 'job-b')?.status).toBe('running');
    expect(resumedPlan?.jobs.find((job) => job.id === 'job-c')?.status).toBe('running');
    expect(tmux.isPaneRunning).toHaveBeenCalled();

    await commitInJobWorktree('job-b', 'src/resume-b.ts', 'export const resumeB = true;\n');
    await commitInJobWorktree('job-c', 'src/resume-c.ts', 'export const resumeC = true;\n');
    await simulateJobCompletion('job-b', monitor2, orchestrator2);
    await simulateJobCompletion('job-c', monitor2, orchestrator2);

    await waitForCondition(async () => (await loadPlan())?.status === 'completed', 20000);
    expect((await loadPlan())?.status).toBe('completed');
  }, 30000);

  it('enforces dependencies so dependent jobs wait for merged prerequisites', async () => {
    const monitor = new FakeMonitor();
    mockTmux();
    const orchestrator = new Orchestrator(monitor as any, {
      ...DEFAULT_CONFIG,
      maxParallel: 3,
    } as any);
    activeOrchestrators.push(orchestrator);
    installLaunchJobStub(orchestrator);
    mockGh(orchestrator);

    const plan = await buildPlan(
      [
        {
          id: 'job-a',
          name: 'Independent A',
          prompt: 'Run A',
          status: 'queued',
          branch: 'mc/dep-a',
        },
        {
          id: 'job-b',
          name: 'Dependent B',
          prompt: 'Run B after A',
          status: 'queued',
          dependsOn: ['Independent A'],
          branch: 'mc/dep-b',
        },
        {
          id: 'job-c',
          name: 'Independent C',
          prompt: 'Run C',
          status: 'queued',
          branch: 'mc/dep-c',
        },
      ],
      'Dependency plan',
    );

    await orchestrator.startPlan(plan);
    await kickReconciler(orchestrator);

    await waitForCondition(async () => {
      const a = await getPlanJob('job-a');
      const b = await getPlanJob('job-b');
      const c = await getPlanJob('job-c');
      return a?.status === 'running' && c?.status === 'running' && b?.status === 'waiting_deps';
    }, 5000);

    await commitInJobWorktree('job-a', 'src/dep-a.ts', 'export const depA = true;\n');
    await commitInJobWorktree('job-c', 'src/dep-c.ts', 'export const depC = true;\n');

    await simulateJobCompletion('job-a', monitor, orchestrator);
    await waitForCondition(async () => (await getPlanJob('job-a'))?.status === 'merged', 8000);
    await kickReconciler(orchestrator);
    await waitForCondition(async () => (await getPlanJob('job-b'))?.status === 'running', 5000);

    await commitInJobWorktree('job-b', 'src/dep-b.ts', 'export const depB = true;\n');
    await simulateJobCompletion('job-b', monitor, orchestrator);
    await simulateJobCompletion('job-c', monitor, orchestrator);
    await kickReconciler(orchestrator);

    await waitForCondition(async () => (await loadPlan())?.status === 'completed', 20000);
    expect((await loadPlan())?.status).toBe('completed');
  }, 30000);
});
}
