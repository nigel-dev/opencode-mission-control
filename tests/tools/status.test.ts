import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as jobRuntime from '../../src/lib/job-runtime';
import * as worktree from '../../src/lib/worktree';
import * as reports from '../../src/lib/reports';
import * as orchestratorSingleton from '../../src/lib/orchestrator-singleton';

const { mc_status } = await import('../../src/tools/status');

let mockGetJobByName: Mock;
let mockCaptureJobSession: Mock;
let mockGetJobUsage: Mock;
let mockIsInManagedWorktree: Mock;
let mockGetEventAccumulator: Mock;
let mockReadReport: Mock;

function createMockJob(overrides?: Partial<Job>): Job {
  return {
    id: 'test-job-id',
    name: 'test-job',
    worktreePath: '/tmp/mc-worktrees/test-job',
    branch: 'mc/test-job',
    status: 'running',
    prompt: 'Test prompt',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    sessionID: 'ses_status',
    ...overrides,
  };
}

describe('mc_status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockResolvedValue(createMockJob()) as unknown as Mock;
    mockCaptureJobSession = vi
      .spyOn(jobRuntime, 'captureJobSession')
      .mockResolvedValue('Last line of output') as unknown as Mock;
    mockGetJobUsage = vi
      .spyOn(jobRuntime, 'getJobUsage')
      .mockResolvedValue({ cost: 1.23456, inputTokens: 12000, outputTokens: 3400 }) as unknown as Mock;
    mockIsInManagedWorktree = vi
      .spyOn(worktree, 'isInManagedWorktree')
      .mockResolvedValue({ isManaged: true, worktreePath: '/tmp/mc-worktrees/test-job' }) as unknown as Mock;
    mockReadReport = vi.spyOn(reports, 'readReport').mockResolvedValue(null) as unknown as Mock;
    mockGetEventAccumulator = vi.fn().mockReturnValue(undefined);
    vi.spyOn(orchestratorSingleton, 'getSharedMonitor').mockReturnValue({
      getEventAccumulator: mockGetEventAccumulator,
    } as unknown as ReturnType<typeof orchestratorSingleton.getSharedMonitor>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_status.description).toBe('Get detailed status of a specific job');
    });

    it('should have required arg: name', () => {
      expect(mc_status.input.shape.name).toBeDefined();
    });
  });

  describe('job lookup', () => {
    it('should throw error when job not found', async () => {
      mockGetJobByName.mockResolvedValue(undefined);

      await expect(mc_status.execute({ name: 'nonexistent' })).rejects.toThrow(
        'Job "nonexistent" not found',
      );
    });

    it('should call getJobByName with correct name', async () => {
      await mc_status.execute({ name: 'my-job' });

      expect(mockGetJobByName).toHaveBeenCalledWith('my-job');
    });
  });

  describe('status output', () => {
    it('should include job name, status and ID', async () => {
      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).toContain('Job: test-job');
      expect(result.content).toContain('Status: running');
      expect(result.content).toContain('ID: test-job-id');
    });

    it('should include metadata with branch, session and creation time', async () => {
      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).toContain('Metadata:');
      expect(result.content).toContain('Branch: mc/test-job');
      expect(result.content).toContain('Session: ses_status');
      expect(result.content).toContain('Created:');
    });

    it('should show agent and model only when set', async () => {
      const plain = await mc_status.execute({ name: 'test-job' });
      expect(plain.content).not.toContain('Agent:');
      expect(plain.content).not.toContain('Model:');

      mockGetJobByName.mockResolvedValue(createMockJob({ agent: 'build', model: 'openai/gpt-5#high' }));
      const detailed = await mc_status.execute({ name: 'test-job' });
      expect(detailed.content).toContain('Agent: build');
      expect(detailed.content).toContain('Model: openai/gpt-5#high');
    });

    it('should include paths section with worktree', async () => {
      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).toContain('Paths:');
      expect(result.content).toContain('Worktree: /tmp/mc-worktrees/test-job');
    });

    it('should not mention tmux, placement, mode or ports', async () => {
      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).not.toContain('tmux');
      expect(result.content).not.toContain('Placement:');
      expect(result.content).not.toContain('Mode:');
      expect(result.content).not.toContain('Port:');
      expect(result.content).not.toContain('Server URL:');
      expect(result.content).not.toContain('Exit Code:');
    });

    it('should include git status section', async () => {
      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).toContain('Git Status:');
      expect(result.content).toContain('Files Changed:');
      expect(result.content).toContain('Ahead:');
      expect(result.content).toContain('Behind:');
    });

    it('should include the agent report when present', async () => {
      mockReadReport.mockResolvedValue({
        jobId: 'test-job-id',
        jobName: 'test-job',
        status: 'progress',
        message: 'Halfway there',
        progress: 50,
        timestamp: '2026-01-01T00:00:00.000Z',
      });

      const result = await mc_status.execute({ name: 'test-job' });

      expect(mockReadReport).toHaveBeenCalledWith('test-job-id');
      expect(result.content).toContain('Agent Report:');
      expect(result.content).toContain('Status: progress');
      expect(result.content).toContain('Message: Halfway there');
      expect(result.content).toContain('Progress: 50%');
    });
  });

  describe('recent output', () => {
    it("should show the last 10 lines of the job's session", async () => {
      const result = await mc_status.execute({ name: 'test-job' });

      expect(mockCaptureJobSession).toHaveBeenCalledWith('ses_status', 10);
      expect(result.content).toContain('Recent Output (last 10 lines):');
      expect(result.content).toContain('Last line of output');
    });

    it('should handle a capture failure gracefully', async () => {
      mockCaptureJobSession.mockRejectedValue(new Error('session not found'));

      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).toContain('(unable to capture session output)');
      expect(result.content).toContain('Status: running');
    });

    it('should say so when the job has no session', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob({ sessionID: undefined, status: 'stopped' }));

      const result = await mc_status.execute({ name: 'test-job' });

      expect(mockCaptureJobSession).not.toHaveBeenCalled();
      expect(result.content).toContain('(no session)');
      expect(result.content).not.toContain('Session:');
    });

    it('should show a placeholder when the session has no output yet', async () => {
      mockCaptureJobSession.mockResolvedValue('');

      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).toContain('(no output)');
    });
  });

  describe('usage', () => {
    it('should show cost and tokens for a running job', async () => {
      const result = await mc_status.execute({ name: 'test-job' });

      expect(mockGetJobUsage).toHaveBeenCalledWith('ses_status');
      expect(result.content).toContain('Cost: $1.2346');
      expect(result.content).toContain('Tokens: 12000 in / 3400 out');
    });

    it('should omit usage when it cannot be read', async () => {
      mockGetJobUsage.mockRejectedValue(new Error('session not found'));

      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).not.toContain('Cost:');
      expect(result.content).not.toContain('Tokens:');
      expect(result.content).toContain('Status: running');
    });

    it('should not read usage for finished jobs', async () => {
      mockGetJobByName.mockResolvedValue(
        createMockJob({ status: 'completed', completedAt: new Date().toISOString() }),
      );

      const result = await mc_status.execute({ name: 'test-job' });

      expect(mockGetJobUsage).not.toHaveBeenCalled();
      expect(result.content).not.toContain('Cost:');
    });
  });

  describe('duration calculation', () => {
    it('should show duration for running jobs', async () => {
      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).toMatch(/Duration: \d+[hm]/);
    });

    it('should show duration and completion time for completed jobs', async () => {
      mockGetJobByName.mockResolvedValue(
        createMockJob({
          createdAt: new Date(Date.now() - 3600000).toISOString(),
          completedAt: new Date(Date.now() - 1800000).toISOString(),
          status: 'completed',
        }),
      );

      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).toContain('Duration:');
      expect(result.content).toContain('Completed:');
      expect(result.content).toContain('Status: completed');
    });
  });

  describe('why a job ended the way it did', () => {
    it('should say why a job failed', async () => {
      mockGetJobByName.mockResolvedValue(
        createMockJob({
          status: 'failed',
          completedAt: new Date().toISOString(),
          failureReason: 'its session was deleted',
        }),
      );

      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).toContain('Status: failed\nReason: its session was deleted');
    });

    it('should list the files a finished job left uncommitted', async () => {
      mockGetJobByName.mockResolvedValue(
        createMockJob({
          status: 'completed',
          completedAt: new Date().toISOString(),
          uncommittedChanges: ['src/new.ts', 'README.md'],
        }),
      );

      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).toContain('Needs review: finished with 2 uncommitted file(s) that are not on its branch:');
      expect(result.content).toContain('  - src/new.ts');
      expect(result.content).toContain('  - README.md');
    });

    it('should add nothing for an ordinary job', async () => {
      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).not.toContain('Reason:');
      expect(result.content).not.toContain('Needs review');
    });
  });

  describe('managed worktree detection', () => {
    it('should show managed status', async () => {
      const result = await mc_status.execute({ name: 'test-job' });

      expect(mockIsInManagedWorktree).toHaveBeenCalledWith('/tmp/mc-worktrees/test-job');
      expect(result.content).toContain('Managed: true');
    });

    it('should show unmanaged status', async () => {
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: false });

      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).toContain('Managed: false');
    });
  });

  describe('different job statuses', () => {
    it.each(['running', 'completed', 'failed', 'stopped'] as const)('should handle %s status', async (status) => {
      mockGetJobByName.mockResolvedValue(
        createMockJob({
          status,
          completedAt: status === 'running' ? undefined : new Date().toISOString(),
        }),
      );

      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).toContain(`Status: ${status}`);
    });
  });

  describe('session activity', () => {
    it('should include the activity the monitor accumulated', async () => {
      mockGetEventAccumulator.mockReturnValue({
        filesEdited: ['src/index.ts', 'src/utils.ts'],
        currentTool: 'streaming',
        currentFile: 'src/index.ts',
        lastActivityAt: Date.now(),
        eventCount: 42,
      });

      const result = await mc_status.execute({ name: 'test-job' });

      expect(mockGetEventAccumulator).toHaveBeenCalledWith('test-job-id');
      expect(result.content).toContain('Session Activity:');
      expect(result.content).toContain('Session State: streaming');
      expect(result.content).toContain('Current File: src/index.ts');
      expect(result.content).toContain('Files Edited: 2');
      expect(result.content).toContain('    - src/index.ts');
      expect(result.content).toContain('    - src/utils.ts');
      expect(result.content).toContain('Events Accumulated: 42');
    });

    it('should omit the section when nothing was accumulated', async () => {
      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).not.toContain('Session Activity:');
      expect(result.content).toContain('Recent Output (last 10 lines):');
    });

    it('should show idle state when no current tool', async () => {
      mockGetEventAccumulator.mockReturnValue({
        filesEdited: [],
        lastActivityAt: Date.now(),
        eventCount: 0,
      });

      const result = await mc_status.execute({ name: 'test-job' });

      expect(result.content).toContain('Session State: idle');
      expect(result.content).toContain('Current File: (none)');
      expect(result.content).toContain('Files Edited: 0');
    });
  });
});
