import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import { addJob, loadJobState, type Job } from '../../src/lib/job-state';

let testStateDir: string;

function getTestStateFile(): string {
  return join(testStateDir, 'jobs.json');
}

async function createTempDir(): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), 'mc-job-state-mutex-test-'));
}

function createTestJob(id: string, name: string): Job {
  return {
    id,
    name,
    worktreePath: `/path/${id}`,
    branch: 'main',
    tmuxTarget: `mc-${id}`,
    placement: 'session',
    status: 'running',
    prompt: `Prompt for ${name}`,
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
  };
}

describe('job-state-mutex', () => {
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

  describe('concurrent writes', () => {
    it('should serialize concurrent addJob calls and prevent lost updates', async () => {
      const job1 = createTestJob('job-1', 'Job 1');
      const job2 = createTestJob('job-2', 'Job 2');
      const job3 = createTestJob('job-3', 'Job 3');

      // Launch three concurrent addJob operations
      const results = await Promise.all([
        addJob(job1),
        addJob(job2),
        addJob(job3),
      ]);

      // All operations should complete without error
      expect(results).toHaveLength(3);

      // Verify all three jobs were persisted (no lost updates)
      const state = await loadJobState();
      expect(state.jobs).toHaveLength(3);
      expect(state.jobs.map((j) => j.id).sort()).toEqual(['job-1', 'job-2', 'job-3']);
      expect(state.jobs.map((j) => j.name).sort()).toEqual(['Job 1', 'Job 2', 'Job 3']);
    });

    it('should handle rapid sequential writes without data loss', async () => {
      const jobs = Array.from({ length: 10 }, (_, i) =>
        createTestJob(`job-${i}`, `Job ${i}`)
      );

      // Add all jobs sequentially (but rapidly)
      for (const job of jobs) {
        await addJob(job);
      }

      // Verify all jobs were persisted
      const state = await loadJobState();
      expect(state.jobs).toHaveLength(10);
      expect(state.jobs.map((j) => j.id).sort()).toEqual(
        Array.from({ length: 10 }, (_, i) => `job-${i}`)
      );
    });
  });
});
