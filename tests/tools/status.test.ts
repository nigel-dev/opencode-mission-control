import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as tmux from '../../src/lib/tmux';
import * as worktree from '../../src/lib/worktree';
import * as orchestratorSingleton from '../../src/lib/orchestrator-singleton';

const { mc_status } = await import('../../src/tools/status');

let mockGetJobByName: Mock;
let mockCapturePane: Mock;
let mockIsInManagedWorktree: Mock;
let mockGetSharedMonitor: Mock;

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
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockImplementation(() => undefined as any) as unknown as Mock;
    mockCapturePane = vi.spyOn(tmux, 'capturePane').mockImplementation(() => '' as any) as unknown as Mock;
    mockIsInManagedWorktree = vi.spyOn(worktree, 'isInManagedWorktree').mockImplementation(() => false as any) as unknown as Mock;
    mockGetSharedMonitor = vi.spyOn(orchestratorSingleton, 'getSharedMonitor').mockReturnValue({
      getEventAccumulator: vi.fn().mockReturnValue(undefined),
    } as any) as unknown as Mock;
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

      expect(result.content).toContain('Job: test-job');
      expect(result.content).toContain('Status: running');
    });

    it('should include job ID', async () => {
      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('ID: test-job-id');
    });

    it('should include metadata section with branch and mode', async () => {
      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('Metadata:');
      expect(result.content).toContain('Branch: mc/test-job');
      expect(result.content).toContain('Mode: vanilla');
    });

    it('should include placement and creation time', async () => {
      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('Placement: session');
      expect(result.content).toContain('Created:');
    });

    it('should include paths section with worktree and tmux target', async () => {
      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('Paths:');
      expect(result.content).toContain('Worktree: /tmp/mc-worktrees/test-job');
      expect(result.content).toContain('tmux Target: mc-test-job');
    });

    it('should include git status section', async () => {
      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('Git Status:');
      expect(result.content).toContain('Branch:');
      expect(result.content).toContain('Files Changed:');
      expect(result.content).toContain('Ahead:');
      expect(result.content).toContain('Behind:');
    });

    it('should include recent output section', async () => {
      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('Recent Output (last 10 lines):');
      expect(result.content).toContain('Last line of output');
    });
  });

  describe('duration calculation', () => {
    it('should show duration for running jobs', async () => {
      const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
      mockGetJobByName.mockResolvedValue(createMockJob({ createdAt: oneHourAgo, status: 'running' }));
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('Duration:');
      expect(result.content).toMatch(/Duration: \d+[hm]/);
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

      expect(result.content).toContain('Duration:');
      expect(result.content).toContain('Completed:');
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

      expect(result.content).toContain('Exit Code: 0');
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

      expect(result.content).toContain('Plan File: my-plan.md');
    });

    it('should not include plan file when absent', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).not.toContain('Plan File:');
    });
  });

  describe('error handling', () => {
    it('should handle capturePane failure gracefully', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockCapturePane.mockRejectedValue(new Error('pane not found'));
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('(unable to capture pane output)');
    });
  });

  describe('managed worktree detection', () => {
    it('should show managed status', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('Managed: true');
    });

    it('should show unmanaged status', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob());
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: false });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('Managed: false');
    });
  });

  describe('different job statuses', () => {
    it('should handle running status', async () => {
      mockGetJobByName.mockResolvedValue(createMockJob({ status: 'running' }));
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('Status: running');
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

      expect(result.content).toContain('Status: completed');
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

      expect(result.content).toContain('Status: failed');
      expect(result.content).toContain('Exit Code: 1');
    });
  });

  describe('serve-mode telemetry', () => {
    it('should include serve-mode telemetry section for jobs with port', async () => {
      const serveModeJob = createMockJob({
        port: 8080,
        serverUrl: 'http://localhost:8080',
      });

      mockGetJobByName.mockResolvedValue(serveModeJob);
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });
      mockGetSharedMonitor.mockReturnValue({
        getEventAccumulator: vi.fn().mockReturnValue({
          filesEdited: ['src/index.ts', 'src/utils.ts'],
          currentTool: 'streaming',
          currentFile: 'src/index.ts',
          lastActivityAt: Date.now(),
          eventCount: 42,
        }),
      });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('Serve Mode Telemetry:');
      expect(result.content).toContain('Session State: streaming');
      expect(result.content).toContain('Current File: src/index.ts');
      expect(result.content).toContain('Files Edited: 2');
      expect(result.content).toContain('src/index.ts');
      expect(result.content).toContain('src/utils.ts');
      expect(result.content).toContain('Events Accumulated: 42');
      expect(result.content).toContain('Port: 8080');
      expect(result.content).toContain('Server URL: http://localhost:8080');
    });

    it('should handle serve-mode job with no accumulated events', async () => {
      const serveModeJob = createMockJob({
        port: 8080,
      });

      mockGetJobByName.mockResolvedValue(serveModeJob);
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });
      mockGetSharedMonitor.mockReturnValue({
        getEventAccumulator: vi.fn().mockReturnValue(undefined),
      });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('Port: 8080');
      expect(result.content).not.toContain('Serve Mode Telemetry:');
    });

    it('should preserve TUI-mode output format for jobs without port', async () => {
      const tuiJob = createMockJob();

      mockGetJobByName.mockResolvedValue(tuiJob);
      mockCapturePane.mockResolvedValue('TUI output');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).not.toContain('Serve Mode Telemetry:');
      expect(result.content).not.toContain('Port:');
      expect(result.content).toContain('Recent Output (last 10 lines):');
      expect(result.content).toContain('TUI output');
    });

    it('should show idle state when no current tool', async () => {
      const serveModeJob = createMockJob({
        port: 8080,
      });

      mockGetJobByName.mockResolvedValue(serveModeJob);
      mockCapturePane.mockResolvedValue('');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });
      mockGetSharedMonitor.mockReturnValue({
        getEventAccumulator: vi.fn().mockReturnValue({
          filesEdited: [],
          lastActivityAt: Date.now(),
          eventCount: 0,
        }),
      });

      const result = await mc_status.execute({ name: 'test-job' }, mockContext);

      expect(result.content).toContain('Session State: idle');
      expect(result.content).toContain('Files Edited: 0');
    });
  });
});
