import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as tmux from '../../src/lib/tmux';
import * as worktree from '../../src/lib/worktree';

const { mc_status } = await import('../../src/tools/status');

let mockGetJobByName: Mock;
let mockCapturePane: Mock;
let mockIsInManagedWorktree: Mock;

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

function createMockJob(overrides?: Partial<Job>): Job {
  return {
    id: 'test-job-id',
    name: 'test-job',
    worktreePath: '/tmp/mc-worktrees/test-job',
    branch: 'mc/test-job',
    tmuxTarget: 'mc-test-job',
    placement: 'session',
    status: 'running',
    prompt: 'Test prompt',
    mode: 'vanilla',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    ...overrides,
  };
}

describe('mc_status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockImplementation(() => undefined as any);
    mockCapturePane = vi.spyOn(tmux, 'capturePane').mockImplementation(() => '' as any);
    mockIsInManagedWorktree = vi.spyOn(worktree, 'isInManagedWorktree').mockImplementation(() => false as any);
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_status.description).toBe('Get detailed status of a specific job');
    });

    it('should have required arg: name', () => {
      expect(mc_status.args.name).toBeDefined();
    });
  });

  describe('job lookup', () => {
    it('should throw error when job not found', async () => {
      mockGetJobByName.mockResolvedValue(undefined);

      await expect(mc_status.execute({ name: 'nonexistent' }, mockContext)).rejects.toThrow(
        'Job "nonexistent" not found',
      );
    });

    it('should call getJobByName with correct name', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      await mc_status.execute({ name: 'my-job' }, mockContext);

      expect(mockGetJobByName).toHaveBeenCalledWith('my-job');
    });
  });

  describe('status output', () => {
    beforeEach(() => {
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockCapturePane.mockResolvedValue('Last line of output');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true, worktreePath: '/tmp/mc-worktrees/test-job' });
    });

    it('should include job name and status', async () => {
      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Job: test-job');
      expect(result).toContain('Status: running');
    });

    it('should include job ID', async () => {
      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('ID: test-job-id');
    });

    it('should include metadata section with branch and mode', async () => {
      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Metadata:');
      expect(result).toContain('Branch: mc/test-job');
      expect(result).toContain('Mode: vanilla');
    });

    it('should include placement and creation time', async () => {
      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Placement: session');
      expect(result).toContain('Created:');
    });

    it('should include paths section with worktree and tmux target', async () => {
      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Paths:');
      expect(result).toContain('Worktree: /tmp/mc-worktrees/test-job');
      expect(result).toContain('tmux Target: mc-test-job');
    });

    it('should include git status section', async () => {
      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Git Status:');
      expect(result).toContain('Branch:');
      expect(result).toContain('Files Changed:');
      expect(result).toContain('Ahead:');
      expect(result).toContain('Behind:');
    });

    it('should include recent output section', async () => {
      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Recent Output (last 10 lines):');
      expect(result).toContain('Last line of output');
    });
  });

  describe('duration calculation', () => {
    it('should show duration for running jobs', async () => {
      const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
      mockGetJobByName.mockResolvedValue(createMockJob({ createdAt: oneHourAgo, status: 'running' }));
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Duration:');
      expect(result).toMatch(/Duration: \d+[hm]/);
    });

    it('should show duration for completed jobs', async () => {
      const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
      const thirtyMinutesAgo = new Date(Date.now() - 1800000).toISOString();
      mockGetJobByName.mockResolvedValue(
        createMockJob({
          createdAt: oneHourAgo,
          completedAt: thirtyMinutesAgo,
          status: 'completed',
        }),
      );
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Duration:');
      expect(result).toContain('Completed:');
    });

    it('should show exit code for completed jobs', async () => {
      mockGetJobByName.mockResolvedValue(
        createMockJob({
          status: 'completed',
          exitCode: 0,
        }),
      );
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Exit Code: 0');
    });
  });

  describe('optional fields', () => {
    it('should include plan file when present', async () => {
      mockGetJobByName.mockResolvedValue(
        createMockJob({
          planFile: 'my-plan.md',
        }),
      );
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Plan File: my-plan.md');
    });

    it('should not include plan file when absent', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).not.toContain('Plan File:');
    });
  });

  describe('error handling', () => {
    it('should handle capturePane failure gracefully', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockCapturePane.mockRejectedValue(new Error('pane not found'));
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('(unable to capture pane output)');
    });
  });

  describe('managed worktree detection', () => {
    it('should show managed status', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Managed: true');
    });

    it('should show unmanaged status', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: false });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Managed: false');
    });
  });

  describe('different job statuses', () => {
    it('should handle running status', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob({ status: 'running' }));
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Status: running');
    });

    it('should handle completed status', async () => {
      mockGetJobByName.mockResolvedValue(
        createMockJob({
          status: 'completed',
          completedAt: new Date().toISOString(),
        }),
      );
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Status: completed');
    });

    it('should handle failed status', async () => {
      mockGetJobByName.mockResolvedValue(
        createMockJob({
          status: 'failed',
          completedAt: new Date().toISOString(),
          exitCode: 1,
        }),
      );
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result).toContain('Status: failed');
      expect(result).toContain('Exit Code: 1');
    });
  });
});
