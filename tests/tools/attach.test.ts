import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';

vi.mock('../../src/lib/job-state', () => ({
  getJobByName: vi.fn(),
}));

const jobState = await import('../../src/lib/job-state');
const mockGetJobByName = jobState.getJobByName as Mock;

const { mc_attach } = await import('../../src/tools/attach');

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

describe('mc_attach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_attach.description).toBe(
        'Get instructions for attaching to a job\'s terminal',
      );
    });

    it('should have name arg', () => {
      expect(mc_attach.args.name).toBeDefined();
    });
  });

  describe('job not found', () => {
    it('should throw error when job does not exist', async () => {
      mockGetJobByName.mockResolvedValue(undefined);

      await expect(
        mc_attach.execute({ name: 'nonexistent' }, mockContext),
      ).rejects.toThrow('Job "nonexistent" not found');
    });
  });

  describe('session placement', () => {
    it('should return attach command for session placement', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        worktreePath: '/tmp/mc-worktrees/feature-auth',
        branch: 'mc/feature-auth',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Implement authentication',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      const result = await mc_attach.execute({ name: 'feature-auth' }, mockContext);

      expect(result).toContain('To attach to job "feature-auth":');
      expect(result).toContain('# Session mode:');
      expect(result).toContain('tmux attach -t mc-feature-auth');
      expect(result).toContain('# To detach: Ctrl+B, D');
    });
  });

  describe('window placement', () => {
    it('should return select-window command for window placement', async () => {
      const job: Job = {
        id: 'job-2',
        name: 'feature-api',
        worktreePath: '/tmp/mc-worktrees/feature-api',
        branch: 'mc/feature-api',
        tmuxTarget: 'main-session:feature-api',
        placement: 'window',
        status: 'running',
        prompt: 'Build API endpoints',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      const result = await mc_attach.execute({ name: 'feature-api' }, mockContext);

      expect(result).toContain('To attach to job "feature-api":');
      expect(result).toContain('# Window mode (select window in current session):');
      expect(result).toContain('tmux select-window -t main-session:feature-api');
      expect(result).toContain('# To detach: Ctrl+B, D');
    });
  });

  describe('detach instructions', () => {
    it('should include detach instructions for both placement types', async () => {
      const jobSession: Job = {
        id: 'job-1',
        name: 'test-session',
        worktreePath: '/tmp/mc-worktrees/test-session',
        branch: 'mc/test-session',
        tmuxTarget: 'mc-test-session',
        placement: 'session',
        status: 'running',
        prompt: 'Test',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(jobSession);
      const resultSession = await mc_attach.execute({ name: 'test-session' }, mockContext);
      expect(resultSession).toContain('# To detach: Ctrl+B, D');

      const jobWindow: Job = {
        id: 'job-2',
        name: 'test-window',
        worktreePath: '/tmp/mc-worktrees/test-window',
        branch: 'mc/test-window',
        tmuxTarget: 'main:test-window',
        placement: 'window',
        status: 'running',
        prompt: 'Test',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(jobWindow);
      const resultWindow = await mc_attach.execute({ name: 'test-window' }, mockContext);
      expect(resultWindow).toContain('# To detach: Ctrl+B, D');
    });
  });
});
