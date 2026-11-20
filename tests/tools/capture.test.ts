import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as jobRuntime from '../../src/lib/job-runtime';
import * as orchestratorSingleton from '../../src/lib/orchestrator-singleton';

const { mc_capture } = await import('../../src/tools/capture');

let mockGetJobByName: Mock;
let mockCaptureJobSession: Mock;
let mockGetEventAccumulator: Mock;

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'test-job-id',
    name: 'test-job',
    worktreePath: '/tmp/mc-worktrees/test-job',
    branch: 'mc/test-job',
    status: 'running',
    prompt: 'Test prompt',
    createdAt: new Date().toISOString(),
    sessionID: 'ses_capture',
    ...overrides,
  };
}

describe('mc_capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockResolvedValue(makeJob()) as unknown as Mock;
    mockCaptureJobSession = vi
      .spyOn(jobRuntime, 'captureJobSession')
      .mockResolvedValue('test output\nline 2\nline 3') as unknown as Mock;
    mockGetEventAccumulator = vi.fn().mockReturnValue(undefined);
    vi.spyOn(orchestratorSingleton, 'getSharedMonitor').mockReturnValue({
      getEventAccumulator: mockGetEventAccumulator,
    } as unknown as ReturnType<typeof orchestratorSingleton.getSharedMonitor>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tool definition', () => {
    it('should describe transcript capture', () => {
      expect(mc_capture.description).toBe(
        'Capture the recent transcript of a job, or structured activity events with a filter',
      );
    });

    it('should have required arg: name', () => {
      expect(mc_capture.input.shape.name).toBeDefined();
    });

    it('should accept a call with only a name', () => {
      expect(mc_capture.input.safeParse({ name: 'test-job' }).success).toBe(true);
    });

    it('should accept lines and filter', () => {
      expect(mc_capture.input.safeParse({ name: 'test-job', lines: 20 }).success).toBe(true);
      expect(mc_capture.input.safeParse({ name: 'test-job', filter: 'tool' }).success).toBe(true);
      expect(mc_capture.input.safeParse({ name: 'test-job', filter: 'bogus' }).success).toBe(false);
    });
  });

  describe('transcript capture', () => {
    it('should find job by name', async () => {
      await mc_capture.execute({ name: 'test-job' });

      expect(mockGetJobByName).toHaveBeenCalledWith('test-job');
    });

    it("should capture the job's session with a default of 100 lines", async () => {
      await mc_capture.execute({ name: 'test-job' });

      expect(mockCaptureJobSession).toHaveBeenCalledWith('ses_capture', 100);
    });

    it('should use the requested line count', async () => {
      await mc_capture.execute({ name: 'test-job', lines: 50 });

      expect(mockCaptureJobSession).toHaveBeenCalledWith('ses_capture', 50);
    });

    it('should return the transcript unchanged', async () => {
      const result = await mc_capture.execute({ name: 'test-job' });

      expect(result.content).toBe('test output\nline 2\nline 3');
    });

    it('should capture finished jobs too', async () => {
      mockGetJobByName.mockResolvedValue(makeJob({ status: 'completed', sessionID: 'ses_done' }));

      await mc_capture.execute({ name: 'test-job' });

      expect(mockCaptureJobSession).toHaveBeenCalledWith('ses_done', 100);
    });
  });

  describe('error handling', () => {
    it('should throw error when job not found', async () => {
      mockGetJobByName.mockResolvedValue(undefined);

      await expect(mc_capture.execute({ name: 'nonexistent' })).rejects.toThrow(
        'Job "nonexistent" not found',
      );
      expect(mockCaptureJobSession).not.toHaveBeenCalled();
    });

    it('should throw a clear error for a job without a session', async () => {
      mockGetJobByName.mockResolvedValue(makeJob({ sessionID: undefined }));

      await expect(mc_capture.execute({ name: 'test-job' })).rejects.toThrow(
        'Job "test-job" has no session to capture',
      );
      expect(mockCaptureJobSession).not.toHaveBeenCalled();
    });

    it('should propagate runtime errors', async () => {
      mockCaptureJobSession.mockRejectedValue(new Error('session not found'));

      await expect(mc_capture.execute({ name: 'test-job' })).rejects.toThrow('session not found');
    });
  });

  describe('structured events (filter)', () => {
    const accumulator = {
      filesEdited: ['/tmp/a.ts', '/tmp/b.ts'],
      currentTool: 'streaming',
      currentFile: '/tmp/b.ts',
      lastActivityAt: Date.UTC(2026, 0, 1),
      eventCount: 7,
    };

    it('should not read the transcript when a filter is given', async () => {
      mockGetEventAccumulator.mockReturnValue(accumulator);

      await mc_capture.execute({ name: 'test-job', filter: 'all' });

      expect(mockCaptureJobSession).not.toHaveBeenCalled();
      expect(mockGetEventAccumulator).toHaveBeenCalledWith('test-job-id');
    });

    it('should return an empty event list when nothing was accumulated', async () => {
      const result = await mc_capture.execute({ name: 'test-job', filter: 'all' });
      const parsed = JSON.parse(result.content);

      expect(parsed).toEqual({
        job: 'test-job',
        status: 'running',
        events: [],
        message: 'No events accumulated yet',
      });
    });

    it('should return file and tool events for filter "all"', async () => {
      mockGetEventAccumulator.mockReturnValue(accumulator);

      const result = await mc_capture.execute({ name: 'test-job', filter: 'all' });
      const parsed = JSON.parse(result.content);

      expect(parsed.job).toBe('test-job');
      expect(parsed.filter).toBe('all');
      expect(parsed.summary).toEqual({
        totalEvents: 7,
        filesEdited: 2,
        currentTool: 'streaming',
        currentFile: '/tmp/b.ts',
        lastActivityAt: '2026-01-01T00:00:00.000Z',
      });
      expect(parsed.events).toEqual([
        { type: 'file.edited', timestamp: '2026-01-01T00:00:00.000Z', payload: { path: '/tmp/a.ts' } },
        { type: 'file.edited', timestamp: '2026-01-01T00:00:00.000Z', payload: { path: '/tmp/b.ts' } },
        {
          type: 'tool',
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { tool: 'streaming', file: '/tmp/b.ts' },
        },
      ]);
    });

    it('should return only file events for filter "file.edited"', async () => {
      mockGetEventAccumulator.mockReturnValue(accumulator);

      const result = await mc_capture.execute({ name: 'test-job', filter: 'file.edited' });
      const parsed = JSON.parse(result.content);

      expect(parsed.events).toHaveLength(2);
      expect(parsed.events.every((event: { type: string }) => event.type === 'file.edited')).toBe(true);
    });

    it('should return only the tool event for filter "tool"', async () => {
      mockGetEventAccumulator.mockReturnValue(accumulator);

      const result = await mc_capture.execute({ name: 'test-job', filter: 'tool' });
      const parsed = JSON.parse(result.content);

      expect(parsed.events).toEqual([
        {
          type: 'tool',
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { tool: 'streaming', file: '/tmp/b.ts' },
        },
      ]);
    });

    it('should work for a job without a session', async () => {
      mockGetJobByName.mockResolvedValue(makeJob({ sessionID: undefined }));
      mockGetEventAccumulator.mockReturnValue(accumulator);

      const result = await mc_capture.execute({ name: 'test-job', filter: 'all' });

      expect(JSON.parse(result.content).summary.totalEvents).toBe(7);
    });
  });
});
