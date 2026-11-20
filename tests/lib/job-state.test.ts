import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import {
  loadJobState,
  saveJobState,
  addJob,
  updateJob,
  removeJob,
  getJob,
  getJobByName,
  getRunningJobs,
  migrateJobState,
  type Job,
  type JobState,
} from '../../src/lib/job-state';

let testStateDir: string;

function getTestStateFile(): string {
  return join(testStateDir, 'jobs.json');
}

async function createTempDir(): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), 'mc-job-state-test-'));
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Job 1',
    worktreePath: '/path/1',
    branch: 'branch-1',
    status: 'running',
    prompt: 'Prompt 1',
    createdAt: '2026-01-01T00:00:00.000Z',
    sessionID: 'ses_job1',
    ...overrides,
  };
}

/** A job record exactly as a 1.x release wrote it (tmux-hosted). */
function makeLegacyJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'legacy-1',
    name: 'Legacy Job',
    worktreePath: '/path/to/legacy',
    branch: 'mc/legacy',
    baseBranch: 'main',
    tmuxTarget: 'mc-legacy',
    placement: 'session',
    status: 'running',
    prompt: 'Legacy prompt',
    mode: 'vanilla',
    planFile: 'plan.md',
    createdAt: '2026-01-01T00:00:00.000Z',
    exitCode: 0,
    planId: 'plan-1',
    launchSessionID: 'ses_launcher',
    port: 14100,
    serverUrl: 'http://127.0.0.1:14100',
    serverPassword: 'secret',
    remoteSessionID: 'ses_remote',
    ...overrides,
  };
}

const REMOVED_FIELDS = [
  'tmuxTarget',
  'placement',
  'mode',
  'planFile',
  'port',
  'serverUrl',
  'serverPassword',
  'exitCode',
  'remoteSessionID',
];

describe('job-state', () => {
  beforeEach(async () => {
    testStateDir = await createTempDir();
    vi.spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const fs = await import('fs');
    if (fs.existsSync(testStateDir)) {
      fs.rmSync(testStateDir, { recursive: true, force: true });
    }
  });

  describe('loadJobState', () => {
    it('should return default state when file does not exist', async () => {
      const state = await loadJobState();
      expect(state.version).toBe(4);
      expect(state.jobs).toEqual([]);
      expect(state.updatedAt).toBeDefined();
    });

    it('should load existing state from file', async () => {
      const testState: JobState = {
        version: 4,
        jobs: [makeJob({ agent: 'build', model: 'openai/gpt-5#high' })],
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      await Bun.write(getTestStateFile(), JSON.stringify(testState));
      const loaded = await loadJobState();

      expect(loaded).toEqual(testState);
    });

    it('should throw error on invalid JSON', async () => {
      await Bun.write(getTestStateFile(), 'invalid json {');

      await expect(loadJobState()).rejects.toThrow('Failed to load job state');
    });

    it('should throw a descriptive error on an invalid current-version state', async () => {
      await Bun.write(
        getTestStateFile(),
        JSON.stringify({ version: 4, jobs: [{ id: 'broken' }], updatedAt: 'now' }),
      );

      await expect(loadJobState()).rejects.toThrow('Invalid job state');
    });
  });

  describe('saveJobState', () => {
    it('should save state at the current version', async () => {
      await saveJobState({ version: 4, jobs: [], updatedAt: 'stale' });

      const saved = JSON.parse(await Bun.file(getTestStateFile()).text());
      expect(saved.version).toBe(4);
      expect(saved.jobs).toEqual([]);
    });

    it('should refresh updatedAt', async () => {
      const oldTime = new Date(Date.now() - 10000).toISOString();

      await saveJobState({ version: 4, jobs: [], updatedAt: oldTime });
      const loaded = await loadJobState();

      expect(new Date(loaded.updatedAt).getTime()).toBeGreaterThan(new Date(oldTime).getTime());
    });

    it('should use atomic write pattern', async () => {
      await saveJobState({ version: 4, jobs: [], updatedAt: new Date().toISOString() });

      expect(await Bun.file(getTestStateFile()).exists()).toBe(true);
      expect(await Bun.file(`${getTestStateFile()}.tmp`).exists()).toBe(false);
    });
  });

  describe('addJob', () => {
    it('should add a job to state', async () => {
      const job = makeJob();

      await addJob(job);
      const state = await loadJobState();

      expect(state.jobs).toEqual([job]);
    });

    it('should add multiple jobs', async () => {
      await addJob(makeJob());
      await addJob(makeJob({ id: 'job-2', name: 'Job 2', sessionID: 'ses_job2' }));

      const state = await loadJobState();
      expect(state.jobs.map((job) => job.id)).toEqual(['job-1', 'job-2']);
    });
  });

  describe('updateJob', () => {
    it('should update an existing job', async () => {
      await addJob(makeJob());

      await updateJob('job-1', { status: 'completed', completedAt: '2026-01-02T00:00:00.000Z' });

      const state = await loadJobState();
      expect(state.jobs[0].status).toBe('completed');
      expect(state.jobs[0].completedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(state.jobs[0].sessionID).toBe('ses_job1');
    });

    it('should throw error if job not found', async () => {
      await expect(updateJob('nonexistent', { status: 'completed' })).rejects.toThrow(
        'Job with id nonexistent not found',
      );
    });
  });

  describe('removeJob', () => {
    it('should remove a job from state', async () => {
      await addJob(makeJob());

      await removeJob('job-1');

      expect((await loadJobState()).jobs).toEqual([]);
    });

    it('should throw error if job not found', async () => {
      await expect(removeJob('nonexistent')).rejects.toThrow('Job with id nonexistent not found');
    });
  });

  describe('getJob', () => {
    it('should retrieve a job by id', async () => {
      const job = makeJob();
      await addJob(job);

      expect(await getJob('job-1')).toEqual(job);
    });

    it('should return undefined if job not found', async () => {
      expect(await getJob('nonexistent')).toBeUndefined();
    });
  });

  describe('getJobByName', () => {
    it('should retrieve a job by name', async () => {
      const job = makeJob({ name: 'My Special Job' });
      await addJob(job);

      expect(await getJobByName('My Special Job')).toEqual(job);
    });

    it('should return undefined if job not found', async () => {
      expect(await getJobByName('Nonexistent Job')).toBeUndefined();
    });
  });

  describe('getRunningJobs', () => {
    it('should return only running jobs', async () => {
      await addJob(makeJob({ id: 'job-1', name: 'Job 1', status: 'running' }));
      await addJob(makeJob({ id: 'job-2', name: 'Job 2', status: 'completed' }));
      await addJob(makeJob({ id: 'job-3', name: 'Job 3', status: 'running' }));
      await addJob(makeJob({ id: 'job-4', name: 'Job 4', status: 'stopped' }));

      const running = await getRunningJobs();

      expect(running.map((job) => job.id)).toEqual(['job-1', 'job-3']);
    });

    it('should return empty array if no running jobs', async () => {
      await addJob(makeJob({ status: 'completed' }));

      expect(await getRunningJobs()).toEqual([]);
    });
  });

  describe('migrateJobState (older versions to v4)', () => {
    it.each([1, 2, 3])('should bump a v%i state to version 4', (version) => {
      const migrated = migrateJobState({
        version,
        jobs: [makeLegacyJob()],
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      expect(migrated.version).toBe(4);
      expect(migrated.updatedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(migrated.jobs).toHaveLength(1);
    });

    it('should treat a state without a version as legacy', () => {
      const migrated = migrateJobState({ jobs: [makeLegacyJob()], updatedAt: '2026-01-01T00:00:00.000Z' });

      expect(migrated.version).toBe(4);
      expect(migrated.jobs[0].status).toBe('stopped');
    });

    it('should mark jobs that were running as stopped', () => {
      const before = Date.now();
      const migrated = migrateJobState({
        version: 3,
        jobs: [makeLegacyJob({ status: 'running' })],
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      expect(migrated.jobs[0].status).toBe('stopped');
      expect(new Date(migrated.jobs[0].completedAt as string).getTime()).toBeGreaterThanOrEqual(before);
    });

    it('should keep the status and completion time of finished jobs', () => {
      const migrated = migrateJobState({
        version: 3,
        jobs: [
          makeLegacyJob({ id: 'a', status: 'completed', completedAt: '2026-01-01T01:00:00.000Z' }),
          makeLegacyJob({ id: 'b', status: 'failed', completedAt: '2026-01-01T02:00:00.000Z' }),
          makeLegacyJob({ id: 'c', status: 'stopped', completedAt: '2026-01-01T03:00:00.000Z' }),
        ],
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      expect(migrated.jobs.map((job) => [job.id, job.status, job.completedAt])).toEqual([
        ['a', 'completed', '2026-01-01T01:00:00.000Z'],
        ['b', 'failed', '2026-01-01T02:00:00.000Z'],
        ['c', 'stopped', '2026-01-01T03:00:00.000Z'],
      ]);
    });

    it('should drop the fields that no longer exist', () => {
      const migrated = migrateJobState({
        version: 3,
        jobs: [makeLegacyJob()],
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      for (const field of REMOVED_FIELDS) {
        expect(migrated.jobs[0]).not.toHaveProperty(field);
      }
    });

    it('should keep what mc_cleanup needs to remove the worktree and branch', () => {
      const migrated = migrateJobState({
        version: 3,
        jobs: [makeLegacyJob()],
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      expect(migrated.jobs[0]).toEqual({
        id: 'legacy-1',
        name: 'Legacy Job',
        worktreePath: '/path/to/legacy',
        branch: 'mc/legacy',
        baseBranch: 'main',
        status: 'stopped',
        prompt: 'Legacy prompt',
        createdAt: '2026-01-01T00:00:00.000Z',
        completedAt: expect.any(String),
        planId: 'plan-1',
        launchSessionID: 'ses_launcher',
      });
    });

    it('should not carry a legacy remote session over as the job session', () => {
      const migrated = migrateJobState({
        version: 3,
        jobs: [makeLegacyJob({ remoteSessionID: 'ses_remote' })],
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      expect(migrated.jobs[0].sessionID).toBeUndefined();
    });

    it('should handle an empty or missing jobs array', () => {
      expect(migrateJobState({ version: 2, jobs: [], updatedAt: '2026-01-01T00:00:00.000Z' }).jobs).toEqual([]);
      expect(migrateJobState({ version: 1 }).jobs).toEqual([]);
    });

    it('should leave a v4 state untouched, including running jobs', () => {
      const state: JobState = {
        version: 4,
        jobs: [makeJob({ status: 'running' })],
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      expect(migrateJobState(state as unknown as Record<string, unknown>)).toEqual(state);
    });
  });

  describe('loading an older state file from disk', () => {
    async function writeLegacyFile(): Promise<void> {
      await Bun.write(
        getTestStateFile(),
        JSON.stringify({
          version: 3,
          jobs: [
            makeLegacyJob({ id: 'was-running', name: 'was-running', status: 'running' }),
            makeLegacyJob({
              id: 'was-done',
              name: 'was-done',
              status: 'completed',
              completedAt: '2026-01-01T01:00:00.000Z',
            }),
          ],
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
    }

    it('should migrate on load without resuming old jobs', async () => {
      await writeLegacyFile();

      const loaded = await loadJobState();

      expect(loaded.version).toBe(4);
      expect(loaded.jobs.map((job) => [job.id, job.status])).toEqual([
        ['was-running', 'stopped'],
        ['was-done', 'completed'],
      ]);
      expect(await getRunningJobs()).toEqual([]);
    });

    it('should keep legacy jobs findable so they can be cleaned up', async () => {
      await writeLegacyFile();

      const job = await getJobByName('was-running');

      expect(job).toMatchObject({
        id: 'was-running',
        status: 'stopped',
        worktreePath: '/path/to/legacy',
        branch: 'mc/legacy',
      });
    });

    it('should persist the migrated state on the next write', async () => {
      await writeLegacyFile();

      await removeJob('was-done');
      const onDisk = JSON.parse(await Bun.file(getTestStateFile()).text());

      expect(onDisk.version).toBe(4);
      expect(onDisk.jobs).toHaveLength(1);
      expect(onDisk.jobs[0].id).toBe('was-running');
      expect(onDisk.jobs[0].status).toBe('stopped');
      for (const field of REMOVED_FIELDS) {
        expect(onDisk.jobs[0]).not.toHaveProperty(field);
      }
    });
  });
});
