import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as planState from '../../src/lib/plan-state';
import * as orchestrator from '../../src/lib/orchestrator';
import * as git from '../../src/lib/git';
import * as config from '../../src/lib/config';
import * as monitor from '../../src/lib/monitor';

const { mc_plan } = await import('../../src/tools/plan');

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

describe('mc_plan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);
    vi.spyOn(planState, 'savePlan').mockResolvedValue(undefined);
    vi.spyOn(planState, 'validateGhAuth').mockResolvedValue(true);
    vi.spyOn(git, 'gitCommand').mockResolvedValue({
      stdout: 'abc123def',
      stderr: '',
      exitCode: 0,
    });
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      defaultPlacement: 'session',
      pollInterval: 10000,
      idleThreshold: 300000,
      worktreeBasePath: '/tmp',
      omo: { enabled: false, defaultMode: 'vanilla' },
    });
    vi.spyOn(monitor, 'JobMonitor').mockImplementation(
      () => ({ start: vi.fn(), on: vi.fn(), off: vi.fn() }) as any,
    );
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_plan.description).toContain('orchestrated plan');
    });

    it('should have required args: name, jobs', () => {
      expect(mc_plan.args.name).toBeDefined();
      expect(mc_plan.args.jobs).toBeDefined();
    });

    it('should have optional arg: mode', () => {
      expect(mc_plan.args.mode).toBeDefined();
    });
  });

  describe('validation', () => {
    it('should reject duplicate job names', async () => {
      await expect(
        mc_plan.execute(
          {
            name: 'test-plan',
            jobs: [
              { name: 'job-a', prompt: 'do a' },
              { name: 'job-a', prompt: 'do b' },
            ],
          },
          mockContext,
        ),
      ).rejects.toThrow('Job names must be unique');
    });

    it('should reject unknown dependency references', async () => {
      await expect(
        mc_plan.execute(
          {
            name: 'test-plan',
            jobs: [
              { name: 'job-a', prompt: 'do a', dependsOn: ['job-z'] },
            ],
          },
          mockContext,
        ),
      ).rejects.toThrow('depends on unknown job "job-z"');
    });

    it('should reject circular dependencies', async () => {
      await expect(
        mc_plan.execute(
          {
            name: 'test-plan',
            jobs: [
              { name: 'job-a', prompt: 'do a', dependsOn: ['job-b'] },
              { name: 'job-b', prompt: 'do b', dependsOn: ['job-a'] },
            ],
          },
          mockContext,
        ),
      ).rejects.toThrow('circular dependencies');
    });

    it('should reject if active plan already exists', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'existing',
        name: 'existing-plan',
        mode: 'autopilot',
        status: 'running',
        jobs: [],
        integrationBranch: 'mc/integration',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      });

      await expect(
        mc_plan.execute(
          {
            name: 'test-plan',
            jobs: [{ name: 'job-a', prompt: 'do a' }],
          },
          mockContext,
        ),
      ).rejects.toThrow('Active plan already exists');
    });
  });

  describe('copilot mode', () => {
    it('should persist plan as pending and return approval message', async () => {
      const result = await mc_plan.execute(
        {
          name: 'test-plan',
          jobs: [{ name: 'job-a', prompt: 'do a' }],
          mode: 'copilot',
        },
        mockContext,
      );

      expect(result).toContain('pending approval');
      expect(result).toContain('mc_plan_approve');
      expect(planState.savePlan).toHaveBeenCalled();
    });

    it('should include job summary in copilot output', async () => {
      const result = await mc_plan.execute(
        {
          name: 'test-plan',
          jobs: [
            { name: 'job-a', prompt: 'do a' },
            { name: 'job-b', prompt: 'do b', dependsOn: ['job-a'] },
          ],
          mode: 'copilot',
        },
        mockContext,
      );

      expect(result).toContain('job-a');
      expect(result).toContain('job-b');
      expect(result).toContain('depends on: job-a');
    });
  });

  describe('autopilot mode', () => {
    it('should start plan immediately via orchestrator', async () => {
      const mockStartPlan = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(orchestrator, 'Orchestrator').mockImplementation(
        () =>
          ({
            startPlan: mockStartPlan,
          }) as any,
      );

      const result = await mc_plan.execute(
        {
          name: 'test-plan',
          jobs: [{ name: 'job-a', prompt: 'do a' }],
        },
        mockContext,
      );

      expect(result).toContain('started');
      expect(result).toContain('mc_plan_status');
      expect(mockStartPlan).toHaveBeenCalled();
    });

    it('should default to autopilot when no mode specified', async () => {
      const mockStartPlan = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(orchestrator, 'Orchestrator').mockImplementation(
        () =>
          ({
            startPlan: mockStartPlan,
          }) as any,
      );

      const result = await mc_plan.execute(
        {
          name: 'test-plan',
          jobs: [{ name: 'job-a', prompt: 'do a' }],
        },
        mockContext,
      );

      expect(result).toContain('autopilot');
    });
  });

  describe('output format', () => {
    it('should include plan ID in output', async () => {
      const mockStartPlan = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(orchestrator, 'Orchestrator').mockImplementation(
        () =>
          ({
            startPlan: mockStartPlan,
          }) as any,
      );

      const result = await mc_plan.execute(
        {
          name: 'test-plan',
          jobs: [{ name: 'job-a', prompt: 'do a' }],
        },
        mockContext,
      );

      expect(result).toContain('ID:');
      expect(result).toContain('Jobs:');
    });

    it('should include gh auth status in output', async () => {
      vi.spyOn(planState, 'validateGhAuth').mockResolvedValue(false);

      const result = await mc_plan.execute(
        {
          name: 'test-plan',
          jobs: [{ name: 'job-a', prompt: 'do a' }],
          mode: 'copilot',
        },
        mockContext,
      );

      expect(result).toContain('gh auth: no');
    });
  });
});
