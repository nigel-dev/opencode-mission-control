import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import * as jobState from '../../src/lib/job-state';
import * as planState from '../../src/lib/plan-state';
import * as reports from '../../src/lib/reports';
import * as orchestratorSingleton from '../../src/lib/orchestrator-singleton';

const { mc_overview } = await import('../../src/tools/overview');

let mockLoadJobState: Mock;
let mockGetRunningJobs: Mock;
let mockLoadPlan: Mock;
let mockReadAllReports: Mock;
let mockGetSharedMonitor: Mock;

function createMockJob(overrides?: Partial<jobState.Job>): jobState.Job {
  return {
    id: 'test-job-id',
    name: 'test-job',
    worktreePath: '/tmp/mc-worktrees/test-job',
    branch: 'mc/test-job',
    tmuxTarget: 'mc-test-job',
    placement: 'session',
    status: 'running',
    prompt: 'Test prompt',
    mode: 'vanilla',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    ...overrides,
  };
}

describe('mc_overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    mockLoadJobState = vi.spyOn(jobState, 'loadJobState').mockResolvedValue({
      version: 3,
      jobs: [],
      updatedAt: new Date().toISOString(),
    } as any) as unknown as Mock;
    
    mockGetRunningJobs = vi.spyOn(jobState, 'getRunningJobs').mockResolvedValue([]) as unknown as Mock;
    
    mockLoadPlan = vi.spyOn(planState, 'loadPlan').mockResolvedValue(null) as unknown as Mock;
    
    mockReadAllReports = vi.spyOn(reports, 'readAllReports').mockResolvedValue([]) as unknown as Mock;
    
    mockGetSharedMonitor = vi.spyOn(orchestratorSingleton, 'getSharedMonitor').mockReturnValue({
      getEventAccumulator: vi.fn().mockReturnValue(undefined),
    } as any) as unknown as Mock;
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_overview.description).toContain('Get a complete overview');
    });

    it('should have no required args', () => {
      expect(Object.keys(mc_overview.args)).toHaveLength(0);
    });
  });

  describe('empty state', () => {
    it('should show dashboard header with timestamp', async () => {
      const result = await mc_overview.execute({});

      expect(result).toContain('Mission Control Dashboard');
      expect(result).toContain('Timestamp:');
    });

    it('should show no active plan', async () => {
      const result = await mc_overview.execute({});

      expect(result).toContain('Active Plan');
      expect(result).toContain('- None');
    });

    it('should show zero jobs summary', async () => {
      const result = await mc_overview.execute({});

      expect(result).toContain('Jobs Summary');
      expect(result).toContain('0 running, 0 completed, 0 failed');
    });

    it('should show no running jobs', async () => {
      const result = await mc_overview.execute({});

      expect(result).toContain('Running Jobs');
      expect(result).toContain('- None');
    });
  });

  describe('running jobs with activity indicators', () => {
    it('should show serve-mode jobs with activity state', async () => {
      mockGetRunningJobs.mockResolvedValue([
        createMockJob({
          id: 'job-1',
          name: 'serve-job',
          port: 8080,
          status: 'running',
        }),
      ]);

      mockGetSharedMonitor.mockReturnValue({
        getEventAccumulator: vi.fn().mockReturnValue({
          filesEdited: ['src/index.ts'],
          currentTool: 'streaming',
          currentFile: 'src/index.ts',
          lastActivityAt: Date.now(),
          eventCount: 5,
        }),
      });

      const result = await mc_overview.execute({});

      expect(result).toContain('serve-job');
      expect(result).toContain('streaming');
    });

    it('should show serve-mode jobs as idle when no current tool', async () => {
      mockGetRunningJobs.mockResolvedValue([
        createMockJob({
          id: 'job-1',
          name: 'idle-job',
          port: 8080,
          status: 'running',
        }),
      ]);

      mockGetSharedMonitor.mockReturnValue({
        getEventAccumulator: vi.fn().mockReturnValue({
          filesEdited: [],
          lastActivityAt: Date.now(),
          eventCount: 0,
        }),
      });

      const result = await mc_overview.execute({});

      expect(result).toContain('idle-job');
      expect(result).toContain('idle');
    });

    it('should show TUI-mode jobs with report info', async () => {
      mockGetRunningJobs.mockResolvedValue([
        createMockJob({
          id: 'job-1',
          name: 'tui-job',
          status: 'running',
        }),
      ]);

      mockReadAllReports.mockResolvedValue([
        {
          jobId: 'job-1',
          jobName: 'tui-job',
          status: 'working',
          message: 'Processing files',
          timestamp: new Date().toISOString(),
        },
      ]);

      const result = await mc_overview.execute({});

      expect(result).toContain('tui-job');
      expect(result).toContain('working: Processing files');
    });

    it('should show activity timestamp for serve-mode jobs', async () => {
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      mockGetRunningJobs.mockResolvedValue([
        createMockJob({
          id: 'job-1',
          name: 'active-job',
          port: 8080,
          status: 'running',
        }),
      ]);

      mockGetSharedMonitor.mockReturnValue({
        getEventAccumulator: vi.fn().mockReturnValue({
          filesEdited: ['src/test.ts'],
          currentTool: 'streaming',
          lastActivityAt: fiveMinutesAgo,
          eventCount: 10,
        }),
      });

      const result = await mc_overview.execute({});

      expect(result).toContain('active-job');
      expect(result).toContain('streaming');
    });

    it('should handle multiple running jobs with mixed modes', async () => {
      mockGetRunningJobs.mockResolvedValue([
        createMockJob({
          id: 'job-1',
          name: 'serve-job',
          port: 8080,
          status: 'running',
        }),
        createMockJob({
          id: 'job-2',
          name: 'tui-job',
          status: 'running',
        }),
      ]);

      mockGetSharedMonitor.mockReturnValue({
        getEventAccumulator: vi.fn().mockImplementation((jobId: string) => {
          if (jobId === 'job-1') {
            return {
              filesEdited: ['src/index.ts'],
              currentTool: 'streaming',
              lastActivityAt: Date.now(),
              eventCount: 5,
            };
          }
          return undefined;
        }),
      });

      mockReadAllReports.mockResolvedValue([
        {
          jobId: 'job-2',
          jobName: 'tui-job',
          status: 'working',
          message: 'Working hard',
          timestamp: new Date().toISOString(),
        },
      ]);

      const result = await mc_overview.execute({});

      expect(result).toContain('serve-job');
      expect(result).toContain('streaming');
      expect(result).toContain('tui-job');
      expect(result).toContain('working: Working hard');
    });
  });

  describe('plan status', () => {
    it('should show active plan with progress', async () => {
      mockLoadPlan.mockResolvedValue({
        id: 'plan-1',
        name: 'test-plan',
        status: 'running',
        mode: 'autopilot',
        jobs: [
          { status: 'merged' },
          { status: 'running' },
          { status: 'queued' },
        ],
        integrationBranch: 'mc/integration-plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      const result = await mc_overview.execute({});

      expect(result).toContain('Active Plan');
      expect(result).toContain('Name: test-plan');
      expect(result).toContain('Status: running');
      expect(result).toContain('Progress: 1/3 merged');
      expect(result).toContain('Mode: autopilot');
    });

    it('should show copilot mode pending plan', async () => {
      mockLoadPlan.mockResolvedValue({
        id: 'plan-1',
        name: 'pending-plan',
        status: 'pending',
        mode: 'copilot',
        jobs: [],
        integrationBranch: 'mc/integration-plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      });

      const result = await mc_overview.execute({});

      expect(result).toContain('Mode: copilot');
      expect(result).toContain('Plan is pending approval');
    });

    it('should show supervisor checkpoint', async () => {
      mockLoadPlan.mockResolvedValue({
        id: 'plan-1',
        name: 'supervised-plan',
        status: 'paused',
        mode: 'supervisor',
        jobs: [],
        integrationBranch: 'mc/integration-plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
        checkpoint: 'pre_merge',
      });

      const result = await mc_overview.execute({});

      expect(result).toContain('Plan paused at pre_merge');
    });
  });

  describe('alerts and suggested actions', () => {
    it('should show blocked job alerts', async () => {
      mockReadAllReports.mockResolvedValue([
        {
          jobId: 'job-1',
          jobName: 'blocked-job',
          status: 'blocked',
          message: 'Waiting for user input on database migration',
          timestamp: new Date().toISOString(),
        },
      ]);

      const result = await mc_overview.execute({});

      expect(result).toContain('Alerts');
      expect(result).toContain('blocked-job [blocked]:');
      expect(result).toContain('Waiting for user input');
    });

    it('should show needs_review alerts', async () => {
      mockReadAllReports.mockResolvedValue([
        {
          jobId: 'job-1',
          jobName: 'review-job',
          status: 'needs_review',
          message: 'Implementation complete, needs review',
          timestamp: new Date().toISOString(),
        },
      ]);

      const result = await mc_overview.execute({});

      expect(result).toContain('review-job [needs_review]:');
    });

    it('should suggest actions based on job states', async () => {
      mockGetRunningJobs.mockResolvedValue([
        createMockJob({ id: 'job-1', name: 'running-job', status: 'running' }),
      ]);

      mockLoadJobState.mockResolvedValue({
        version: 3,
        jobs: [
          createMockJob({ id: 'job-1', name: 'running-job', status: 'running' }),
          createMockJob({ id: 'job-2', name: 'completed-job', status: 'completed' }),
          createMockJob({ id: 'job-3', name: 'failed-job', status: 'failed' }),
        ],
        updatedAt: new Date().toISOString(),
      });

      mockReadAllReports.mockResolvedValue([
        {
          jobId: 'job-4',
          jobName: 'blocked-job',
          status: 'blocked',
          message: 'Blocked on question',
          timestamp: new Date().toISOString(),
        },
      ]);

      const result = await mc_overview.execute({});

      expect(result).toContain('Suggested Actions');
      expect(result).toContain('blocked');
      expect(result).toContain('completed');
      expect(result).toContain('failed');
      expect(result).toContain('running');
    });
  });

  describe('recent completions and failures', () => {
    it('should show recent completed jobs', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);

      mockLoadJobState.mockResolvedValue({
        version: 3,
        jobs: [
          createMockJob({
            id: 'job-1',
            name: 'completed-job',
            status: 'completed',
            completedAt: now.toISOString(),
            createdAt: oneHourAgo.toISOString(),
          }),
        ],
        updatedAt: now.toISOString(),
      });

      const result = await mc_overview.execute({});

      expect(result).toContain('Recent Completions');
      expect(result).toContain('completed-job');
    });

    it('should show recent failed jobs', async () => {
      mockLoadJobState.mockResolvedValue({
        version: 3,
        jobs: [
          createMockJob({
            id: 'job-1',
            name: 'failed-job',
            status: 'failed',
            completedAt: new Date().toISOString(),
          }),
        ],
        updatedAt: new Date().toISOString(),
      });

      const result = await mc_overview.execute({});

      expect(result).toContain('Recent Failures');
      expect(result).toContain('failed-job');
    });
  });
});
