import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PlanSpec, JobSpec } from '../../src/lib/plan-types';

vi.mock('../../src/lib/paths', () => ({
  getDataDir: vi.fn(),
}));

const paths = await import('../../src/lib/paths');
const {
  loadPlan,
  savePlan,
  getActivePlan,
  updatePlanJob,
  updatePlanFields,
  clearPlan,
  validateGhAuth,
} = await import('../../src/lib/plan-state');

let testStateDir: string;

function getPlanFile(): string {
  return join(testStateDir, 'plan.json');
}

async function createTempDir(): Promise<string> {
  const fs = await import('fs');
  return fs.promises.mkdtemp(join(tmpdir(), 'mc-plan-state-test-'));
}

function makePlan(overrides: Partial<PlanSpec> = {}): PlanSpec {
  return {
    id: 'plan-1',
    name: 'Test Plan',
    mode: 'copilot',
    status: 'pending',
    jobs: [],
    integrationBranch: 'mc/integrate/test-plan',
    baseCommit: 'abc123',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    id: 'job-1',
    name: 'fix-login',
    prompt: 'Fix the login bug',
    status: 'queued',
    ...overrides,
  };
}

describe('plan-state', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    testStateDir = await createTempDir();
    (paths.getDataDir as any).mockResolvedValue(testStateDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const fs = await import('fs');
    if (fs.existsSync(testStateDir)) {
      fs.rmSync(testStateDir, { recursive: true, force: true });
    }
  });

  describe('loadPlan', () => {
    it('returns null when no plan exists', async () => {
      const plan = await loadPlan();
      expect(plan).toBeNull();
    });

    it('returns plan when it exists', async () => {
      const testPlan = makePlan();
      await Bun.write(getPlanFile(), JSON.stringify(testPlan));

      const loaded = await loadPlan();
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('plan-1');
      expect(loaded!.name).toBe('Test Plan');
    });
  });

  describe('savePlan', () => {
    it('creates plan.json at correct XDG path', async () => {
      const plan = makePlan();
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(true);

      await savePlan(plan);

      const file = Bun.file(getPlanFile());
      expect(await file.exists()).toBe(true);

      const saved = JSON.parse(await file.text());
      expect(saved.id).toBe('plan-1');
      expect(saved.ghAuthenticated).toBe(true);
    });

    it('throws when saving a different plan ID (single-plan enforcement)', async () => {
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(true);

      await savePlan(makePlan({ id: 'plan-1' }));

      await expect(
        savePlan(makePlan({ id: 'plan-2', name: 'Other Plan' })),
      ).rejects.toThrow('active plan already exists');
    });

    it('allows overwrite with same ID (update)', async () => {
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(true);

      await savePlan(makePlan({ id: 'plan-1', name: 'Original' }));
      await savePlan(makePlan({ id: 'plan-1', name: 'Updated' }));

      const loaded = await loadPlan();
      expect(loaded!.name).toBe('Updated');
    });

    it('uses atomic write (no .tmp left behind)', async () => {
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(true);

      await savePlan(makePlan());

      const tmpFile = Bun.file(`${getPlanFile()}.tmp`);
      expect(await tmpFile.exists()).toBe(false);
    });

    it('stores gh auth validation result in plan', async () => {
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(false);

      await savePlan(makePlan());

      const file = Bun.file(getPlanFile());
      const saved = JSON.parse(await file.text());
      expect(saved.ghAuthenticated).toBe(false);
    });
  });

  describe('getActivePlan', () => {
    it('returns null when no plan exists', async () => {
      const plan = await getActivePlan();
      expect(plan).toBeNull();
    });

    it('returns plan when it exists', async () => {
      const testPlan = makePlan();
      await Bun.write(getPlanFile(), JSON.stringify(testPlan));

      const plan = await getActivePlan();
      expect(plan).not.toBeNull();
      expect(plan!.id).toBe('plan-1');
    });
  });

  describe('updatePlanJob', () => {
    it('updates a specific job in the plan', async () => {
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(true);

      const plan = makePlan({
        jobs: [
          makeJob({ name: 'fix-login', status: 'queued' }),
          makeJob({ id: 'job-2', name: 'add-pricing', status: 'queued' }),
        ],
      });
      await savePlan(plan);

      await updatePlanJob('plan-1', 'fix-login', { status: 'running' });

      const loaded = await loadPlan();
      expect(loaded!.jobs[0].status).toBe('running');
      expect(loaded!.jobs[1].status).toBe('queued');
    });

    it('throws when plan ID does not match', async () => {
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(true);

      await savePlan(makePlan({ id: 'plan-1' }));

      await expect(
        updatePlanJob('plan-wrong', 'fix-login', { status: 'running' }),
      ).rejects.toThrow('Plan ID mismatch');
    });

    it('throws when job name not found', async () => {
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(true);

      await savePlan(
        makePlan({ jobs: [makeJob({ name: 'fix-login' })] }),
      );

      await expect(
        updatePlanJob('plan-1', 'nonexistent-job', { status: 'running' }),
      ).rejects.toThrow('Job "nonexistent-job" not found');
    });

    it('throws when no active plan exists', async () => {
      await expect(
        updatePlanJob('plan-1', 'fix-login', { status: 'running' }),
      ).rejects.toThrow('No active plan exists');
    });
  });

  describe('updatePlanFields', () => {
    it('updates plan-level fields without overwriting job states', async () => {
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(true);

      const plan = makePlan({
        status: 'running',
        jobs: [
          makeJob({ name: 'job-a', status: 'completed' }),
          makeJob({ id: 'job-2', name: 'job-b', status: 'completed' }),
        ],
      });
      await savePlan(plan);

      await updatePlanFields('plan-1', { status: 'paused', checkpoint: 'on_error' });

      const loaded = await loadPlan();
      expect(loaded!.status).toBe('paused');
      expect(loaded!.checkpoint).toBe('on_error');
      expect(loaded!.jobs[0].status).toBe('completed');
      expect(loaded!.jobs[1].status).toBe('completed');
    });

    it('preserves job updates made concurrently', async () => {
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(true);

      const plan = makePlan({
        status: 'running',
        jobs: [
          makeJob({ name: 'job-a', status: 'running' }),
          makeJob({ id: 'job-2', name: 'job-b', status: 'running' }),
          makeJob({ id: 'job-3', name: 'job-c', status: 'running' }),
        ],
      });
      await savePlan(plan);

      await Promise.all([
        updatePlanJob('plan-1', 'job-b', { status: 'completed' }),
        updatePlanJob('plan-1', 'job-c', { status: 'completed' }),
        updatePlanFields('plan-1', { status: 'paused', checkpoint: 'on_error' }),
      ]);

      const loaded = await loadPlan();
      expect(loaded!.status).toBe('paused');
      expect(loaded!.jobs[0].status).toBe('running');
      expect(loaded!.jobs[1].status).toBe('completed');
      expect(loaded!.jobs[2].status).toBe('completed');
    });

    it('throws when plan ID does not match', async () => {
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(true);

      await savePlan(makePlan({ id: 'plan-1' }));

      await expect(
        updatePlanFields('plan-wrong', { status: 'paused' }),
      ).rejects.toThrow('Plan ID mismatch');
    });

    it('throws when no active plan exists', async () => {
      await expect(
        updatePlanFields('plan-1', { status: 'paused' }),
      ).rejects.toThrow('No active plan exists');
    });

    it('updates checkpointContext field', async () => {
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(true);

      await savePlan(makePlan({ status: 'running' }));

      await updatePlanFields('plan-1', {
        status: 'paused',
        checkpoint: 'on_error',
        checkpointContext: { jobName: 'bad-job', failureKind: 'job_failed' },
      });

      const loaded = await loadPlan();
      expect(loaded!.checkpointContext).toEqual({
        jobName: 'bad-job',
        failureKind: 'job_failed',
      });
    });
  });

  describe('clearPlan', () => {
    it('removes plan.json', async () => {
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(true);

      await savePlan(makePlan());
      expect(await Bun.file(getPlanFile()).exists()).toBe(true);

      await clearPlan();
      expect(await Bun.file(getPlanFile()).exists()).toBe(false);
    });

    it('does not throw when no plan exists', async () => {
      await expect(clearPlan()).resolves.toBeUndefined();
    });
  });

  describe('concurrent operations', () => {
    it('do not corrupt state under concurrent writes', async () => {
      vi.spyOn(
        await import('../../src/lib/plan-state'),
        'validateGhAuth',
      ).mockResolvedValue(true);

      const plan = makePlan({
        jobs: [
          makeJob({ name: 'job-a', status: 'queued' }),
          makeJob({ id: 'job-2', name: 'job-b', status: 'queued' }),
          makeJob({ id: 'job-3', name: 'job-c', status: 'queued' }),
        ],
      });
      await savePlan(plan);

      await Promise.all([
        updatePlanJob('plan-1', 'job-a', { status: 'running' }),
        updatePlanJob('plan-1', 'job-b', { status: 'running' }),
        updatePlanJob('plan-1', 'job-c', { status: 'running' }),
      ]);

      const loaded = await loadPlan();
      const statuses = loaded!.jobs.map((j) => j.status);
      expect(statuses).toEqual(['running', 'running', 'running']);
    });
  });

  describe('validateGhAuth', () => {
    it('returns a boolean', async () => {
      const result = await validateGhAuth();
      expect(typeof result).toBe('boolean');
    });
  });
});
