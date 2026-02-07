import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import {
  loadJobState,
  saveJobState,
  addJob,
  updateJob,
  removeJob,
  getJob,
  getJobByName,
  getRunningJobs,
  type Job,
  type JobState,
} from '../../src/lib/job-state';

const TEST_STATE_DIR = '.mission-control';
const TEST_STATE_FILE = join(TEST_STATE_DIR, 'jobs.json');

async function cleanupTestState(): Promise<void> {
  const file = Bun.file(TEST_STATE_FILE);
  if (await file.exists()) {
    await Bun.file(TEST_STATE_FILE).delete();
  }
  const tempFile = Bun.file(`${TEST_STATE_FILE}.tmp`);
  if (await tempFile.exists()) {
    await tempFile.delete();
  }
}

async function ensureTestDir(): Promise<void> {
  const fs = await import('fs');
  if (!fs.existsSync(TEST_STATE_DIR)) {
    fs.mkdirSync(TEST_STATE_DIR, { recursive: true });
  }
}

describe('job-state', () => {
  beforeEach(async () => {
    await cleanupTestState();
    await ensureTestDir();
  });

  afterEach(async () => {
    await cleanupTestState();
  });

  describe('loadJobState', () => {
    it('should return default state when file does not exist', async () => {
      const state = await loadJobState();
      expect(state.version).toBe(1);
      expect(state.jobs).toEqual([]);
      expect(state.updatedAt).toBeDefined();
    });

    it('should load existing state from file', async () => {
      const testState: JobState = {
        version: 1,
        jobs: [
          {
            id: 'test-1',
            name: 'Test Job',
            worktreePath: '/path/to/worktree',
            branch: 'main',
            tmuxTarget: 'mc-test',
            placement: 'session',
            status: 'running',
            prompt: 'Test prompt',
            mode: 'vanilla',
            createdAt: new Date().toISOString(),
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      await Bun.write(TEST_STATE_FILE, JSON.stringify(testState));
      const loaded = await loadJobState();

      expect(loaded.version).toBe(1);
      expect(loaded.jobs).toHaveLength(1);
      expect(loaded.jobs[0].id).toBe('test-1');
    });
  });

  describe('saveJobState', () => {
    it('should save state to file with updated timestamp', async () => {
      const state: JobState = {
        version: 1,
        jobs: [],
        updatedAt: '2024-01-01T00:00:00Z',
      };

      await saveJobState(state);
      const loaded = await loadJobState();

      expect(loaded.version).toBe(1);
      expect(loaded.updatedAt).not.toBe('2024-01-01T00:00:00Z');
    });

    it('should use atomic write pattern', async () => {
      const state: JobState = {
        version: 1,
        jobs: [],
        updatedAt: new Date().toISOString(),
      };

      await saveJobState(state);
      const file = Bun.file(TEST_STATE_FILE);
      expect(await file.exists()).toBe(true);

      const tempFile = Bun.file(`${TEST_STATE_FILE}.tmp`);
      expect(await tempFile.exists()).toBe(false);
    });
  });

  describe('addJob', () => {
    it('should add a job to the state', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'My Job',
        worktreePath: '/path/to/worktree',
        branch: 'feature',
        tmuxTarget: 'mc-myjob',
        placement: 'session',
        status: 'running',
        prompt: 'Do something',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      await addJob(job);
      const state = await loadJobState();

      expect(state.jobs).toHaveLength(1);
      expect(state.jobs[0].id).toBe('job-1');
      expect(state.jobs[0].name).toBe('My Job');
    });

    it('should add multiple jobs', async () => {
      const job1: Job = {
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
      };

      const job2: Job = {
        id: 'job-2',
        name: 'Job 2',
        worktreePath: '/path/2',
        branch: 'develop',
        tmuxTarget: 'mc-job2',
        placement: 'window',
        status: 'completed',
        prompt: 'Prompt 2',
        mode: 'plan',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      await addJob(job1);
      await addJob(job2);
      const state = await loadJobState();

      expect(state.jobs).toHaveLength(2);
      expect(state.jobs[0].id).toBe('job-1');
      expect(state.jobs[1].id).toBe('job-2');
    });
  });

  describe('updateJob', () => {
    it('should update job fields', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'Original Name',
        worktreePath: '/path/to/worktree',
        branch: 'main',
        tmuxTarget: 'mc-job1',
        placement: 'session',
        status: 'running',
        prompt: 'Original prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      await addJob(job);
      await updateJob('job-1', {
        status: 'completed',
        completedAt: new Date().toISOString(),
        exitCode: 0,
      });

      const updated = await getJob('job-1');
      expect(updated?.status).toBe('completed');
      expect(updated?.completedAt).toBeDefined();
      expect(updated?.exitCode).toBe(0);
      expect(updated?.name).toBe('Original Name');
    });

    it('should throw error if job not found', async () => {
      await expect(updateJob('nonexistent', { status: 'completed' })).rejects.toThrow(
        'Job with id nonexistent not found'
      );
    });
  });

  describe('removeJob', () => {
    it('should remove a job from state', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'Job to Remove',
        worktreePath: '/path/to/worktree',
        branch: 'main',
        tmuxTarget: 'mc-job1',
        placement: 'session',
        status: 'running',
        prompt: 'Prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      await addJob(job);
      let state = await loadJobState();
      expect(state.jobs).toHaveLength(1);

      await removeJob('job-1');
      state = await loadJobState();
      expect(state.jobs).toHaveLength(0);
    });

    it('should throw error if job not found', async () => {
      await expect(removeJob('nonexistent')).rejects.toThrow(
        'Job with id nonexistent not found'
      );
    });
  });

  describe('getJob', () => {
    it('should return job by id', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'Test Job',
        worktreePath: '/path/to/worktree',
        branch: 'main',
        tmuxTarget: 'mc-job1',
        placement: 'session',
        status: 'running',
        prompt: 'Prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      await addJob(job);
      const retrieved = await getJob('job-1');

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('job-1');
      expect(retrieved?.name).toBe('Test Job');
    });

    it('should return undefined if job not found', async () => {
      const retrieved = await getJob('nonexistent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getJobByName', () => {
    it('should return job by name', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'Unique Job Name',
        worktreePath: '/path/to/worktree',
        branch: 'main',
        tmuxTarget: 'mc-job1',
        placement: 'session',
        status: 'running',
        prompt: 'Prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      await addJob(job);
      const retrieved = await getJobByName('Unique Job Name');

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('job-1');
      expect(retrieved?.name).toBe('Unique Job Name');
    });

    it('should return undefined if job not found', async () => {
      const retrieved = await getJobByName('Nonexistent Job');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getRunningJobs', () => {
    it('should return only running jobs', async () => {
      const runningJob: Job = {
        id: 'job-1',
        name: 'Running Job',
        worktreePath: '/path/1',
        branch: 'main',
        tmuxTarget: 'mc-job1',
        placement: 'session',
        status: 'running',
        prompt: 'Prompt 1',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      const completedJob: Job = {
        id: 'job-2',
        name: 'Completed Job',
        worktreePath: '/path/2',
        branch: 'develop',
        tmuxTarget: 'mc-job2',
        placement: 'window',
        status: 'completed',
        prompt: 'Prompt 2',
        mode: 'plan',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      const failedJob: Job = {
        id: 'job-3',
        name: 'Failed Job',
        worktreePath: '/path/3',
        branch: 'bugfix',
        tmuxTarget: 'mc-job3',
        placement: 'window',
        status: 'failed',
        prompt: 'Prompt 3',
        mode: 'ralph',
        createdAt: new Date().toISOString(),
      };

      await addJob(runningJob);
      await addJob(completedJob);
      await addJob(failedJob);

      const running = await getRunningJobs();

      expect(running).toHaveLength(1);
      expect(running[0].id).toBe('job-1');
      expect(running[0].status).toBe('running');
    });

    it('should return empty array if no running jobs', async () => {
      const completedJob: Job = {
        id: 'job-1',
        name: 'Completed Job',
        worktreePath: '/path/1',
        branch: 'main',
        tmuxTarget: 'mc-job1',
        placement: 'session',
        status: 'completed',
        prompt: 'Prompt',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      await addJob(completedJob);
      const running = await getRunningJobs();

      expect(running).toHaveLength(0);
    });
  });
});
