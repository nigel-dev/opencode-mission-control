import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as tmux from '../../src/lib/tmux';
import * as orchestratorSingleton from '../../src/lib/orchestrator-singleton';

const { mc_capture } = await import('../../src/tools/capture');

let mockGetJobByName: Mock;
let mockCapturePane: Mock;
let mockGetSharedMonitor: Mock;

function setupDefaultMocks() {
  mockGetJobByName.mockResolvedValue({
    id: 'test-job-id',
    name: 'test-job',
    tmuxTarget: 'mc-test-job',
    status: 'running',
  } as Job);
  mockCapturePane.mockResolvedValue('test output\nline 2\nline 3');
}

describe('mc_capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockImplementation(() => undefined as any) as unknown as Mock;
    mockCapturePane = vi.spyOn(tmux, 'capturePane').mockImplementation(() => '' as any) as unknown as Mock;
    mockGetSharedMonitor = vi.spyOn(orchestratorSingleton, 'getSharedMonitor').mockReturnValue({
      getEventAccumulator: vi.fn().mockReturnValue(undefined),
    } as any) as unknown as Mock;
    setupDefaultMocks();
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_capture.description).toBe('Capture current terminal output or structured events from a job');
    });

    it('should have required arg: name', () => {
      expect(mc_capture.args.name).toBeDefined();
    });

    it('should have optional arg: lines', () => {
      expect(mc_capture.args.lines).toBeDefined();
    });
  });

  describe('successful capture', () => {
    it('should find job by name', async () => {
      await mc_capture.execute({ name: 'test-job' });

      expect(mockGetJobByName).toHaveBeenCalledWith('test-job');
    });

    it('should use default line count of 100', async () => {
      await mc_capture.execute({ name: 'test-job' });

      expect(mockCapturePane).toHaveBeenCalledWith('mc-test-job', 100);
    });

    it('should use custom line count when provided', async () => {
      await mc_capture.execute({ name: 'test-job', lines: 50 });

      expect(mockCapturePane).toHaveBeenCalledWith('mc-test-job', 50);
    });

    it('should return captured text', async () => {
      const result = await mc_capture.execute({ name: 'test-job' });

      expect(result).toBe('test output\nline 2\nline 3');
    });

    it('should use job tmuxTarget for capture', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'job-id',
        name: 'my-job',
        tmuxTarget: 'custom-tmux-target',
        status: 'running',
      } as Job);

      await mc_capture.execute({ name: 'my-job' });

      expect(mockCapturePane).toHaveBeenCalledWith('custom-tmux-target', 100);
    });
  });

  describe('error handling', () => {
    it('should throw when job not found', async () => {
      mockGetJobByName.mockResolvedValue(undefined);

      await expect(mc_capture.execute({ name: 'nonexistent' })).rejects.toThrow(
        'Job "nonexistent" not found',
      );
    });

    it('should throw when capturePane fails', async () => {
      mockCapturePane.mockRejectedValue(new Error('tmux error'));

      await expect(mc_capture.execute({ name: 'test-job' })).rejects.toThrow('tmux error');
    });
  });

  describe('line count handling', () => {
    it('should handle zero lines', async () => {
      await mc_capture.execute({ name: 'test-job', lines: 0 });

      expect(mockCapturePane).toHaveBeenCalledWith('mc-test-job', 0);
    });

    it('should handle large line counts', async () => {
      await mc_capture.execute({ name: 'test-job', lines: 10000 });

      expect(mockCapturePane).toHaveBeenCalledWith('mc-test-job', 10000);
    });
  });

  describe('serve-mode structured capture', () => {
    it('should return structured JSON for serve-mode jobs', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'serve-job-id',
        name: 'serve-job',
        tmuxTarget: 'mc-serve-job',
        status: 'running',
        port: 8080,
      } as Job);

      mockGetSharedMonitor.mockReturnValue({
        getEventAccumulator: vi.fn().mockReturnValue({
          filesEdited: ['src/index.ts', 'src/utils.ts'],
          currentTool: 'streaming',
          currentFile: 'src/index.ts',
          lastActivityAt: Date.now(),
          eventCount: 42,
        }),
      });

      const result = await mc_capture.execute({ name: 'serve-job' });
      const parsed = JSON.parse(result);

      expect(parsed.job).toBe('serve-job');
      expect(parsed.mode).toBe('serve');
      expect(parsed.status).toBe('running');
      expect(parsed.filter).toBe('all');
      expect(parsed.summary.filesEdited).toBe(2);
      expect(parsed.summary.totalEvents).toBe(42);
      expect(parsed.summary.currentTool).toBe('streaming');
      expect(parsed.events).toHaveLength(3);
    });

    it('should filter events with filter="file.edited"', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'serve-job-id',
        name: 'serve-job',
        tmuxTarget: 'mc-serve-job',
        status: 'running',
        port: 8080,
      } as Job);

      mockGetSharedMonitor.mockReturnValue({
        getEventAccumulator: vi.fn().mockReturnValue({
          filesEdited: ['src/index.ts', 'src/utils.ts'],
          currentTool: 'streaming',
          currentFile: 'src/index.ts',
          lastActivityAt: Date.now(),
          eventCount: 42,
        }),
      });

      const result = await mc_capture.execute({ name: 'serve-job', filter: 'file.edited' });
      const parsed = JSON.parse(result);

      expect(parsed.filter).toBe('file.edited');
      expect(parsed.events).toHaveLength(2);
      expect(parsed.events.every((e: any) => e.type === 'file.edited')).toBe(true);
    });

    it('should filter events with filter="tool"', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'serve-job-id',
        name: 'serve-job',
        tmuxTarget: 'mc-serve-job',
        status: 'running',
        port: 8080,
      } as Job);

      mockGetSharedMonitor.mockReturnValue({
        getEventAccumulator: vi.fn().mockReturnValue({
          filesEdited: ['src/index.ts'],
          currentTool: 'streaming',
          currentFile: 'src/index.ts',
          lastActivityAt: Date.now(),
          eventCount: 5,
        }),
      });

      const result = await mc_capture.execute({ name: 'serve-job', filter: 'tool' });
      const parsed = JSON.parse(result);

      expect(parsed.filter).toBe('tool');
      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0].type).toBe('tool');
      expect(parsed.events[0].payload.tool).toBe('streaming');
    });

    it('should return empty events when filter does not match', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'serve-job-id',
        name: 'serve-job',
        tmuxTarget: 'mc-serve-job',
        status: 'running',
        port: 8080,
      } as Job);

      mockGetSharedMonitor.mockReturnValue({
        getEventAccumulator: vi.fn().mockReturnValue({
          filesEdited: [],
          currentTool: 'streaming',
          lastActivityAt: Date.now(),
          eventCount: 5,
        }),
      });

      const result = await mc_capture.execute({ name: 'serve-job', filter: 'file.edited' });
      const parsed = JSON.parse(result);

      expect(parsed.filter).toBe('file.edited');
      expect(parsed.events).toHaveLength(0);
    });

    it('should handle serve-mode job with no accumulator data', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'serve-job-id',
        name: 'serve-job',
        tmuxTarget: 'mc-serve-job',
        status: 'running',
        port: 8080,
      } as Job);

      mockGetSharedMonitor.mockReturnValue({
        getEventAccumulator: vi.fn().mockReturnValue(undefined),
      });

      const result = await mc_capture.execute({ name: 'serve-job' });
      const parsed = JSON.parse(result);

      expect(parsed.job).toBe('serve-job');
      expect(parsed.mode).toBe('serve');
      expect(parsed.events).toEqual([]);
      expect(parsed.message).toBe('No events accumulated yet');
    });

    it('should return raw terminal output for TUI-mode jobs', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'tui-job-id',
        name: 'tui-job',
        tmuxTarget: 'mc-tui-job',
        status: 'running',
      } as Job);

      const result = await mc_capture.execute({ name: 'tui-job' });

      expect(result).toBe('test output\nline 2\nline 3');
      expect(mockCapturePane).toHaveBeenCalledWith('mc-tui-job', 100);
    });

    it('should ignore filter parameter for TUI-mode jobs', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'tui-job-id',
        name: 'tui-job',
        tmuxTarget: 'mc-tui-job',
        status: 'running',
      } as Job);

      const result = await mc_capture.execute({ name: 'tui-job', filter: 'file.edited' });

      expect(result).toBe('test output\nline 2\nline 3');
      expect(mockCapturePane).toHaveBeenCalledWith('mc-tui-job', 100);
    });

    it('should have filter arg in tool schema', () => {
      expect(mc_capture.args.filter).toBeDefined();
    });

    it('should use default filter "all" when not specified', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'serve-job-id',
        name: 'serve-job',
        tmuxTarget: 'mc-serve-job',
        status: 'running',
        port: 8080,
      } as Job);

      mockGetSharedMonitor.mockReturnValue({
        getEventAccumulator: vi.fn().mockReturnValue({
          filesEdited: ['src/index.ts'],
          currentTool: 'streaming',
          lastActivityAt: Date.now(),
          eventCount: 2,
        }),
      });

      const result = await mc_capture.execute({ name: 'serve-job' });
      const parsed = JSON.parse(result);

      expect(parsed.filter).toBe('all');
    });
  });
});
