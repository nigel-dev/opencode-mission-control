import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as planState from '../../src/lib/plan-state';
import * as orchestrator from '../../src/lib/orchestrator';
import * as config from '../../src/lib/config';
import * as monitor from '../../src/lib/monitor';

const { mc_plan_approve } = await import('../../src/tools/plan-approve');

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

describe('mc_plan_approve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(mc_plan_approve.description).toContain('copilot');
    });
  });

  describe('no active plan', () => {
    it('should throw error when no plan exists', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);

      await expect(
        mc_plan_approve.execute({}, mockContext),
      ).rejects.toThrow('No active plan to approve');
    });
  });

  describe('non-pending plan', () => {
    it('should throw error when plan is not pending', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Test Plan',
        mode: 'copilot',
        status: 'running',
        jobs: [],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      });

      await expect(
        mc_plan_approve.execute({}, mockContext),
      ).rejects.toThrow('not pending');
    });
  });

  describe('approve pending plan', () => {
    it('should transition plan to running and resume via orchestrator', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Feature Sprint',
        mode: 'copilot',
        status: 'pending',
        jobs: [
          { id: 'j1', name: 'auth', prompt: 'do auth', status: 'queued' },
          { id: 'j2', name: 'api', prompt: 'do api', status: 'queued' },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      const mockSavePlan = vi.spyOn(planState, 'savePlan').mockResolvedValue(undefined);
      const mockResumePlan = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(orchestrator, 'Orchestrator').mockImplementation(
        () =>
          ({
            resumePlan: mockResumePlan,
          }) as any,
      );

      const result = await mc_plan_approve.execute({}, mockContext);

      expect(result).toContain('approved and started');
      expect(result).toContain('plan-1');
      expect(result).toContain('Jobs: 2');
      expect(result).toContain('mc_plan_status');
      expect(mockSavePlan).toHaveBeenCalled();
      expect(mockResumePlan).toHaveBeenCalled();
    });
  });
});
