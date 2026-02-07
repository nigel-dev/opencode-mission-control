import { mock } from 'bun:test';
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';

mock.module('../../src/lib/job-state', () => ({
  getRunningJobs: vi.fn(),
  updateJob: vi.fn(),
}));

mock.module('../../src/lib/tmux', () => ({
  isPaneRunning: vi.fn(),
}));

const { JobMonitor } = await import('../../src/lib/monitor');
const jobState = await import('../../src/lib/job-state');
const tmux = await import('../../src/lib/tmux');

mock.restore();

const mockGetRunningJobs = jobState.getRunningJobs as Mock;
const mockUpdateJob = jobState.updateJob as Mock;
const mockIsPaneRunning = tmux.isPaneRunning as Mock;

describe('JobMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create monitor with default 10s poll interval', () => {
      const monitor = new JobMonitor();
      expect(monitor).toBeDefined();
    });

    it('should create monitor with custom poll interval', () => {
      const monitor = new JobMonitor({ pollInterval: 15000 });
      expect(monitor).toBeDefined();
    });

    it('should throw error if poll interval is less than 10s in production', () => {
      const originalEnv = process.env.NODE_ENV;
      const originalVitest = process.env.VITEST;
      
      delete process.env.NODE_ENV;
      delete process.env.VITEST;
      
      expect(() => new JobMonitor({ pollInterval: 5000 })).toThrow(
        'Poll interval must be at least 10000ms (10s)'
      );
      
      if (originalEnv) process.env.NODE_ENV = originalEnv;
      if (originalVitest) process.env.VITEST = originalVitest;
    });
  });

  describe('start', () => {
    it('should start polling immediately', async () => {
      const mockJobs: Job[] = [];
      mockGetRunningJobs.mockResolvedValue(mockJobs);

      const monitor = new JobMonitor();
      monitor.start();

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockGetRunningJobs).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it('should poll at configured interval', async () => {
      const mockJobs: Job[] = [];
      mockGetRunningJobs.mockResolvedValue(mockJobs);

      const monitor = new JobMonitor({ pollInterval: 100 });
      monitor.start();

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mockGetRunningJobs).toHaveBeenCalledTimes(1);

      await new Promise(resolve => setTimeout(resolve, 110));
      expect(mockGetRunningJobs).toHaveBeenCalledTimes(2);

      await new Promise(resolve => setTimeout(resolve, 110));
      expect(mockGetRunningJobs).toHaveBeenCalledTimes(3);

      monitor.stop();
    }, 10000);

    it('should not start multiple times if already running', async () => {
      const mockJobs: Job[] = [];
      mockGetRunningJobs.mockResolvedValue(mockJobs);

      const monitor = new JobMonitor();
      monitor.start();
      monitor.start();

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockGetRunningJobs).toHaveBeenCalledTimes(1);

      monitor.stop();
    });
  });

  describe('stop', () => {
    it('should stop polling', async () => {
      const mockJobs: Job[] = [];
      mockGetRunningJobs.mockResolvedValue(mockJobs);

      const monitor = new JobMonitor({ pollInterval: 100 });
      monitor.start();

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mockGetRunningJobs).toHaveBeenCalledTimes(1);

      monitor.stop();

      await new Promise(resolve => setTimeout(resolve, 150));
      expect(mockGetRunningJobs).toHaveBeenCalledTimes(1);
    }, 10000);

    it('should be safe to call stop multiple times', () => {
      const monitor = new JobMonitor();
      monitor.start();
      monitor.stop();
      monitor.stop();

      expect(() => monitor.stop()).not.toThrow();
    });

    it('should be safe to call stop without starting', () => {
      const monitor = new JobMonitor();
      expect(() => monitor.stop()).not.toThrow();
    });
  });

  describe('poll', () => {
    it('should check running jobs and detect completed panes', async () => {
      const mockJob: Job = {
        id: 'job-1',
        name: 'Test Job',
        worktreePath: '/path/to/worktree',
        branch: 'main',
        tmuxTarget: 'mc-test',
        placement: 'session',
        status: 'running',
        prompt: 'Test prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetRunningJobs.mockResolvedValue([mockJob]);
      mockIsPaneRunning.mockResolvedValue(false);
      mockUpdateJob.mockResolvedValue(undefined);

      const monitor = new JobMonitor();
      monitor.start();

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockGetRunningJobs).toHaveBeenCalled();
      expect(mockIsPaneRunning).toHaveBeenCalledWith('mc-test');
      expect(mockUpdateJob).toHaveBeenCalledWith('job-1', {
        status: 'completed',
        completedAt: expect.any(String),
      });

      monitor.stop();
    });

    it('should not update job if pane is still running', async () => {
      const mockJob: Job = {
        id: 'job-1',
        name: 'Test Job',
        worktreePath: '/path/to/worktree',
        branch: 'main',
        tmuxTarget: 'mc-test',
        placement: 'session',
        status: 'running',
        prompt: 'Test prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetRunningJobs.mockResolvedValue([mockJob]);
      mockIsPaneRunning.mockResolvedValue(true);

      const monitor = new JobMonitor();
      monitor.start();

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockGetRunningJobs).toHaveBeenCalled();
      expect(mockIsPaneRunning).toHaveBeenCalledWith('mc-test');
      expect(mockUpdateJob).not.toHaveBeenCalled();

      monitor.stop();
    });

    it('should handle multiple running jobs', async () => {
      const mockJobs: Job[] = [
        {
          id: 'job-1',
          name: 'Job 1',
          worktreePath: '/path/1',
          branch: 'main',
          tmuxTarget: 'mc-job1',
          placement: 'session',
          status: 'running',
          prompt: 'Prompt 1',
          mode: 'vanilla',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'job-2',
          name: 'Job 2',
          worktreePath: '/path/2',
          branch: 'develop',
          tmuxTarget: 'mc-job2',
          placement: 'window',
          status: 'running',
          prompt: 'Prompt 2',
          mode: 'plan',
          createdAt: new Date().toISOString(),
        },
      ];

      mockGetRunningJobs.mockResolvedValue(mockJobs);
      mockIsPaneRunning
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mockUpdateJob.mockResolvedValue(undefined);

      const monitor = new JobMonitor();
      monitor.start();

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockIsPaneRunning).toHaveBeenCalledTimes(2);
      expect(mockUpdateJob).toHaveBeenCalledTimes(1);
      expect(mockUpdateJob).toHaveBeenCalledWith('job-1', {
        status: 'completed',
        completedAt: expect.any(String),
      });

      monitor.stop();
    });

    it('should handle errors gracefully during poll', async () => {
      const mockJob: Job = {
        id: 'job-1',
        name: 'Test Job',
        worktreePath: '/path/to/worktree',
        branch: 'main',
        tmuxTarget: 'mc-test',
        placement: 'session',
        status: 'running',
        prompt: 'Test prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetRunningJobs.mockResolvedValue([mockJob]);
      mockIsPaneRunning.mockRejectedValue(new Error('Tmux error'));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const monitor = new JobMonitor();
      monitor.start();

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(mockUpdateJob).not.toHaveBeenCalled();

      monitor.stop();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('events', () => {
    it('should emit complete event when job completes', async () => {
      const mockJob: Job = {
        id: 'job-1',
        name: 'Test Job',
        worktreePath: '/path/to/worktree',
        branch: 'main',
        tmuxTarget: 'mc-test',
        placement: 'session',
        status: 'running',
        prompt: 'Test prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetRunningJobs.mockResolvedValue([mockJob]);
      mockIsPaneRunning.mockResolvedValue(false);
      mockUpdateJob.mockResolvedValue(undefined);

      const monitor = new JobMonitor();
      const completeHandler = vi.fn();
      monitor.on('complete', completeHandler);

      monitor.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(completeHandler).toHaveBeenCalledTimes(1);
      expect(completeHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'job-1',
          status: 'completed',
          completedAt: expect.any(String),
        })
      );

      monitor.stop();
    });

    it('should support multiple event handlers', async () => {
      const mockJob: Job = {
        id: 'job-1',
        name: 'Test Job',
        worktreePath: '/path/to/worktree',
        branch: 'main',
        tmuxTarget: 'mc-test',
        placement: 'session',
        status: 'running',
        prompt: 'Test prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetRunningJobs.mockResolvedValue([mockJob]);
      mockIsPaneRunning.mockResolvedValue(false);
      mockUpdateJob.mockResolvedValue(undefined);

      const monitor = new JobMonitor();
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      monitor.on('complete', handler1);
      monitor.on('complete', handler2);

      monitor.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it('should not emit events if pane is still running', async () => {
      const mockJob: Job = {
        id: 'job-1',
        name: 'Test Job',
        worktreePath: '/path/to/worktree',
        branch: 'main',
        tmuxTarget: 'mc-test',
        placement: 'session',
        status: 'running',
        prompt: 'Test prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetRunningJobs.mockResolvedValue([mockJob]);
      mockIsPaneRunning.mockResolvedValue(true);

      const monitor = new JobMonitor();
      const completeHandler = vi.fn();
      monitor.on('complete', completeHandler);

      monitor.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(completeHandler).not.toHaveBeenCalled();

      monitor.stop();
    });
  });
});
