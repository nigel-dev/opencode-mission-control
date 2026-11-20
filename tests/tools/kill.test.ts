import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as jobRuntime from '../../src/lib/job-runtime';

const { mc_kill } = await import('../../src/tools/kill');

let mockGetJobByName: MockInstance;
let mockUpdateJob: MockInstance;
let mockStopJobSession: MockInstance;

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'my-job',
    worktreePath: '/tmp/worktree',
    branch: 'mc/my-job',
    status: 'running',
    prompt: 'Do the thing',
    createdAt: new Date().toISOString(),
    sessionID: 'ses_job1',
    ...overrides,
  };
}

describe('mc_kill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockResolvedValue(undefined);
    mockUpdateJob = vi.spyOn(jobState, 'updateJob').mockResolvedValue(undefined);
    mockStopJobSession = vi.spyOn(jobRuntime, 'stopJobSession').mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_kill.description).toBe('Stop a running job');
    });

    it('should have required arg: name', () => {
      expect(mc_kill.input.shape.name).toBeDefined();
    });

    it('should have optional arg: force', () => {
      expect(mc_kill.input.shape.force).toBeDefined();
    });
  });

  describe('job lookup', () => {
    it('should throw error when job not found', async () => {
      await expect(mc_kill.execute({ name: 'nonexistent' })).rejects.toThrow(
        'Job "nonexistent" not found',
      );
      expect(mockStopJobSession).not.toHaveBeenCalled();
    });

    it('should call getJobByName with correct name', async () => {
      mockGetJobByName.mockResolvedValue(makeJob());

      await mc_kill.execute({ name: 'my-job' });

      expect(mockGetJobByName).toHaveBeenCalledWith('my-job');
    });
  });

  describe('already stopped job', () => {
    it('should return message when job is already stopped', async () => {
      mockGetJobByName.mockResolvedValue(makeJob({ status: 'stopped' }));

      const result = await mc_kill.execute({ name: 'my-job' });

      expect(result.content).toContain('already stopped');
      expect(mockStopJobSession).not.toHaveBeenCalled();
      expect(mockUpdateJob).not.toHaveBeenCalled();
    });

    it.each(['completed', 'failed'] as const)(
      'should leave a %s job as it is instead of rewriting it to stopped',
      async (status) => {
        mockGetJobByName.mockResolvedValue(makeJob({ status }));

        const result = await mc_kill.execute({ name: 'my-job' });

        expect(result.content).toContain(`not running (status: ${status})`);
        expect(mockStopJobSession).not.toHaveBeenCalled();
        expect(mockUpdateJob).not.toHaveBeenCalled();
      },
    );
  });

  describe('stopping the session', () => {
    it("should interrupt the job's session", async () => {
      mockGetJobByName.mockResolvedValue(makeJob());

      await mc_kill.execute({ name: 'my-job' });

      expect(mockStopJobSession).toHaveBeenCalledTimes(1);
      expect(mockStopJobSession).toHaveBeenCalledWith('ses_job1');
    });

    it('should mark the job stopped before interrupting its session', async () => {
      mockGetJobByName.mockResolvedValue(makeJob());
      const order: string[] = [];
      mockUpdateJob.mockImplementation(async () => {
        order.push('update');
      });
      mockStopJobSession.mockImplementation(async () => {
        order.push('stop');
      });

      await mc_kill.execute({ name: 'my-job' });

      expect(order).toEqual(['update', 'stop']);
    });

    it('should stop a job that has no session without calling the runtime', async () => {
      mockGetJobByName.mockResolvedValue(makeJob({ sessionID: undefined }));

      const result = await mc_kill.execute({ name: 'my-job' });

      expect(mockStopJobSession).not.toHaveBeenCalled();
      expect(mockUpdateJob).toHaveBeenCalledWith('job-1', {
        status: 'stopped',
        completedAt: expect.any(String),
      });
      expect(result.content).toContain('stopped successfully');
    });

    it('should keep the job stopped and report a warning when the interrupt fails', async () => {
      mockGetJobByName.mockResolvedValue(makeJob());
      mockStopJobSession.mockRejectedValue(new Error('session not found'));

      const result = await mc_kill.execute({ name: 'my-job' });

      expect(mockUpdateJob).toHaveBeenCalledTimes(1);
      expect(mockUpdateJob).toHaveBeenCalledWith('job-1', {
        status: 'stopped',
        completedAt: expect.any(String),
      });
      expect(result.content).toContain('stopped successfully');
      expect(result.content).toContain('Warning: could not interrupt session ses_job1');
      expect(result.content).toContain('session not found');
    });
  });

  describe('job status update', () => {
    it('should update job status to stopped', async () => {
      mockGetJobByName.mockResolvedValue(makeJob());

      await mc_kill.execute({ name: 'my-job' });

      expect(mockUpdateJob).toHaveBeenCalledWith('job-1', {
        status: 'stopped',
        completedAt: expect.any(String),
      });
    });

    it('should set completedAt timestamp', async () => {
      mockGetJobByName.mockResolvedValue(makeJob());

      const beforeTime = Date.now();
      await mc_kill.execute({ name: 'my-job' });
      const afterTime = Date.now();

      const completedAt = mockUpdateJob.mock.calls[0][1].completedAt;
      const completedTime = new Date(completedAt).getTime();
      expect(completedTime).toBeGreaterThanOrEqual(beforeTime);
      expect(completedTime).toBeLessThanOrEqual(afterTime);
    });

    it('should throw and leave the session alone when updateJob fails', async () => {
      mockGetJobByName.mockResolvedValue(makeJob());
      mockUpdateJob.mockRejectedValue(new Error('state write failed'));

      await expect(mc_kill.execute({ name: 'my-job' })).rejects.toThrow(
        'Failed to update job status: state write failed',
      );
      expect(mockStopJobSession).not.toHaveBeenCalled();
    });
  });

  describe('success response', () => {
    it('should return success message with job details', async () => {
      mockGetJobByName.mockResolvedValue(makeJob());

      const result = await mc_kill.execute({ name: 'my-job' });

      expect(result.content).toContain('Job "my-job" stopped successfully');
      expect(result.content).toContain('job-1');
      expect(result.content).toContain('Status:    stopped');
      expect(result.content).toContain('Session:   ses_job1');
      expect(result.content).toContain('/tmp/worktree');
      expect(result.content).not.toContain('Warning');
    });

    it('should mention worktree preservation in response', async () => {
      mockGetJobByName.mockResolvedValue(makeJob());

      const result = await mc_kill.execute({ name: 'my-job' });

      expect(result.content).toContain('Worktree is preserved');
      expect(result.content).toContain('mc_cleanup');
    });
  });

  describe('force flag', () => {
    it('should accept force flag', async () => {
      mockGetJobByName.mockResolvedValue(makeJob());

      const result = await mc_kill.execute({ name: 'my-job', force: true });

      expect(result.content).toContain('stopped successfully');
      expect(mockStopJobSession).toHaveBeenCalledWith('ses_job1');
    });
  });
});
