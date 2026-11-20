import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as rpcEvents from '../../src/lib/rpc-events';

const { mc_attach, getAttachInfo } = await import('../../src/tools/attach');

let mockGetJobByName: Mock;

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'feature-auth',
    worktreePath: '/tmp/mc-worktrees/feature-auth',
    branch: 'mc/feature-auth',
    status: 'running',
    prompt: 'Add OAuth support',
    createdAt: new Date().toISOString(),
    sessionID: 'ses_auth123',
    ...overrides,
  };
}

describe('mc_attach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockResolvedValue(undefined) as unknown as Mock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_attach.description).toBe("Get instructions for opening a job's session");
    });

    it('should have required arg: name', () => {
      expect(mc_attach.input.shape.name).toBeDefined();
    });
  });

  describe('job not found', () => {
    it('should throw error when job does not exist', async () => {
      await expect(mc_attach.execute({ name: 'nonexistent' })).rejects.toThrow(
        'Job "nonexistent" not found',
      );
    });
  });

  describe('open request', () => {
    it('asks a connected TUI to open the job session tab', async () => {
      const emitOpen = vi.spyOn(rpcEvents, 'emitOpen').mockResolvedValue(undefined);
      mockGetJobByName.mockResolvedValue(makeJob());

      const result = await mc_attach.execute({ name: 'feature-auth' });

      expect(emitOpen).toHaveBeenCalledWith({ sessionID: 'ses_auth123', title: '[MC] feature-auth' });
      expect(result.content).toContain('A tab for this session was requested in the TUI.');
      // The manual instructions stay as the fallback.
      expect(result.content).toContain('opencode --session ses_auth123');
    });

    it('requests nothing for a job without a session', async () => {
      const emitOpen = vi.spyOn(rpcEvents, 'emitOpen').mockResolvedValue(undefined);
      mockGetJobByName.mockResolvedValue(makeJob({ sessionID: undefined }));

      await mc_attach.execute({ name: 'feature-auth' });

      expect(emitOpen).not.toHaveBeenCalled();
    });
  });

  describe('instructions', () => {
    it('should include the session ID and worktree path', async () => {
      mockGetJobByName.mockResolvedValue(makeJob());

      const result = await mc_attach.execute({ name: 'feature-auth' });

      expect(mockGetJobByName).toHaveBeenCalledWith('feature-auth');
      expect(result.content).toContain('To open job "feature-auth":');
      expect(result.content).toContain('Session:  ses_auth123');
      expect(result.content).toContain('Worktree: /tmp/mc-worktrees/feature-auth');
    });

    it('should explain how to open the session from the TUI session list', async () => {
      mockGetJobByName.mockResolvedValue(makeJob());

      const result = await mc_attach.execute({ name: 'feature-auth' });

      expect(result.content).toContain('Ctrl+X then L');
      expect(result.content).toContain('/sessions');
      expect(result.content).toContain('[MC] feature-auth');
    });

    it('should give the shell command to open the session in the worktree', async () => {
      mockGetJobByName.mockResolvedValue(makeJob());

      const result = await mc_attach.execute({ name: 'feature-auth' });

      expect(result.content).toContain(
        'cd /tmp/mc-worktrees/feature-auth && opencode --session ses_auth123',
      );
    });

    it('should work for finished jobs', async () => {
      mockGetJobByName.mockResolvedValue(makeJob({ status: 'completed' }));

      const result = await mc_attach.execute({ name: 'feature-auth' });

      expect(result.content).toContain('opencode --session ses_auth123');
    });

    it('should say so when the job has no session', async () => {
      mockGetJobByName.mockResolvedValue(makeJob({ sessionID: undefined, status: 'stopped' }));

      const result = await mc_attach.execute({ name: 'feature-auth' });

      expect(result.content).toContain('Job "feature-auth" has no session to open');
      expect(result.content).toContain('Worktree: /tmp/mc-worktrees/feature-auth');
      expect(result.content).not.toContain('opencode --session');
    });
  });

  describe('getAttachInfo', () => {
    it('should return the session, worktree and session title', () => {
      expect(getAttachInfo(makeJob())).toEqual({
        sessionID: 'ses_auth123',
        worktreePath: '/tmp/mc-worktrees/feature-auth',
        title: '[MC] feature-auth',
      });
    });

    it('should return undefined for a job without a session', () => {
      expect(getAttachInfo(makeJob({ sessionID: undefined }))).toBeUndefined();
    });
  });
});
