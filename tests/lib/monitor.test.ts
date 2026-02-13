import { mock, describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import type { Job } from '../../src/lib/job-state';

mock.module('../../src/lib/job-state', () => ({
  getRunningJobs: mock(),
  updateJob: mock(),
}));

mock.module('../../src/lib/tmux', () => ({
  isPaneRunning: mock(),
  capturePane: mock(),
  captureExitStatus: mock(),
}));

mock.module('../../src/lib/reports', () => ({
  readReport: mock(),
}));

const { JobMonitor } = await import('../../src/lib/monitor');
const jobState = await import('../../src/lib/job-state');
const tmux = await import('../../src/lib/tmux');
const reports = await import('../../src/lib/reports');

const mockGetRunningJobs = jobState.getRunningJobs as Mock<any>;
const mockUpdateJob = jobState.updateJob as Mock<any>;
const mockIsPaneRunning = tmux.isPaneRunning as Mock<any>;
const mockCapturePane = (tmux as any).capturePane as Mock<any>;
const mockCaptureExitStatus = (tmux as any).captureExitStatus as Mock<any>;
const mockReadReport = reports.readReport as Mock<any>;

const IDLE_OUTPUT = 'Some response\n  ctrl+t variants  tab agents  ctrl+p commands\n';
const STREAMING_OUTPUT = 'Working...\n  ⬝⬝⬝⬝  esc interrupt  ctrl+p commands\n';

describe('JobMonitor', () => {
  beforeEach(() => {
    mockGetRunningJobs.mockReset();
    mockUpdateJob.mockReset();
    mockIsPaneRunning.mockReset();
    mockCapturePane.mockReset();
    mockCaptureExitStatus.mockReset();
    mockReadReport.mockReset();
    mockGetRunningJobs.mockResolvedValue([]);
    mockReadReport.mockResolvedValue(null);
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
       mockCaptureExitStatus.mockResolvedValue(0);
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

     it('should mark job as failed when pane exits with error', async () => {
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
       mockCaptureExitStatus.mockResolvedValue(1);
       mockUpdateJob.mockResolvedValue(undefined);

       const monitor = new JobMonitor();
       monitor.start();

       await new Promise(resolve => setTimeout(resolve, 50));

       expect(mockGetRunningJobs).toHaveBeenCalled();
       expect(mockIsPaneRunning).toHaveBeenCalledWith('mc-test');
       expect(mockUpdateJob).toHaveBeenCalledWith('job-1', {
         status: 'failed',
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
      mockCapturePane.mockResolvedValue(STREAMING_OUTPUT);

      const monitor = new JobMonitor();
      monitor.start();

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockGetRunningJobs).toHaveBeenCalled();
      expect(mockIsPaneRunning).toHaveBeenCalledWith('mc-test');
      expect(mockUpdateJob).not.toHaveBeenCalled();

      monitor.stop();
    });

    it('should mark job completed after idle threshold when session is idle', async () => {
      const mockJob: Job = {
        id: 'job-idle',
        name: 'Idle Job',
        worktreePath: '/path/to/worktree',
        branch: 'main',
        tmuxTarget: 'mc-idle',
        placement: 'session',
        status: 'running',
        prompt: 'Test prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetRunningJobs.mockResolvedValue([mockJob]);
      mockIsPaneRunning.mockResolvedValue(true);
      mockCapturePane.mockResolvedValue(IDLE_OUTPUT);
      mockUpdateJob.mockResolvedValue(undefined);

      const monitor = new JobMonitor({ pollInterval: 50, idleThreshold: 80 });
      monitor.start();

      await new Promise(resolve => setTimeout(resolve, 400));

      expect(mockUpdateJob).toHaveBeenCalledWith('job-idle', {
        status: 'completed',
        completedAt: expect.any(String),
      });

      monitor.stop();
    }, 10000);

    it('should not mark job completed if session is still streaming', async () => {
      const mockJob: Job = {
        id: 'job-stream',
        name: 'Streaming Job',
        worktreePath: '/path/to/worktree',
        branch: 'main',
        tmuxTarget: 'mc-stream',
        placement: 'session',
        status: 'running',
        prompt: 'Test prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetRunningJobs.mockResolvedValue([mockJob]);
      mockIsPaneRunning.mockResolvedValue(true);
      mockCapturePane.mockResolvedValue(STREAMING_OUTPUT);
      mockUpdateJob.mockResolvedValue(undefined);

      const monitor = new JobMonitor({ pollInterval: 50, idleThreshold: 100 });
      monitor.start();

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(mockUpdateJob).not.toHaveBeenCalled();

      monitor.stop();
    }, 10000);

    it('should reset idle timer when output changes', async () => {
      const mockJob: Job = {
        id: 'job-reset',
        name: 'Reset Job',
        worktreePath: '/path/to/worktree',
        branch: 'main',
        tmuxTarget: 'mc-reset',
        placement: 'session',
        status: 'running',
        prompt: 'Test prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetRunningJobs.mockResolvedValue([mockJob]);
      mockIsPaneRunning.mockResolvedValue(true);
      mockUpdateJob.mockResolvedValue(undefined);

      let callCount = 0;
      mockCapturePane.mockImplementation(() => {
        callCount++;
        return Promise.resolve(`output-${callCount}\n  ctrl+p commands\n`);
      });

      const monitor = new JobMonitor({ pollInterval: 50, idleThreshold: 100 });
      monitor.start();

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(mockUpdateJob).not.toHaveBeenCalled();

      monitor.stop();
    }, 10000);

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

       mockGetRunningJobs.mockResolvedValueOnce(mockJobs).mockResolvedValue([]);
       mockIsPaneRunning
         .mockResolvedValueOnce(false)
         .mockResolvedValueOnce(true);
       mockCapturePane.mockResolvedValue(STREAMING_OUTPUT);
       mockCaptureExitStatus.mockResolvedValue(0);
       mockUpdateJob.mockResolvedValue(undefined);

       const monitor = new JobMonitor();
       monitor.start();

       await new Promise(resolve => setTimeout(resolve, 50));

       expect(mockUpdateJob).toHaveBeenCalledWith('job-1', {
         status: 'completed',
         completedAt: expect.any(String),
       });

       monitor.stop();
     });

    it('should handle isPaneRunning errors gracefully during poll', async () => {
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

      const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      const monitor = new JobMonitor();
      monitor.start();

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(mockUpdateJob).not.toHaveBeenCalled();

      monitor.stop();
      consoleWarnSpy.mockRestore();
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
       mockCaptureExitStatus.mockResolvedValue(0);
       mockUpdateJob.mockResolvedValue(undefined);

       const monitor = new JobMonitor();
       const completeHandler = mock();
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

     it('should emit failed event when job exits with error', async () => {
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
       mockCaptureExitStatus.mockResolvedValue(127);
       mockUpdateJob.mockResolvedValue(undefined);

       const monitor = new JobMonitor();
       const failedHandler = mock();
       monitor.on('failed', failedHandler);

       monitor.start();
       await new Promise(resolve => setTimeout(resolve, 50));

       expect(failedHandler).toHaveBeenCalledTimes(1);
       expect(failedHandler).toHaveBeenCalledWith(
         expect.objectContaining({
           id: 'job-1',
           status: 'failed',
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
       mockCaptureExitStatus.mockResolvedValue(0);
       mockUpdateJob.mockResolvedValue(undefined);

       const monitor = new JobMonitor();
       const handler1 = mock();
       const handler2 = mock();
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
       mockCapturePane.mockResolvedValue(STREAMING_OUTPUT);
       mockCaptureExitStatus.mockResolvedValue(undefined);

       const monitor = new JobMonitor();
       const completeHandler = mock();
       monitor.on('complete', completeHandler);

       monitor.start();
       await new Promise(resolve => setTimeout(resolve, 50));

       expect(completeHandler).not.toHaveBeenCalled();

       monitor.stop();
     });
  });
});
