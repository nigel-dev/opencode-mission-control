import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import * as jobState from '../../src/lib/job-state';

const { getCompactionContext } = await import('../../src/hooks/compaction');

let mockGetRunningJobs: Mock;

describe('compaction hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRunningJobs = vi.spyOn(jobState, 'getRunningJobs').mockImplementation(() => [] as any);
  });

  it('should return "No Mission Control jobs running" when no jobs are running', async () => {
    mockGetRunningJobs.mockResolvedValue([]);

    const context = await getCompactionContext();

    expect(context).toBe('No Mission Control jobs running');
  });

  it('should return job summary with single running job', async () => {
    const mockJob = {
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
    };

    mockGetRunningJobs.mockResolvedValue([mockJob]);

    const context = await getCompactionContext();

    expect(context).toBe('Mission Control: 1 job(s) running - feature-auth (running)');
  });

  it('should return job summary with multiple running jobs', async () => {
    const mockJobs = [
      {
        id: 'job-1',
        name: 'feature-auth',
        worktreePath: '/path/to/worktree1',
        branch: 'mc/feature-auth',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session' as const,
        status: 'running' as const,
        prompt: 'Add OAuth support',
        mode: 'vanilla' as const,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'job-2',
        name: 'fix-bug-123',
        worktreePath: '/path/to/worktree2',
        branch: 'mc/fix-bug-123',
        tmuxTarget: 'mc-fix-bug-123',
        placement: 'window' as const,
        status: 'running' as const,
        prompt: 'Fix login redirect',
        mode: 'plan' as const,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'job-3',
        name: 'refactor-api',
        worktreePath: '/path/to/worktree3',
        branch: 'mc/refactor-api',
        tmuxTarget: 'mc-refactor-api',
        placement: 'session' as const,
        status: 'running' as const,
        prompt: 'Refactor API endpoints',
        mode: 'ralph' as const,
        createdAt: new Date().toISOString(),
      },
    ];

    mockGetRunningJobs.mockResolvedValue(mockJobs);

    const context = await getCompactionContext();

    expect(context).toBe(
      'Mission Control: 3 job(s) running - feature-auth (running), fix-bug-123 (running), refactor-api (running)'
    );
  });

  it('should include job names and statuses in the summary', async () => {
    const mockJob = {
      id: 'job-1',
      name: 'test-job',
      worktreePath: '/path/to/worktree',
      branch: 'mc/test-job',
      tmuxTarget: 'mc-test-job',
      placement: 'session' as const,
      status: 'running' as const,
      prompt: 'Test prompt',
      mode: 'vanilla' as const,
      createdAt: new Date().toISOString(),
    };

    mockGetRunningJobs.mockResolvedValue([mockJob]);

    const context = await getCompactionContext();

    expect(context).toContain('test-job');
    expect(context).toContain('running');
    expect(context).toContain('1 job(s)');
  });
});
