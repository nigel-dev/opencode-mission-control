import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';

vi.mock('../../src/lib/job-state', () => ({
  getJobByName: vi.fn(),
  addJob: vi.fn(),
}));

vi.mock('../../src/lib/worktree', () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock('../../src/lib/tmux', () => ({
  createSession: vi.fn(),
  createWindow: vi.fn(),
  setPaneDiedHook: vi.fn(),
  sendKeys: vi.fn(),
  killSession: vi.fn(),
  getCurrentSession: vi.fn(),
  isInsideTmux: vi.fn(),
}));

vi.mock('../../src/lib/config', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234'),
}));

const jobState = await import('../../src/lib/job-state');
const worktree = await import('../../src/lib/worktree');
const tmux = await import('../../src/lib/tmux');
const configMod = await import('../../src/lib/config');

const mockGetJobByName = jobState.getJobByName as Mock;
const mockAddJob = jobState.addJob as Mock;
const mockCreateWorktree = worktree.createWorktree as Mock;
const mockRemoveWorktree = worktree.removeWorktree as Mock;
const mockCreateSession = tmux.createSession as Mock;
const mockCreateWindow = tmux.createWindow as Mock;
const mockSetPaneDiedHook = tmux.setPaneDiedHook as Mock;
const mockSendKeys = tmux.sendKeys as Mock;
const mockKillSession = tmux.killSession as Mock;
const mockGetCurrentSession = tmux.getCurrentSession as Mock;
const mockIsInsideTmux = tmux.isInsideTmux as Mock;
const mockLoadConfig = configMod.loadConfig as Mock;

const { mc_launch } = await import('../../src/tools/launch');

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

function setupDefaultMocks() {
  mockGetJobByName.mockResolvedValue(undefined);
  mockLoadConfig.mockResolvedValue({
    defaultPlacement: 'session',
    pollInterval: 10000,
    idleThreshold: 300000,
    worktreeBasePath: '/tmp/mc-worktrees',
    omo: { enabled: false, defaultMode: 'vanilla' },
  });
  mockCreateWorktree.mockResolvedValue('/tmp/mc-worktrees/test-job');
  mockCreateSession.mockResolvedValue(undefined);
  mockCreateWindow.mockResolvedValue(undefined);
  mockSetPaneDiedHook.mockResolvedValue(undefined);
  mockSendKeys.mockResolvedValue(undefined);
  mockAddJob.mockResolvedValue(undefined);
  mockKillSession.mockResolvedValue(undefined);
  mockRemoveWorktree.mockResolvedValue(undefined);
  mockGetCurrentSession.mockReturnValue('main-session');
  mockIsInsideTmux.mockReturnValue(true);
}

describe('mc_launch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_launch.description).toBe(
        'Launch a new parallel AI coding session in an isolated worktree',
      );
    });

    it('should have required args: name and prompt', () => {
      expect(mc_launch.args.name).toBeDefined();
      expect(mc_launch.args.prompt).toBeDefined();
    });

    it('should have optional args: branch, placement, mode, planFile', () => {
      expect(mc_launch.args.branch).toBeDefined();
      expect(mc_launch.args.placement).toBeDefined();
      expect(mc_launch.args.mode).toBeDefined();
      expect(mc_launch.args.planFile).toBeDefined();
    });
  });

  describe('name uniqueness validation', () => {
    it('should reject duplicate job names', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'existing',
        name: 'my-job',
        status: 'running',
      } as Job);

      await expect(
        mc_launch.execute(
          { name: 'my-job', prompt: 'Do something' },
          mockContext,
        ),
      ).rejects.toThrow('Job "my-job" already exists');
    });

    it('should include existing job status in error message', async () => {
      mockGetJobByName.mockResolvedValue({
        id: 'existing',
        name: 'my-job',
        status: 'completed',
      } as Job);

      await expect(
        mc_launch.execute(
          { name: 'my-job', prompt: 'Do something' },
          mockContext,
        ),
      ).rejects.toThrow('status: completed');
    });
  });

  describe('successful session launch', () => {
    it('should create worktree with default branch name mc/{name}', async () => {
      await mc_launch.execute(
        { name: 'feature-auth', prompt: 'Add auth' },
        mockContext,
      );

      expect(mockCreateWorktree).toHaveBeenCalledWith({
        branch: 'mc/feature-auth',
      });
    });

    it('should use custom branch name when provided', async () => {
      await mc_launch.execute(
        {
          name: 'feature-auth',
          prompt: 'Add auth',
          branch: 'custom/branch',
        },
        mockContext,
      );

      expect(mockCreateWorktree).toHaveBeenCalledWith({
        branch: 'custom/branch',
      });
    });

    it('should create tmux session for session placement', async () => {
      await mc_launch.execute(
        { name: 'feature-auth', prompt: 'Add auth' },
        mockContext,
      );

      expect(mockCreateSession).toHaveBeenCalledWith({
        name: 'mc-feature-auth',
        workdir: '/tmp/mc-worktrees/test-job',
      });
      expect(mockCreateWindow).not.toHaveBeenCalled();
    });

    it('should create tmux window for window placement', async () => {
      mockGetCurrentSession.mockReturnValue('my-session');
      mockIsInsideTmux.mockReturnValue(true);

      await mc_launch.execute(
        {
          name: 'feature-auth',
          prompt: 'Add auth',
          placement: 'window',
        },
        mockContext,
      );

      expect(mockCreateWindow).toHaveBeenCalledWith({
        session: 'my-session',
        name: 'feature-auth',
        workdir: '/tmp/mc-worktrees/test-job',
      });
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it('should set up pane-died hook', async () => {
      await mc_launch.execute(
        { name: 'feature-auth', prompt: 'Add auth' },
        mockContext,
      );

      expect(mockSetPaneDiedHook).toHaveBeenCalledWith(
        'mc-feature-auth',
        expect.stringContaining('test-uuid-1234'),
      );
    });

    it('should send launch command to tmux pane', async () => {
      await mc_launch.execute(
        { name: 'feature-auth', prompt: 'Add auth' },
        mockContext,
      );

      expect(mockSendKeys).toHaveBeenCalledWith(
        'mc-feature-auth',
        expect.stringContaining('opencode'),
      );
      expect(mockSendKeys).toHaveBeenCalledWith('mc-feature-auth', 'Enter');
    });

    it('should add job to state', async () => {
      await mc_launch.execute(
        { name: 'feature-auth', prompt: 'Add auth' },
        mockContext,
      );

      expect(mockAddJob).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-uuid-1234',
          name: 'feature-auth',
          branch: 'mc/feature-auth',
          tmuxTarget: 'mc-feature-auth',
          placement: 'session',
          status: 'running',
          prompt: 'Add auth',
          mode: 'vanilla',
        }),
      );
    });

    it('should return job info string', async () => {
      const result = await mc_launch.execute(
        { name: 'feature-auth', prompt: 'Add auth' },
        mockContext,
      );

      expect(result).toContain('Job "feature-auth" launched successfully');
      expect(result).toContain('test-uuid-1234');
      expect(result).toContain('mc/feature-auth');
      expect(result).toContain('mc-feature-auth');
      expect(result).toContain('tmux attach -t mc-feature-auth');
    });

    it('should return window switch instructions for window placement', async () => {
      mockGetCurrentSession.mockReturnValue('my-session');

      const result = await mc_launch.execute(
        {
          name: 'feature-auth',
          prompt: 'Add auth',
          placement: 'window',
        },
        mockContext,
      );

      expect(result).toContain('tmux select-window');
    });
  });

  describe('mode handling', () => {
    it('should use vanilla mode by default', async () => {
      await mc_launch.execute(
        { name: 'test', prompt: 'Do stuff' },
        mockContext,
      );

      expect(mockAddJob).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'vanilla' }),
      );
    });

    it('should send ralph-loop command for ralph mode', async () => {
      await mc_launch.execute(
        { name: 'test', prompt: 'Do stuff', mode: 'ralph' },
        mockContext,
      );

      expect(mockSendKeys).toHaveBeenCalledWith(
        'mc-test',
        expect.stringContaining('/ralph-loop'),
      );
    });

    it('should send ulw-loop command for ulw mode', async () => {
      await mc_launch.execute(
        { name: 'test', prompt: 'Do stuff', mode: 'ulw' },
        mockContext,
      );

      expect(mockSendKeys).toHaveBeenCalledWith(
        'mc-test',
        expect.stringContaining('/ulw-loop'),
      );
    });

    it('should include plan file reference for plan mode', async () => {
      await mc_launch.execute(
        {
          name: 'test',
          prompt: 'Do stuff',
          mode: 'plan',
          planFile: 'my-plan.md',
        },
        mockContext,
      );

      expect(mockSendKeys).toHaveBeenCalledWith(
        'mc-test',
        expect.stringContaining('my-plan.md'),
      );
    });

    it('should store planFile in job state', async () => {
      await mc_launch.execute(
        {
          name: 'test',
          prompt: 'Do stuff',
          mode: 'plan',
          planFile: 'plan.md',
        },
        mockContext,
      );

      expect(mockAddJob).toHaveBeenCalledWith(
        expect.objectContaining({ planFile: 'plan.md' }),
      );
    });
  });

  describe('config defaults', () => {
    it('should use config defaultPlacement when placement not specified', async () => {
      mockLoadConfig.mockResolvedValue({
        defaultPlacement: 'window',
        pollInterval: 10000,
        idleThreshold: 300000,
        worktreeBasePath: '/tmp/mc-worktrees',
        omo: { enabled: false, defaultMode: 'vanilla' },
      });

      await mc_launch.execute(
        { name: 'test', prompt: 'Do stuff' },
        mockContext,
      );

      expect(mockCreateWindow).toHaveBeenCalled();
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it('should use config defaultMode when mode not specified', async () => {
      mockLoadConfig.mockResolvedValue({
        defaultPlacement: 'session',
        pollInterval: 10000,
        idleThreshold: 300000,
        worktreeBasePath: '/tmp/mc-worktrees',
        omo: { enabled: true, defaultMode: 'ralph' },
      });

      await mc_launch.execute(
        { name: 'test', prompt: 'Do stuff' },
        mockContext,
      );

      expect(mockAddJob).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'ralph' }),
      );
    });
  });

  describe('name sanitization', () => {
    it('should sanitize special characters in tmux session name', async () => {
      await mc_launch.execute(
        { name: 'my job/test', prompt: 'Do stuff' },
        mockContext,
      );

      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'mc-my-job-test' }),
      );
    });
  });

  describe('window placement validation', () => {
    it('should throw when window placement used outside tmux', async () => {
      mockGetCurrentSession.mockReturnValue(undefined);
      mockIsInsideTmux.mockReturnValue(false);

      await expect(
        mc_launch.execute(
          { name: 'test', prompt: 'stuff', placement: 'window' },
          mockContext,
        ),
      ).rejects.toThrow(
        'Window placement requires being inside a tmux session',
      );
    });
  });

  describe('error handling and cleanup', () => {
    it('should throw clear error when worktree creation fails', async () => {
      mockCreateWorktree.mockRejectedValue(
        new Error('branch already has worktree'),
      );

      await expect(
        mc_launch.execute({ name: 'test', prompt: 'stuff' }, mockContext),
      ).rejects.toThrow('Failed to create worktree');
    });

    it('should cleanup worktree when tmux session creation fails', async () => {
      mockCreateSession.mockRejectedValue(new Error('tmux not found'));

      await expect(
        mc_launch.execute({ name: 'test', prompt: 'stuff' }, mockContext),
      ).rejects.toThrow('Failed to create tmux session');

      expect(mockRemoveWorktree).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job',
        true,
      );
    });

    it('should cleanup tmux and worktree when sendKeys fails', async () => {
      mockSendKeys.mockRejectedValue(new Error('pane not found'));

      await expect(
        mc_launch.execute({ name: 'test', prompt: 'stuff' }, mockContext),
      ).rejects.toThrow('Failed to send launch command');

      expect(mockKillSession).toHaveBeenCalledWith('mc-test');
      expect(mockRemoveWorktree).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job',
        true,
      );
    });

    it('should not fail if pane-died hook setup fails', async () => {
      mockSetPaneDiedHook.mockRejectedValue(new Error('hook setup failed'));

      const result = await mc_launch.execute(
        { name: 'test', prompt: 'Do stuff' },
        mockContext,
      );

      expect(result).toContain('Job "test" launched successfully');
    });

    it('should not fail if cleanup itself fails', async () => {
      mockCreateSession.mockRejectedValue(new Error('tmux error'));
      mockRemoveWorktree.mockRejectedValue(new Error('cleanup failed too'));

      await expect(
        mc_launch.execute({ name: 'test', prompt: 'stuff' }, mockContext),
      ).rejects.toThrow('Failed to create tmux session');
    });
  });

  describe('does not wait for completion', () => {
    it('should return immediately with running status', async () => {
      const result = await mc_launch.execute(
        { name: 'test', prompt: 'long task' },
        mockContext,
      );

      expect(result).toContain('launched successfully');
      expect(mockAddJob).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'running' }),
      );
    });
  });
});
