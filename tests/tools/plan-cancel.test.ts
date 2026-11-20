import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as planState from '../../src/lib/plan-state';
import * as orchestrator from '../../src/lib/orchestrator';
import * as config from '../../src/lib/config';
import * as monitor from '../../src/lib/monitor';
import * as singleton from '../../src/lib/orchestrator-singleton';

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

      expect(result.content).toContain('No active plan to cancel');
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
      const mockDispose = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(orchestrator, 'Orchestrator').mockImplementation(
        () =>
          ({
            cancelPlan: mockCancelPlan,
            dispose: mockDispose,
          }) as any,
      );

      const result = await mc_plan_cancel.execute({}, mockContext);

      expect(result.content).toContain('Plan "Feature Sprint" canceled');
      expect(result.content).toContain('plan-1');
      expect(result.content).toContain('All running jobs have been stopped');
      expect(mockCancelPlan).toHaveBeenCalled();
      // The orchestrator used for canceling is retired again afterwards.
      expect(mockDispose).toHaveBeenCalledTimes(1);
      expect(singleton.getSharedOrchestrator()).toBeNull();
    });

    it('retires the orchestrator that is running the plan before taking the plan apart', async () => {
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

      const order: string[] = [];
      const live = {
        dispose: vi.fn(async () => {
          // Stands in for a reconcile pass that is still launching a job.
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push('live orchestrator disposed');
        }),
      };
      singleton.setSharedOrchestrator(live as any);

      vi.spyOn(orchestrator, 'Orchestrator').mockImplementation(
        () =>
          ({
            cancelPlan: vi.fn(async () => {
              order.push('plan canceled');
            }),
            dispose: vi.fn().mockResolvedValue(undefined),
          }) as any,
      );

      await mc_plan_cancel.execute({}, mockContext);

      expect(live.dispose).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['live orchestrator disposed', 'plan canceled']);
      expect(singleton.getSharedOrchestrator()).toBeNull();
    });
  });
});
