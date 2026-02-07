import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as planState from '../../src/lib/plan-state';
import * as orchestrator from '../../src/lib/orchestrator';
import * as config from '../../src/lib/config';
import * as monitor from '../../src/lib/monitor';

const { mc_plan_cancel } = await import('../../src/tools/plan-cancel');

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

describe('mc_plan_cancel', () => {
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
      expect(mc_plan_cancel.description).toContain('Cancel');
    });
  });

  describe('no active plan', () => {
    it('should return no plan message', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);

      const result = await mc_plan_cancel.execute({}, mockContext);

      expect(result).toContain('No active plan to cancel');
    });
  });

  describe('cancel active plan', () => {
    it('should call orchestrator.cancelPlan and return confirmation', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue({
        id: 'plan-1',
        name: 'Feature Sprint',
        mode: 'autopilot',
        status: 'running',
        jobs: [],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      const mockCancelPlan = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(orchestrator, 'Orchestrator').mockImplementation(
        () =>
          ({
            cancelPlan: mockCancelPlan,
          }) as any,
      );

      const result = await mc_plan_cancel.execute({}, mockContext);

      expect(result).toContain('Plan "Feature Sprint" canceled');
      expect(result).toContain('plan-1');
      expect(result).toContain('All running jobs have been stopped');
      expect(mockCancelPlan).toHaveBeenCalled();
    });
  });
});
