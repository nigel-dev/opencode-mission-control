import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as jobState from '../../src/lib/job-state';
import * as reports from '../../src/lib/reports';
import * as awareness from '../../src/hooks/awareness';

const { getCompactionContext, getJobCompactionContext } = await import('../../src/hooks/compaction');

let mockLoadJobState: any;
let mockReadAllReports: any;
let mockGetWorktreeContext: any;

function makeJob(overrides: Partial<jobState.Job> = {}): jobState.Job {
  return {
    id: 'job-1',
    name: 'feature-auth',
    worktreePath: '/path/to/worktree',
    branch: 'mc/feature-auth',
    tmuxTarget: 'mc-feature-auth',
    placement: 'session' as const,
    status: 'running' as const,
    prompt: 'Add OAuth support',
    mode: 'vanilla' as const,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeJobState(jobs: jobState.Job[]): jobState.JobState {
  return { version: 2, jobs, updatedAt: new Date().toISOString() };
}

describe('compaction hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadJobState = vi.spyOn(jobState, 'loadJobState').mockResolvedValue(makeJobState([]));
    mockReadAllReports = vi.spyOn(reports, 'readAllReports').mockResolvedValue([]);
    mockGetWorktreeContext = vi.spyOn(awareness, 'getWorktreeContext').mockResolvedValue({ isInJob: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return "No Mission Control jobs running" when no jobs exist', async () => {
    mockLoadJobState.mockResolvedValue(makeJobState([]));

    const context = await getCompactionContext();

    expect(context).toBe('No Mission Control jobs running');
  });

  it('should return rich job card for a single running job', async () => {
    const job = makeJob({
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    mockLoadJobState.mockResolvedValue(makeJobState([job]));

    const context = await getCompactionContext();

    expect(context).toContain('Mission Control (1 running):');
    expect(context).toContain('feature-auth');
    expect(context).toContain('[running 5m]');
    expect(context).toContain('mc/feature-auth');
    expect(context).toContain('vanilla');
    expect(context).toContain('"Add OAuth support"');
    expect(context).toContain('report: none');
    expect(context).toContain('Commands: mc_overview');
  });

  it('should return rich cards for multiple running jobs', async () => {
    const jobs = [
      makeJob({
        id: 'job-1',
        name: 'feature-auth',
        branch: 'mc/feature-auth',
        prompt: 'Add OAuth support',
        mode: 'vanilla' as const,
        createdAt: new Date(Date.now() - 15 * 60_000).toISOString(),
      }),
      makeJob({
        id: 'job-2',
        name: 'fix-bug-123',
        branch: 'mc/fix-bug-123',
        prompt: 'Fix login redirect',
        mode: 'plan' as const,
        createdAt: new Date(Date.now() - 8 * 60_000).toISOString(),
      }),
      makeJob({
        id: 'job-3',
        name: 'refactor-api',
        branch: 'mc/refactor-api',
        prompt: 'Refactor API endpoints',
        mode: 'ralph' as const,
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      }),
    ];
    mockLoadJobState.mockResolvedValue(makeJobState(jobs));

    const context = await getCompactionContext();

    expect(context).toContain('Mission Control (3 running):');
    expect(context).toContain('feature-auth');
    expect(context).toContain('fix-bug-123');
    expect(context).toContain('refactor-api');
    expect(context).toContain('[running 15m]');
    expect(context).toContain('[running 8m]');
    expect(context).toContain('[running 2m]');
  });

  it('should include completed and failed counts in summary', async () => {
    const jobs = [
      makeJob({ id: 'job-1', name: 'running-job', status: 'running', createdAt: new Date(Date.now() - 3 * 60_000).toISOString() }),
      makeJob({ id: 'job-2', name: 'done-job', status: 'completed' }),
      makeJob({ id: 'job-3', name: 'fail-job', status: 'failed' }),
    ];
    mockLoadJobState.mockResolvedValue(makeJobState(jobs));

    const context = await getCompactionContext();

    expect(context).toContain('Mission Control (1 running, 1 completed, 1 failed):');
  });

  it('should show summary when all jobs are completed/failed with no running', async () => {
    const jobs = [
      makeJob({ id: 'job-1', name: 'done-1', status: 'completed' }),
      makeJob({ id: 'job-2', name: 'done-2', status: 'completed' }),
      makeJob({ id: 'job-3', name: 'fail-1', status: 'failed' }),
    ];
    mockLoadJobState.mockResolvedValue(makeJobState(jobs));

    const context = await getCompactionContext();

    expect(context).toBe('Mission Control (2 completed, 1 failed): No active jobs.');
  });

  it('should truncate long prompts to 60 characters', async () => {
    const longPrompt = 'This is a very long prompt that exceeds sixty characters and should be truncated';
    const job = makeJob({
      prompt: longPrompt,
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
    mockLoadJobState.mockResolvedValue(makeJobState([job]));

    const context = await getCompactionContext();

    expect(context).not.toContain(longPrompt);
    expect(context).toContain('...');
  });

  it('should include report data when available', async () => {
    const job = makeJob({
      id: 'job-1',
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    mockLoadJobState.mockResolvedValue(makeJobState([job]));
    mockReadAllReports.mockResolvedValue([
      {
        jobId: 'job-1',
        jobName: 'feature-auth',
        status: 'working',
        message: 'implementing refresh tokens',
        timestamp: new Date().toISOString(),
      },
    ]);

    const context = await getCompactionContext();

    expect(context).toContain('report: working - implementing refresh tokens');
    expect(context).not.toContain('[stale]');
  });

  it('should mark job as stale when running > 10 min with no report', async () => {
    const job = makeJob({
      id: 'job-1',
      createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    });
    mockLoadJobState.mockResolvedValue(makeJobState([job]));
    mockReadAllReports.mockResolvedValue([]);

    const context = await getCompactionContext();

    expect(context).toContain('[stale]');
  });

  it('should not mark as stale when running < 10 min with no report', async () => {
    const job = makeJob({
      id: 'job-1',
      createdAt: new Date(Date.now() - 8 * 60_000).toISOString(),
    });
    mockLoadJobState.mockResolvedValue(makeJobState([job]));
    mockReadAllReports.mockResolvedValue([]);

    const context = await getCompactionContext();

    expect(context).not.toContain('[stale]');
  });

  it('should mark job as stale when last report is > 15 min old', async () => {
    const job = makeJob({
      id: 'job-1',
      createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    mockLoadJobState.mockResolvedValue(makeJobState([job]));
    mockReadAllReports.mockResolvedValue([
      {
        jobId: 'job-1',
        jobName: 'feature-auth',
        status: 'working',
        message: 'old update',
        timestamp: new Date(Date.now() - 16 * 60_000).toISOString(),
      },
    ]);

    const context = await getCompactionContext();

    expect(context).toContain('[stale]');
    expect(context).toContain('report: working - old update');
  });

  it('should format hours correctly for long-running jobs', async () => {
    const job = makeJob({
      createdAt: new Date(Date.now() - 75 * 60_000).toISOString(),
    });
    mockLoadJobState.mockResolvedValue(makeJobState([job]));

    const context = await getCompactionContext();

    expect(context).toContain('[running 1h15m]');
  });
});

describe('getJobCompactionContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorktreeContext = vi.spyOn(awareness, 'getWorktreeContext').mockResolvedValue({ isInJob: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return job context string with jobName, mode, jobPrompt, and mc_report when in job', async () => {
    mockGetWorktreeContext.mockResolvedValue({
      isInJob: true,
      jobName: 'feature-auth',
      jobPrompt: 'Add OAuth support',
      mode: 'vanilla',
    });

    const context = await getJobCompactionContext();

    expect(context).toContain('feature-auth');
    expect(context).toContain('vanilla');
    expect(context).toContain('Add OAuth support');
    expect(context).toContain('mc_report');
  });

  it('should return generic fallback when job context incomplete (isInJob true but no jobName)', async () => {
    mockGetWorktreeContext.mockResolvedValue({
      isInJob: true,
      jobName: undefined,
      jobPrompt: 'Some task',
      mode: 'vanilla',
    });

    const context = await getJobCompactionContext();

    expect(context).toBe('Mission Control Job Agent: Focus on your assigned task. Use mc_report to report status.');
  });

  it('should return generic fallback when not in job', async () => {
    mockGetWorktreeContext.mockResolvedValue({ isInJob: false });

    const context = await getJobCompactionContext();

    expect(context).toBe('Mission Control Job Agent: Focus on your assigned task. Use mc_report to report status.');
  });
});
