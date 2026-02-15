import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as worktree from '../../src/lib/worktree';
import * as tmux from '../../src/lib/tmux';
import * as configMod from '../../src/lib/config';
import * as promptFile from '../../src/lib/prompt-file';
import * as worktreeSetup from '../../src/lib/worktree-setup';
import * as omo from '../../src/lib/omo';
import * as planCopier from '../../src/lib/plan-copier';
import * as modelTracker from '../../src/lib/model-tracker';
import * as portAllocator from '../../src/lib/port-allocator';
import * as sdkClient from '../../src/lib/sdk-client';

vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234'),
}));

const { mc_launch } = await import('../../src/tools/launch');

let mockGetJobByName: any;
let mockAddJob: any;
let mockCreateWorktree: any;
let mockRemoveWorktree: any;
let mockCreateSession: any;
let mockCreateWindow: any;
let mockSetPaneDiedHook: any;
let mockSendKeys: any;
let mockKillSession: any;
let mockGetCurrentSession: any;
let mockIsInsideTmux: any;
let mockLoadConfig: any;
let mockWritePromptFile: any;
let mockWriteLauncherScript: any;
let mockDetectOMO: any;
let mockCopyPlansToWorktree: any;
let mockResolvePostCreateHook: any;
let mockAllocatePort: any;
let mockReleasePort: any;
let mockWaitForServer: any;
let mockCreateSessionAndPrompt: any;
let mockWriteServeLauncherScript: any;
let mockGetRunningJobs: any;

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
  mockWritePromptFile.mockResolvedValue('/tmp/mc-worktrees/test-job/.mc-prompt.txt');
  mockWriteLauncherScript.mockResolvedValue('/tmp/mc-worktrees/test-job/.mc-launch.sh');
  mockDetectOMO.mockResolvedValue({ detected: true, configSource: 'local', sisyphusPath: './.sisyphus' });
  mockCopyPlansToWorktree.mockResolvedValue(undefined);
  mockAddJob.mockResolvedValue(undefined);
  mockKillSession.mockResolvedValue(undefined);
  mockRemoveWorktree.mockResolvedValue(undefined);
  mockGetCurrentSession.mockReturnValue('main-session');
  mockIsInsideTmux.mockReturnValue(true);
}

describe('mc_launch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockImplementation(() => undefined as any);
    mockAddJob = vi.spyOn(jobState, 'addJob').mockImplementation(() => undefined as any);
    mockCreateWorktree = vi.spyOn(worktree, 'createWorktree').mockImplementation(() => undefined as any);
    mockRemoveWorktree = vi.spyOn(worktree, 'removeWorktree').mockImplementation(() => undefined as any);
    mockCreateSession = vi.spyOn(tmux, 'createSession').mockImplementation(() => undefined as any);
    mockCreateWindow = vi.spyOn(tmux, 'createWindow').mockImplementation(() => undefined as any);
    mockSetPaneDiedHook = vi.spyOn(tmux, 'setPaneDiedHook').mockImplementation(() => undefined as any);
    mockSendKeys = vi.spyOn(tmux, 'sendKeys').mockImplementation(() => undefined as any);
    mockKillSession = vi.spyOn(tmux, 'killSession').mockImplementation(() => undefined as any);
    mockGetCurrentSession = vi.spyOn(tmux, 'getCurrentSession').mockImplementation(() => 'main-session' as any);
    mockIsInsideTmux = vi.spyOn(tmux, 'isInsideTmux').mockImplementation(() => true as any);
    vi.spyOn(tmux, 'isTmuxAvailable').mockImplementation(() => Promise.resolve(true) as any);
    mockLoadConfig = vi.spyOn(configMod, 'loadConfig').mockImplementation(() => ({ defaultPlacement: 'session', pollInterval: 10000, idleThreshold: 300000, worktreeBasePath: '/tmp/mc-worktrees', omo: { enabled: false, defaultMode: 'vanilla' } } as any));
    mockWritePromptFile = vi.spyOn(promptFile, 'writePromptFile').mockImplementation(() => Promise.resolve('/tmp/mc-worktrees/test-job/.mc-prompt.txt') as any);
    vi.spyOn(promptFile, 'cleanupPromptFile').mockImplementation(() => undefined as any);
    mockWriteLauncherScript = vi.spyOn(promptFile, 'writeLauncherScript').mockImplementation(() => Promise.resolve('/tmp/mc-worktrees/test-job/.mc-launch.sh') as any);
    vi.spyOn(promptFile, 'cleanupLauncherScript').mockImplementation(() => undefined as any);
    mockDetectOMO = vi.spyOn(omo, 'detectOMO').mockImplementation(() => Promise.resolve({ detected: true, configSource: 'local', sisyphusPath: './.sisyphus' }) as any);
    mockCopyPlansToWorktree = vi.spyOn(planCopier, 'copyPlansToWorktree').mockImplementation(() => Promise.resolve(undefined) as any);
    mockResolvePostCreateHook = vi.spyOn(worktreeSetup, 'resolvePostCreateHook').mockImplementation(() => ({ symlinkDirs: ['.opencode'] } as any));
    vi.spyOn(modelTracker, 'getCurrentModel').mockReturnValue(undefined);
    mockAllocatePort = vi.spyOn(portAllocator, 'allocatePort').mockImplementation(() => Promise.resolve(14100) as any);
    mockReleasePort = vi.spyOn(portAllocator, 'releasePort').mockImplementation(() => Promise.resolve(undefined) as any);
    mockWaitForServer = vi.spyOn(sdkClient, 'waitForServer').mockImplementation(() => Promise.resolve({ session: {} } as any));
    mockCreateSessionAndPrompt = vi.spyOn(sdkClient, 'createSessionAndPrompt').mockImplementation(() => Promise.resolve('sdk-session-1') as any);
    mockWriteServeLauncherScript = vi.spyOn(promptFile, 'writeServeLauncherScript').mockImplementation(() => Promise.resolve('/tmp/mc-worktrees/test-job/.mc-launch.sh') as any);
    mockGetRunningJobs = vi.spyOn(jobState, 'getRunningJobs').mockImplementation(() => Promise.resolve([]) as any);
    vi.spyOn(tmux, 'killSession').mockImplementation(() => Promise.resolve(undefined) as any);
    vi.spyOn(tmux, 'killWindow').mockImplementation(() => Promise.resolve(undefined) as any);
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
        postCreate: expect.objectContaining({
          symlinkDirs: expect.arrayContaining(['.opencode']),
        }),
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
        postCreate: expect.objectContaining({
          symlinkDirs: expect.arrayContaining(['.opencode']),
        }),
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
        command: "bash '/tmp/mc-worktrees/test-job/.mc-launch.sh'",
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
        command: "bash '/tmp/mc-worktrees/test-job/.mc-launch.sh'",
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

    it('should write launcher script and prompt file', async () => {
      await mc_launch.execute(
        { name: 'feature-auth', prompt: 'Add auth' },
        mockContext,
      );

      expect(mockWritePromptFile).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job',
        expect.stringContaining('Add auth'),
      );
      expect(mockWriteLauncherScript).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job',
        '/tmp/mc-worktrees/test-job/.mc-prompt.txt',
        undefined,
      );
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

    it('should pass copyFiles through to resolvePostCreateHook', async () => {
      await mc_launch.execute(
        {
          name: 'feature-auth',
          prompt: 'Add auth',
          copyFiles: ['.env', '.env.local'],
        },
        mockContext,
      );

      const calls = mockResolvePostCreateHook.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const secondArg = calls[calls.length - 1][1];
      expect(secondArg).toMatchObject({
        copyFiles: ['.env', '.env.local'],
      });
    });

    it('should pass symlinkDirs through to resolvePostCreateHook including builtin .opencode', async () => {
      mockResolvePostCreateHook.mockImplementation((_config: any, overrides: any) => ({
        symlinkDirs: ['.opencode', ...(overrides?.symlinkDirs ?? [])],
      }));

      await mc_launch.execute(
        {
          name: 'feature-auth',
          prompt: 'Add auth',
          symlinkDirs: ['node_modules', '.cache'],
        },
        mockContext,
      );

      const calls = mockResolvePostCreateHook.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const secondArg = calls[calls.length - 1][1];
      expect(secondArg.symlinkDirs).toEqual(expect.arrayContaining(['node_modules', '.cache']));
    });

    it('should pass commands through to resolvePostCreateHook', async () => {
      await mc_launch.execute(
        {
          name: 'feature-auth',
          prompt: 'Add auth',
          commands: ['bun install', 'echo done'],
        },
        mockContext,
      );

      const calls = mockResolvePostCreateHook.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const secondArg = calls[calls.length - 1][1];
      expect(secondArg).toMatchObject({
        commands: ['bun install', 'echo done'],
      });
    });

    it('should pass model from getCurrentModel to writeLauncherScript', async () => {
      vi.spyOn(modelTracker, 'getCurrentModel').mockReturnValue('anthropic/claude-sonnet-4-20250514');

      await mc_launch.execute(
        { name: 'feature-auth', prompt: 'Add auth' },
        mockContext,
      );

      expect(mockWriteLauncherScript).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job',
        '/tmp/mc-worktrees/test-job/.mc-prompt.txt',
        'anthropic/claude-sonnet-4-20250514',
      );
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

       expect(mockWritePromptFile).toHaveBeenCalledWith(
         '/tmp/mc-worktrees/test-job',
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

    it('should cleanup worktree when launch file creation fails', async () => {
      mockWritePromptFile.mockRejectedValue(new Error('write failed'));

      await expect(
        mc_launch.execute({ name: 'test', prompt: 'stuff' }, mockContext),
      ).rejects.toThrow('Failed to write launch files');

      expect(mockKillSession).not.toHaveBeenCalled();
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

  describe('serve mode', () => {
    beforeEach(() => {
      mockLoadConfig.mockResolvedValue({
        defaultPlacement: 'session',
        pollInterval: 10000,
        idleThreshold: 300000,
        worktreeBasePath: '/tmp/mc-worktrees',
        useServeMode: true,
        portRangeStart: 14100,
        portRangeEnd: 14199,
        omo: { enabled: false, defaultMode: 'vanilla' },
      });
    });

    it('should allocate port and use serve launcher', async () => {
      await mc_launch.execute(
        { name: 'serve-job', prompt: 'Do task' },
        mockContext,
      );

      expect(mockAllocatePort).toHaveBeenCalled();
      expect(mockWriteServeLauncherScript).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job',
        14100,
        undefined,
      );
    });

    it('should not call TUI writeLauncherScript or writePromptFile', async () => {
      await mc_launch.execute(
        { name: 'serve-job', prompt: 'Do task' },
        mockContext,
      );

      expect(mockWritePromptFile).not.toHaveBeenCalled();
      expect(mockWriteLauncherScript).not.toHaveBeenCalled();
    });

    it('should wait for server and send prompt via SDK', async () => {
      await mc_launch.execute(
        { name: 'serve-job', prompt: 'Do task' },
        mockContext,
      );

      expect(mockWaitForServer).toHaveBeenCalledWith(14100, {
        password: undefined,
      });
      expect(mockCreateSessionAndPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Do task'),
        undefined,
        undefined,
      );
    });

    it('should store port and serverUrl on job record', async () => {
      await mc_launch.execute(
        { name: 'serve-job', prompt: 'Do task' },
        mockContext,
      );

      expect(mockAddJob).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 14100,
          serverUrl: 'http://127.0.0.1:14100',
        }),
      );
    });

    it('should include port info in output', async () => {
      const result = await mc_launch.execute(
        { name: 'serve-job', prompt: 'Do task' },
        mockContext,
      );

      expect(result).toContain('Port:      14100');
      expect(result).toContain('Server:    http://127.0.0.1:14100');
    });

    it('should pass serverPassword to serve launcher and waitForServer', async () => {
      mockLoadConfig.mockResolvedValue({
        defaultPlacement: 'session',
        pollInterval: 10000,
        idleThreshold: 300000,
        worktreeBasePath: '/tmp/mc-worktrees',
        useServeMode: true,
        portRangeStart: 14100,
        portRangeEnd: 14199,
        serverPassword: 'my-secret',
        omo: { enabled: false, defaultMode: 'vanilla' },
      });

      await mc_launch.execute(
        { name: 'serve-job', prompt: 'Do task' },
        mockContext,
      );

      expect(mockWriteServeLauncherScript).toHaveBeenCalledWith(
        '/tmp/mc-worktrees/test-job',
        14100,
        'my-secret',
      );
      expect(mockWaitForServer).toHaveBeenCalledWith(14100, {
        password: 'my-secret',
      });
    });

    it('should not use sendKeys for OMO modes in serve mode', async () => {
      mockLoadConfig.mockResolvedValue({
        defaultPlacement: 'session',
        pollInterval: 10000,
        idleThreshold: 300000,
        worktreeBasePath: '/tmp/mc-worktrees',
        useServeMode: true,
        portRangeStart: 14100,
        portRangeEnd: 14199,
        omo: { enabled: true, defaultMode: 'ulw' },
      });
      mockDetectOMO.mockResolvedValue({ detected: true, configSource: 'local', sisyphusPath: './.sisyphus' });

      await mc_launch.execute(
        { name: 'serve-job', prompt: 'Do task', mode: 'ulw' },
        mockContext,
      );

      expect(mockSendKeys).not.toHaveBeenCalled();
    });

    it('should cleanup on waitForServer failure', async () => {
      mockWaitForServer.mockRejectedValue(new Error('Server timeout'));

      await expect(
        mc_launch.execute(
          { name: 'serve-job', prompt: 'Do task' },
          mockContext,
        ),
      ).rejects.toThrow('Failed to start serve session');

      expect(mockReleasePort).toHaveBeenCalledWith(14100);
      expect(mockRemoveWorktree).toHaveBeenCalled();
    });

    it('should cleanup on port allocation failure', async () => {
      mockAllocatePort.mockRejectedValue(new Error('No ports'));

      await expect(
        mc_launch.execute(
          { name: 'serve-job', prompt: 'Do task' },
          mockContext,
        ),
      ).rejects.toThrow('Failed to allocate port');

      expect(mockRemoveWorktree).toHaveBeenCalled();
    });
  });

  describe('TUI mode fallback', () => {
    it('should use TUI path when useServeMode is false', async () => {
      mockLoadConfig.mockResolvedValue({
        defaultPlacement: 'session',
        pollInterval: 10000,
        idleThreshold: 300000,
        worktreeBasePath: '/tmp/mc-worktrees',
        useServeMode: false,
        omo: { enabled: false, defaultMode: 'vanilla' },
      });

      await mc_launch.execute(
        { name: 'tui-job', prompt: 'Do task' },
        mockContext,
      );

      expect(mockAllocatePort).not.toHaveBeenCalled();
      expect(mockWriteServeLauncherScript).not.toHaveBeenCalled();
      expect(mockWaitForServer).not.toHaveBeenCalled();
      expect(mockWritePromptFile).toHaveBeenCalled();
      expect(mockWriteLauncherScript).toHaveBeenCalled();
    });

    it('should not store port on job when in TUI mode', async () => {
      mockLoadConfig.mockResolvedValue({
        defaultPlacement: 'session',
        pollInterval: 10000,
        idleThreshold: 300000,
        worktreeBasePath: '/tmp/mc-worktrees',
        useServeMode: false,
        omo: { enabled: false, defaultMode: 'vanilla' },
      });

      await mc_launch.execute(
        { name: 'tui-job', prompt: 'Do task' },
        mockContext,
      );

      expect(mockAddJob).toHaveBeenCalledWith(
        expect.objectContaining({
          port: undefined,
          serverUrl: undefined,
        }),
      );
    });
  });
});
