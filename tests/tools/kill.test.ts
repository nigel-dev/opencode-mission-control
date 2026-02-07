import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';

vi.mock('../../src/lib/job-state', () => ({
  getJobByName: vi.fn(),
  updateJob: vi.fn(),
}));

vi.mock('../../src/lib/tmux', () => ({
  killSession: vi.fn(),
  killWindow: vi.fn(),
}));

const jobState = await import('../../src/lib/job-state');
const tmux = await import('../../src/lib/tmux');

const mockGetJobByName = jobState.getJobByName as Mock;
const mockUpdateJob = jobState.updateJob as Mock;
const mockKillSession = tmux.killSession as Mock;
const mockKillWindow = tmux.killWindow as Mock;

const { mc_kill } = await import('../../src/tools/kill');

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

function setupDefaultMocks() {
  mockKillSession.mockResolvedValue(undefined);
  mockKillWindow.mockResolvedValue(undefined);
  mockUpdateJob.mockResolvedValue(undefined);
}

describe('mc_kill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_kill.description).toBe('Stop a running job');
    });

    it('should have required arg: name', () => {
      expect(mc_kill.args.name).toBeDefined();
    });

    it('should have optional arg: force', () => {
      expect(mc_kill.args.force).toBeDefined();
    });
  });

  describe('job lookup', () => {
    it('should throw error when job not found', async () => {
      mockGetJobByName.mockResolvedValue(undefined);

      await expect(
        mc_kill.execute({ name: 'nonexistent' }, mockContext),
      ).rejects.toThrow('Job "nonexistent" not found');
    });

    it('should call getJobByName with correct name', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-1',
        name: 'my-job',
        status: 'running',
        placement: 'session',
        tmuxTarget: 'mc-my-job',
        worktreePath: '/tmp/worktree',
      } as Job);

      await mc_kill.execute({ name: 'my-job' }, mockContext);

      expect(mockGetJobByName).toHaveBeenCalledWith('my-job');
    });
  });

  describe('already stopped job', () => {
    it('should return message when job is already stopped', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-1',
        name: 'my-job',
        status: 'stopped',
        placement: 'session',
        tmuxTarget: 'mc-my-job',
        worktreePath: '/tmp/worktree',
      } as Job);

      const result = await mc_kill.execute({ name: 'my-job' }, mockContext);

      expect(result).toContain('already stopped');
      expect(mockKillSession).not.toHaveBeenCalled();
      expect(mockUpdateJob).not.toHaveBeenCalled();
    });
  });

  describe('session placement', () => {
    it('should kill tmux session for session placement', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-1',
        name: 'my-job',
        status: 'running',
        placement: 'session',
        tmuxTarget: 'mc-my-job',
        worktreePath: '/tmp/worktree',
      } as Job);

      await mc_kill.execute({ name: 'my-job' }, mockContext);

      expect(mockKillSession).toHaveBeenCalledWith('mc-my-job');
      expect(mockKillWindow).not.toHaveBeenCalled();
    });

    it('should throw error when killSession fails', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-1',
        name: 'my-job',
        status: 'running',
        placement: 'session',
        tmuxTarget: 'mc-my-job',
        worktreePath: '/tmp/worktree',
      } as Job);

      mockKillSession.mockRejectedValue(new Error('session not found'));

      await expect(
        mc_kill.execute({ name: 'my-job' }, mockContext),
      ).rejects.toThrow('Failed to kill tmux session');
    });
  });

  describe('window placement', () => {
    it('should kill tmux window for window placement', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-1',
        name: 'my-job',
        status: 'running',
        placement: 'window',
        tmuxTarget: 'main-session:my-job',
        worktreePath: '/tmp/worktree',
      } as Job);

      await mc_kill.execute({ name: 'my-job' }, mockContext);

      expect(mockKillWindow).toHaveBeenCalledWith('main-session', 'my-job');
      expect(mockKillSession).not.toHaveBeenCalled();
    });

    it('should throw error when killWindow fails', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-1',
        name: 'my-job',
        status: 'running',
        placement: 'window',
        tmuxTarget: 'main-session:my-job',
        worktreePath: '/tmp/worktree',
      } as Job);

      mockKillWindow.mockRejectedValue(new Error('window not found'));

      await expect(
        mc_kill.execute({ name: 'my-job' }, mockContext),
      ).rejects.toThrow('Failed to kill tmux window');
    });

    it('should throw error for invalid tmux target format', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-1',
        name: 'my-job',
        status: 'running',
        placement: 'window',
        tmuxTarget: 'invalid-format',
        worktreePath: '/tmp/worktree',
      } as Job);

      await expect(
        mc_kill.execute({ name: 'my-job' }, mockContext),
      ).rejects.toThrow('Invalid tmux target format');
    });
  });

  describe('job status update', () => {
    it('should update job status to stopped', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-1',
        name: 'my-job',
        status: 'running',
        placement: 'session',
        tmuxTarget: 'mc-my-job',
        worktreePath: '/tmp/worktree',
      } as Job);

      await mc_kill.execute({ name: 'my-job' }, mockContext);

      expect(mockUpdateJob).toHaveBeenCalledWith('job-1', {
        status: 'stopped',
        completedAt: expect.any(String),
      });
    });

    it('should set completedAt timestamp', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-1',
        name: 'my-job',
        status: 'running',
        placement: 'session',
        tmuxTarget: 'mc-my-job',
        worktreePath: '/tmp/worktree',
      } as Job);

      const beforeTime = Date.now();
      await mc_kill.execute({ name: 'my-job' }, mockContext);
      const afterTime = Date.now();

      const updateCall = mockUpdateJob.mock.calls[0];
      const completedAt = updateCall[1].completedAt;

      const completedTime = new Date(completedAt).getTime();
      expect(completedTime).toBeGreaterThanOrEqual(beforeTime);
      expect(completedTime).toBeLessThanOrEqual(afterTime);
    });

    it('should throw error when updateJob fails', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-1',
        name: 'my-job',
        status: 'running',
        placement: 'session',
        tmuxTarget: 'mc-my-job',
        worktreePath: '/tmp/worktree',
      } as Job);

      mockUpdateJob.mockRejectedValue(new Error('state write failed'));

      await expect(
        mc_kill.execute({ name: 'my-job' }, mockContext),
      ).rejects.toThrow('Failed to update job status');
    });
  });

  describe('success response', () => {
    it('should return success message with job details', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-1',
        name: 'my-job',
        status: 'running',
        placement: 'session',
        tmuxTarget: 'mc-my-job',
        worktreePath: '/tmp/worktree',
      } as Job);

      const result = await mc_kill.execute({ name: 'my-job' }, mockContext);

      expect(result).toContain('Job "my-job" stopped successfully');
      expect(result).toContain('job-1');
      expect(result).toContain('stopped');
      expect(result).toContain('session');
      expect(result).toContain('/tmp/worktree');
    });

    it('should mention worktree preservation in response', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-1',
        name: 'my-job',
        status: 'running',
        placement: 'session',
        tmuxTarget: 'mc-my-job',
        worktreePath: '/tmp/worktree',
      } as Job);

      const result = await mc_kill.execute({ name: 'my-job' }, mockContext);

      expect(result).toContain('Worktree is preserved');
      expect(result).toContain('mc_cleanup');
    });
  });

  describe('force flag', () => {
    it('should accept force flag (even if not used)', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-1',
        name: 'my-job',
        status: 'running',
        placement: 'session',
        tmuxTarget: 'mc-my-job',
        worktreePath: '/tmp/worktree',
      } as Job);

      const result = await mc_kill.execute(
        { name: 'my-job', force: true },
        mockContext,
      );

      expect(result).toContain('stopped successfully');
    });
  });
});
