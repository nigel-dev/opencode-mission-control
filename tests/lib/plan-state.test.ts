import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import type { PlanSpec, JobSpec } from '../../src/lib/plan-types';
import {
  loadPlan,
  savePlan,
  getActivePlan,
  updatePlanJob,
  clearPlan,
  validateGhAuth,
} from '../../src/lib/plan-state';

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
