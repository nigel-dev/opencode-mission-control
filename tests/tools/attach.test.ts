import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as tmux from '../../src/lib/tmux';

const { mc_attach } = await import('../../src/tools/attach');

let mockGetJobByName: Mock;
let mockCreateWindow: Mock;
let mockIsInsideTmux: Mock;
let mockGetCurrentSession: Mock;

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
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockImplementation(() => undefined as any);
    mockCreateWindow = vi.spyOn(tmux, 'createWindow').mockImplementation(() => undefined as any);
    mockIsInsideTmux = vi.spyOn(tmux, 'isInsideTmux').mockReturnValue(false);
    mockGetCurrentSession = vi.spyOn(tmux, 'getCurrentSession').mockReturnValue('main-session');
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

  describe('serve-mode job inside tmux', () => {
    it('should create new tmux window and return success message', async () => {
      mockIsInsideTmux.mockReturnValue(true);
      mockCreateWindow.mockResolvedValue(undefined);

      const job: Job = {
        id: 'job-serve',
        name: 'serve-job',
        worktreePath: '/tmp/mc-worktrees/serve-job',
        branch: 'mc/serve-job',
        tmuxTarget: 'mc-serve-job',
        placement: 'session',
        status: 'running',
        prompt: 'Run server',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
        port: 8080,
        serverUrl: 'http://localhost:8080',
      };

      mockGetJobByName.mockResolvedValue(job);

      const result = await mc_attach.execute({ name: 'serve-job' }, mockContext);

      expect(mockCreateWindow).toHaveBeenCalledWith({
        session: 'main-session',
        name: 'mc-serve-job',
        workdir: '/tmp/mc-worktrees/serve-job',
        command: 'opencode attach http://localhost:8080 --dir /tmp/mc-worktrees/serve-job',
      });
      expect(result).toBe("Opened TUI for job 'serve-job' in new tmux window");
    });
  });

  describe('serve-mode job inside tmux but no current session', () => {
    it('should return command when current session cannot be determined', async () => {
      mockIsInsideTmux.mockReturnValue(true);
      mockGetCurrentSession.mockReturnValue(undefined);

      const job: Job = {
        id: 'job-serve',
        name: 'serve-job',
        worktreePath: '/tmp/mc-worktrees/serve-job',
        branch: 'mc/serve-job',
        tmuxTarget: 'mc-serve-job',
        placement: 'session',
        status: 'running',
        prompt: 'Run server',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
        port: 8080,
        serverUrl: 'http://localhost:8080',
      };

      mockGetJobByName.mockResolvedValue(job);

      const result = await mc_attach.execute({ name: 'serve-job' }, mockContext);

      expect(mockCreateWindow).not.toHaveBeenCalled();
      expect(result).toBe('Run: opencode attach http://localhost:8080');
    });
  });

  describe('serve-mode job outside tmux', () => {
    it('should return command to run when not inside tmux', async () => {
      mockIsInsideTmux.mockReturnValue(false);

      const job: Job = {
        id: 'job-serve',
        name: 'serve-job',
        worktreePath: '/tmp/mc-worktrees/serve-job',
        branch: 'mc/serve-job',
        tmuxTarget: 'mc-serve-job',
        placement: 'session',
        status: 'running',
        prompt: 'Run server',
        mode: 'vanilla',
        createdAt: new Date().toISOString(),
        port: 8080,
        serverUrl: 'http://localhost:8080',
      };

      mockGetJobByName.mockResolvedValue(job);

      const result = await mc_attach.execute({ name: 'serve-job' }, mockContext);

      expect(mockCreateWindow).not.toHaveBeenCalled();
      expect(result).toBe('Run: opencode attach http://localhost:8080');
    });
  });
});
