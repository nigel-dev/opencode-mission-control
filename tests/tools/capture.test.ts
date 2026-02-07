import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as tmux from '../../src/lib/tmux';

const { mc_capture } = await import('../../src/tools/capture');

let mockGetJobByName: Mock;
let mockCapturePane: Mock;

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
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockImplementation(() => undefined as any);
    mockCapturePane = vi.spyOn(tmux, 'capturePane').mockImplementation(() => '' as any);
    setupDefaultMocks();
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_capture.description).toBe('Capture current terminal output from a job');
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
});
