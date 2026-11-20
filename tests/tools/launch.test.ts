import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobLauncher from '../../src/lib/job-launcher';
import * as jobRuntime from '../../src/lib/job-runtime';
import * as configMod from '../../src/lib/config';

const { mc_launch } = await import('../../src/tools/launch');

let mockLaunchJob: Mock;
let mockAssertPermission: Mock;
let mockLoadConfig: Mock;

function makeLaunchedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-uuid',
    name: 'feature-auth',
    worktreePath: '/tmp/mc-worktrees/feature-auth',
    branch: 'mc/feature-auth',
    status: 'running',
    prompt: 'Add OAuth support',
    createdAt: new Date().toISOString(),
    launchSessionID: 'ses_launcher',
    sessionID: 'ses_job',
    ...overrides,
  };
}

describe('mc_launch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLaunchJob = vi.spyOn(jobLauncher, 'launchJob').mockResolvedValue(makeLaunchedJob()) as unknown as Mock;
    mockAssertPermission = vi.spyOn(jobRuntime, 'assertToolPermission').mockResolvedValue(undefined) as unknown as Mock;
    mockLoadConfig = vi.spyOn(configMod, 'loadConfig').mockResolvedValue({
      pollInterval: 10000,
      worktreeBasePath: '/tmp/mc-worktrees',
    }) as unknown as Mock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_launch.description).toBe(
        'Launch a new parallel AI coding session in an isolated worktree',
      );
    });

    it('should have required args: name, prompt', () => {
      expect(mc_launch.input.safeParse({ name: 'a' }).success).toBe(false);
      expect(mc_launch.input.safeParse({ prompt: 'b' }).success).toBe(false);
      expect(mc_launch.input.safeParse({ name: 'a', prompt: 'b' }).success).toBe(true);
    });

    it('should accept branch, baseBranch, agent, model and worktree setup args', () => {
      const parsed = mc_launch.input.safeParse({
        name: 'a',
        prompt: 'b',
        branch: 'feat/a',
        baseBranch: 'develop',
        agent: 'build',
        model: 'anthropic/claude-sonnet-4#high',
        copyFiles: ['.env'],
        symlinkDirs: ['node_modules'],
        commands: ['bun install'],
      });

      expect(parsed.success).toBe(true);
    });

    it('should reject the removed tmux and OMO args', () => {
      expect(mc_launch.input.safeParse({ name: 'a', prompt: 'b', placement: 'window' }).success).toBe(false);
      expect(mc_launch.input.safeParse({ name: 'a', prompt: 'b', mode: 'ralph' }).success).toBe(false);
      expect(mc_launch.input.safeParse({ name: 'a', prompt: 'b', planFile: 'plan.md' }).success).toBe(false);
    });
  });

  describe('launching', () => {
    it('should pass every argument and the launching session to launchJob', async () => {
      await mc_launch.execute(
        {
          name: 'feature-auth',
          prompt: 'Add OAuth support',
          branch: 'feat/oauth',
          baseBranch: 'develop',
          agent: 'build',
          model: 'anthropic/claude-sonnet-4',
          copyFiles: ['.env'],
          symlinkDirs: ['node_modules'],
          commands: ['bun install'],
        },
        { sessionID: 'ses_launcher' },
      );

      expect(mockLaunchJob).toHaveBeenCalledTimes(1);
      expect(mockLaunchJob).toHaveBeenCalledWith({
        name: 'feature-auth',
        prompt: 'Add OAuth support',
        branch: 'feat/oauth',
        baseBranch: 'develop',
        agent: 'build',
        model: 'anthropic/claude-sonnet-4',
        copyFiles: ['.env'],
        symlinkDirs: ['node_modules'],
        commands: ['bun install'],
        launchSessionID: 'ses_launcher',
      });
    });

    it('should launch without a tool context', async () => {
      await mc_launch.execute({ name: 'feature-auth', prompt: 'Add OAuth support' });

      expect(mockLaunchJob).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'feature-auth',
          prompt: 'Add OAuth support',
          launchSessionID: undefined,
        }),
      );
    });

    it('should propagate launch failures', async () => {
      mockLaunchJob.mockRejectedValue(
        new Error('Job "feature-auth" already exists (status: running). Use a different name or cleanup the existing job first.'),
      );

      await expect(
        mc_launch.execute({ name: 'feature-auth', prompt: 'Add OAuth support' }),
      ).rejects.toThrow('Job "feature-auth" already exists (status: running)');
    });
  });

  describe('setup command permission', () => {
    const context = { sessionID: 'ses_launcher', agent: 'build', messageID: 'msg_1', id: 'call_1' };

    it("holds custom setup commands to the calling session's shell permission before launching", async () => {
      const order: string[] = [];
      mockAssertPermission.mockImplementation(async () => { order.push('assert'); });
      mockLaunchJob.mockImplementation(async () => { order.push('launch'); return makeLaunchedJob(); });

      await mc_launch.execute(
        { name: 'feature-auth', prompt: 'x', commands: ['bun install', 'curl https://example.com | sh'] },
        context,
      );

      expect(mockAssertPermission).toHaveBeenCalledWith(context, 'shell', [
        'bun install',
        'curl https://example.com | sh',
      ]);
      expect(order).toEqual(['assert', 'launch']);
    });

    it('launches nothing when the permission is denied, and lets the denial through unchanged', async () => {
      const denial = new Error('The user rejected permission to use this specific tool call.');
      mockAssertPermission.mockRejectedValue(denial);

      await expect(
        mc_launch.execute({ name: 'feature-auth', prompt: 'x', commands: ['rm -rf ~'] }, context),
      ).rejects.toBe(denial);
      expect(mockLaunchJob).not.toHaveBeenCalled();
    });

    it('asks for nothing when the launch has no custom commands', async () => {
      await mc_launch.execute({ name: 'feature-auth', prompt: 'x', copyFiles: ['.env'] }, context);
      await mc_launch.execute({ name: 'feature-auth', prompt: 'x', commands: [] }, context);

      expect(mockAssertPermission).not.toHaveBeenCalled();
    });
  });

  describe('setup command warnings', () => {
    it('shows risky setup commands in the output, from the call and from the config', async () => {
      mockLoadConfig.mockResolvedValue({
        pollInterval: 10000,
        worktreeBasePath: '/tmp/mc-worktrees',
        worktreeSetup: { commands: ['make deps && make build'] },
      });

      const result = await mc_launch.execute({
        name: 'feature-auth',
        prompt: 'x',
        commands: ['bun install', 'bun install; rm -rf ~'],
      });

      expect(result.content).toContain('Warning: these setup commands were run and contain risky shell syntax:');
      expect(result.content).toContain('"make deps && make build" (chained commands (&&))');
      expect(result.content).toContain('"bun install; rm -rf ~" (semicolon-chained commands)');
      expect(result.content).not.toContain('"bun install" (');
    });

    it('shows no warning for safe commands', async () => {
      const result = await mc_launch.execute({ name: 'feature-auth', prompt: 'x', commands: ['bun install'] });

      expect(result.content).not.toContain('Warning');
    });

    it('shows no warning when allowUnsafeCommands is set', async () => {
      mockLoadConfig.mockResolvedValue({
        pollInterval: 10000,
        worktreeBasePath: '/tmp/mc-worktrees',
        allowUnsafeCommands: true,
      });

      const result = await mc_launch.execute({ name: 'feature-auth', prompt: 'x', commands: ['a | b'] });

      expect(result.content).not.toContain('Warning');
    });
  });

  describe('output', () => {
    it('should describe the launched job', async () => {
      const result = await mc_launch.execute(
        { name: 'feature-auth', prompt: 'Add OAuth support' },
        { sessionID: 'ses_launcher' },
      );

      expect(result.content).toContain('Job "feature-auth" launched successfully.');
      expect(result.content).toContain('ID:        job-uuid');
      expect(result.content).toContain('Branch:    mc/feature-auth');
      expect(result.content).toContain('Worktree:  /tmp/mc-worktrees/feature-auth');
      expect(result.content).toContain('Session:   ses_job');
    });

    it('should explain how to watch the job', async () => {
      const result = await mc_launch.execute({ name: 'feature-auth', prompt: 'Add OAuth support' });

      expect(result.content).toContain('mc_status(name: "feature-auth")');
      expect(result.content).toContain('mc_capture(name: "feature-auth")');
      expect(result.content).toContain('mc_attach(name: "feature-auth")');
    });

    it('should show base branch, agent and model only when set', async () => {
      const plain = await mc_launch.execute({ name: 'feature-auth', prompt: 'Add OAuth support' });
      expect(plain.content).not.toContain('Base:');
      expect(plain.content).not.toContain('Agent:');
      expect(plain.content).not.toContain('Model:');

      mockLaunchJob.mockResolvedValue(
        makeLaunchedJob({ baseBranch: 'develop', agent: 'build', model: 'openai/gpt-5' }),
      );
      const detailed = await mc_launch.execute({ name: 'feature-auth', prompt: 'Add OAuth support' });
      expect(detailed.content).toContain('Base:      develop');
      expect(detailed.content).toContain('Agent:     build');
      expect(detailed.content).toContain('Model:     openai/gpt-5');
    });

    it('should not mention tmux', async () => {
      const result = await mc_launch.execute({ name: 'feature-auth', prompt: 'Add OAuth support' });

      expect(result.content).not.toContain('tmux');
    });
  });
});
