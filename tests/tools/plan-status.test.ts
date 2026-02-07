import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as planState from '../../src/lib/plan-state';
import type { PlanSpec } from '../../src/lib/plan-types';

const { mc_plan_status } = await import('../../src/tools/plan-status');

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

describe('mc_plan_status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_plan_status.description).toContain('status');
    });
  });

  describe('no active plan', () => {
    it('should return no active plan message', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);

      const result = await mc_plan_status.execute({}, mockContext);

      expect(result).toBe('No active plan.');
    });
  });

  describe('active plan display', () => {
    it('should show plan name and status', async () => {
      const plan: PlanSpec = {
        id: 'plan-1',
        name: 'Feature Sprint',
        mode: 'autopilot',
        status: 'running',
        jobs: [
          {
            id: 'job-1',
            name: 'auth',
            prompt: 'implement auth',
            status: 'running',
          },
          {
            id: 'job-2',
            name: 'api',
            prompt: 'build api',
            status: 'queued',
            dependsOn: ['auth'],
          },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      };
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(plan);

      const result = await mc_plan_status.execute({}, mockContext);

      expect(result).toContain('Plan: Feature Sprint (running)');
      expect(result).toContain('Mode: autopilot');
    });

    it('should show progress as merged/total', async () => {
      const plan: PlanSpec = {
        id: 'plan-1',
        name: 'Test Plan',
        mode: 'autopilot',
        status: 'running',
        jobs: [
          { id: 'j1', name: 'a', prompt: 'do a', status: 'merged' },
          { id: 'j2', name: 'b', prompt: 'do b', status: 'running' },
          { id: 'j3', name: 'c', prompt: 'do c', status: 'queued' },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      };
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(plan);

      const result = await mc_plan_status.execute({}, mockContext);

      expect(result).toContain('1/3 merged');
    });

    it('should show job status indicators', async () => {
      const plan: PlanSpec = {
        id: 'plan-1',
        name: 'Test Plan',
        mode: 'autopilot',
        status: 'running',
        jobs: [
          { id: 'j1', name: 'running-job', prompt: 'do', status: 'running' },
          { id: 'j2', name: 'queued-job', prompt: 'do', status: 'queued' },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      };
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(plan);

      const result = await mc_plan_status.execute({}, mockContext);

      expect(result).toContain('▶ running-job: running');
      expect(result).toContain('○ queued-job: queued');
    });

    it('should show dependency info for jobs', async () => {
      const plan: PlanSpec = {
        id: 'plan-1',
        name: 'Test Plan',
        mode: 'autopilot',
        status: 'running',
        jobs: [
          { id: 'j1', name: 'base', prompt: 'do', status: 'merged' },
          {
            id: 'j2',
            name: 'dependent',
            prompt: 'do',
            status: 'waiting_deps',
            dependsOn: ['base'],
          },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      };
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(plan);

      const result = await mc_plan_status.execute({}, mockContext);

      expect(result).toContain('deps: base');
    });

    it('should show next actions summary', async () => {
      const plan: PlanSpec = {
        id: 'plan-1',
        name: 'Test Plan',
        mode: 'autopilot',
        status: 'running',
        jobs: [
          { id: 'j1', name: 'a', prompt: 'do', status: 'running' },
          { id: 'j2', name: 'b', prompt: 'do', status: 'queued' },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      };
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(plan);

      const result = await mc_plan_status.execute({}, mockContext);

      expect(result).toContain('1 job(s) running');
      expect(result).toContain('1 job(s) queued');
    });

    it('should show error info for failed jobs', async () => {
      const plan: PlanSpec = {
        id: 'plan-1',
        name: 'Test Plan',
        mode: 'autopilot',
        status: 'failed',
        jobs: [
          {
            id: 'j1',
            name: 'broken',
            prompt: 'do',
            status: 'failed',
            error: 'tmux died',
          },
        ],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
      };
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(plan);

      const result = await mc_plan_status.execute({}, mockContext);

      expect(result).toContain('Error: tmux died');
    });

    it('should show PR URL when available', async () => {
      const plan: PlanSpec = {
        id: 'plan-1',
        name: 'Test Plan',
        mode: 'autopilot',
        status: 'completed',
        jobs: [{ id: 'j1', name: 'a', prompt: 'do', status: 'merged' }],
        integrationBranch: 'mc/integration/plan-1',
        baseCommit: 'abc',
        createdAt: new Date().toISOString(),
        prUrl: 'https://github.com/org/repo/pull/42',
      };
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(plan);

      const result = await mc_plan_status.execute({}, mockContext);

      expect(result).toContain('PR: https://github.com/org/repo/pull/42');
    });
  });
});
