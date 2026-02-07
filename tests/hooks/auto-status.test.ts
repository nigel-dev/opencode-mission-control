import { describe, it, expect, beforeEach, vi, type Mock, afterEach } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import { tmpdir } from 'os';
import { join } from 'path';
import * as jobState from '../../src/lib/job-state';
import * as worktree from '../../src/lib/worktree';

const { shouldShowAutoStatus, getAutoStatusMessage } = await import(
  '../../src/hooks/auto-status'
);

let mockGetRunningJobs: Mock;
let mockIsInManagedWorktree: Mock;

describe('auto-status hook', () => {
  let testDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetRunningJobs = vi.spyOn(jobState, 'getRunningJobs').mockImplementation(() => [] as any);
    mockIsInManagedWorktree = vi.spyOn(worktree, 'isInManagedWorktree').mockImplementation(() => ({ isManaged: false } as any));
    testDir = join(tmpdir(), `mc-test-${Date.now()}`);
    const fs = await import('fs');
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(join(testDir, '.mission-control'), { recursive: true });
    fs.writeFileSync(join(testDir, '.mission-control', 'jobs.json'), '{}');
    vi.spyOn(process, 'cwd').mockReturnValue(testDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const fs = await import('fs');
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('shouldShowAutoStatus', () => {
    it('should return false when not in command center', async () => {
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: true });
      mockGetRunningJobs.mockResolvedValue([]);

      const result = await shouldShowAutoStatus();

      expect(result).toBe(false);
    });

    it('should return false when jobs.json does not exist', async () => {
      const fs = await import('fs');
      fs.rmSync(join(testDir, '.mission-control', 'jobs.json'));
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: false });
      mockGetRunningJobs.mockResolvedValue([]);

      const result = await shouldShowAutoStatus();

      expect(result).toBe(false);
    });

    it('should return false when no running jobs', async () => {
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: false });
      mockGetRunningJobs.mockResolvedValue([]);

      const result = await shouldShowAutoStatus();

      expect(result).toBe(false);
    });

    it('should return false when rate limited (less than 5 minutes)', async () => {
      const fs = await import('fs');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: false });
      const now = new Date().toISOString();
      mockGetRunningJobs.mockResolvedValue([
        {
          id: 'job-1',
          name: 'test-job',
          status: 'running',
          createdAt: now,
        } as Job,
      ]);

      const recentTime = (Date.now() - 60000).toString();
      fs.writeFileSync(join(testDir, '.mission-control', 'last-status-time'), recentTime);

      const result = await shouldShowAutoStatus();

      expect(result).toBe(false);
    });

    it('should return true when all guards pass', async () => {
      const fs = await import('fs');
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: false });
      const now = new Date().toISOString();
      mockGetRunningJobs.mockResolvedValue([
        {
          id: 'job-1',
          name: 'test-job',
          status: 'running',
          createdAt: now,
        } as Job,
      ]);

      const oldTime = (Date.now() - 6 * 60 * 1000).toString();
      fs.writeFileSync(join(testDir, '.mission-control', 'last-status-time'), oldTime);

      const result = await shouldShowAutoStatus();

      expect(result).toBe(true);
    });

    it('should return true when no previous status file exists', async () => {
      mockIsInManagedWorktree.mockResolvedValue({ isManaged: false });
      const now = new Date().toISOString();
      mockGetRunningJobs.mockResolvedValue([
        {
          id: 'job-1',
          name: 'test-job',
          status: 'running',
          createdAt: now,
        } as Job,
      ]);

      const result = await shouldShowAutoStatus();

      expect(result).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      mockIsInManagedWorktree.mockRejectedValue(new Error('Test error'));

      const result = await shouldShowAutoStatus();

      expect(result).toBe(false);
    });
  });

  describe('getAutoStatusMessage', () => {
    it('should return empty string when no running jobs', async () => {
      mockGetRunningJobs.mockResolvedValue([]);

      const result = await getAutoStatusMessage();

      expect(result).toBe('');
    });

    it('should format single running job', async () => {
      const now = new Date().toISOString();
      mockGetRunningJobs.mockResolvedValue([
        {
          id: 'job-1',
          name: 'feature-auth',
          status: 'running',
          mode: 'plan',
          createdAt: now,
        } as Job,
      ]);

      const result = await getAutoStatusMessage();

      expect(result).toContain('📊 Mission Control Status');
      expect(result).toContain('Running jobs: 1');
      expect(result).toContain('feature-auth');
      expect(result).toContain('plan');
    });

    it('should format multiple running jobs', async () => {
      const now = new Date().toISOString();
      mockGetRunningJobs.mockResolvedValue([
        {
          id: 'job-1',
          name: 'feature-auth',
          status: 'running',
          mode: 'plan',
          createdAt: now,
        } as Job,
        {
          id: 'job-2',
          name: 'refactor-api',
          status: 'running',
          mode: 'ralph',
          createdAt: now,
        } as Job,
      ]);

      const result = await getAutoStatusMessage();

      expect(result).toContain('Running jobs: 2');
      expect(result).toContain('feature-auth');
      expect(result).toContain('refactor-api');
    });

    it('should include job mode in output', async () => {
      const now = new Date().toISOString();
      mockGetRunningJobs.mockResolvedValue([
        {
          id: 'job-1',
          name: 'test-job',
          status: 'running',
          mode: 'vanilla',
          createdAt: now,
        } as Job,
      ]);

      const result = await getAutoStatusMessage();

      expect(result).toContain('vanilla');
    });

    it('should calculate duration correctly for recent jobs', async () => {
      const createdAt = new Date(Date.now() - 30000).toISOString();
      mockGetRunningJobs.mockResolvedValue([
        {
          id: 'job-1',
          name: 'test-job',
          status: 'running',
          mode: 'vanilla',
          createdAt,
        } as Job,
      ]);

      const result = await getAutoStatusMessage();

      expect(result).toMatch(/\d+s/);
    });

    it('should calculate duration correctly for jobs running hours', async () => {
      const createdAt = new Date(Date.now() - 3600000).toISOString();
      mockGetRunningJobs.mockResolvedValue([
        {
          id: 'job-1',
          name: 'test-job',
          status: 'running',
          mode: 'vanilla',
          createdAt,
        } as Job,
      ]);

      const result = await getAutoStatusMessage();

      expect(result).toMatch(/1h/);
    });

    it('should calculate duration correctly for jobs running days', async () => {
      const createdAt = new Date(Date.now() - 86400000).toISOString();
      mockGetRunningJobs.mockResolvedValue([
        {
          id: 'job-1',
          name: 'test-job',
          status: 'running',
          mode: 'vanilla',
          createdAt,
        } as Job,
      ]);

      const result = await getAutoStatusMessage();

      expect(result).toMatch(/1d/);
    });

    it('should update last status time', async () => {
      const fs = await import('fs');
      const now = new Date().toISOString();
      mockGetRunningJobs.mockResolvedValue([
        {
          id: 'job-1',
          name: 'test-job',
          status: 'running',
          mode: 'vanilla',
          createdAt: now,
        } as Job,
      ]);

      await getAutoStatusMessage();

      const lastStatusPath = join(testDir, '.mission-control', 'last-status-time');
      expect(fs.existsSync(lastStatusPath)).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      mockGetRunningJobs.mockRejectedValue(new Error('Test error'));

      const result = await getAutoStatusMessage();

      expect(result).toBe('');
    });
  });
});
