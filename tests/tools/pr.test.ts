import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { Job } from '../../src/lib/job-state';
import * as jobState from '../../src/lib/job-state';
import * as jobRuntime from '../../src/lib/job-runtime';
import * as git from '../../src/lib/git';
import { getProjectDirectory } from '../../src/lib/project-context';

const { mc_pr } = await import('../../src/tools/pr');

let mockGetJobByName: Mock;
let mockAssertPermission: Mock;
let spawned: Array<{ command: string[]; cwd?: string }>;
let spawnResults: Array<{ stdout?: string; stderr?: string; exitCode: number }>;

function textStream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

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

describe('mc_pr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobByName = vi.spyOn(jobState, 'getJobByName').mockImplementation(() => undefined as any);
    mockAssertPermission = vi.spyOn(jobRuntime, 'assertToolPermission').mockResolvedValue(undefined) as unknown as Mock;
    vi.spyOn(git, 'getDefaultBranch').mockResolvedValue('main');
    // Nothing in this file may reach a real `git push` or `gh`.
    spawned = [];
    spawnResults = [];
    vi.spyOn(Bun, 'spawn').mockImplementation(((command: string[], options?: { cwd?: string }) => {
      spawned.push({ command, cwd: options?.cwd });
      const result = spawnResults.shift() ?? { exitCode: 1, stderr: 'no result scripted' };
      return {
        stdout: textStream(result.stdout ?? ''),
        stderr: textStream(result.stderr ?? ''),
        exited: Promise.resolve(result.exitCode),
      };
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tool definition', () => {
    it('should have correct description', () => {
      expect(mc_pr.description).toBe(
        'Create a pull request from a job\'s branch',
      );
    });

    it('should have required name arg', () => {
      expect(mc_pr.input.shape.name).toBeDefined();
    });

    it('should have optional title arg', () => {
      expect(mc_pr.input.shape.title).toBeDefined();
    });

    it('should have optional body arg', () => {
      expect(mc_pr.input.shape.body).toBeDefined();
    });

    it('should have optional draft arg', () => {
      expect(mc_pr.input.shape.draft).toBeDefined();
    });
  });

  describe('job lookup', () => {
    it('should throw error when job not found', async () => {
      mockGetJobByName.mockResolvedValue(undefined);

      await expect(
        mc_pr.execute({ name: 'nonexistent' }, mockContext),
      ).rejects.toThrow('Job "nonexistent" not found');
    });

    it('should find job by name', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        branch: 'mc/feature-auth',
        worktreePath: '/tmp/wt1',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Add OAuth support',
        mode: 'plan',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      expect(mockGetJobByName).not.toHaveBeenCalled();
      
      try {
        await mc_pr.execute({ name: 'feature-auth' }, mockContext);
      } catch {
        // Expected to fail at gh command execution
      }

      expect(mockGetJobByName).toHaveBeenCalledWith('feature-auth');
    });
  });

  describe('argument handling', () => {
    it('should use job name as default title', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        branch: 'mc/feature-auth',
        worktreePath: '/tmp/wt1',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Add OAuth support',
        mode: 'plan',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_pr.execute({ name: 'feature-auth' }, mockContext);
      } catch {
        // Expected to fail at gh command execution
      }

      expect(mockGetJobByName).toHaveBeenCalledWith('feature-auth');
    });

    it('should accept custom title', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        branch: 'mc/feature-auth',
        worktreePath: '/tmp/wt1',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Add OAuth support',
        mode: 'plan',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_pr.execute(
          { name: 'feature-auth', title: 'Custom Title' },
          mockContext,
        );
      } catch {
        // Expected to fail at gh command execution
      }

      expect(mockGetJobByName).toHaveBeenCalledWith('feature-auth');
    });

    it('should accept body parameter', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        branch: 'mc/feature-auth',
        worktreePath: '/tmp/wt1',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Add OAuth support',
        mode: 'plan',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_pr.execute(
          { name: 'feature-auth', body: 'PR body' },
          mockContext,
        );
      } catch {
        // Expected to fail at gh command execution
      }

      expect(mockGetJobByName).toHaveBeenCalledWith('feature-auth');
    });

    it('should accept draft parameter', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        branch: 'mc/feature-auth',
        worktreePath: '/tmp/wt1',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Add OAuth support',
        mode: 'plan',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_pr.execute(
          { name: 'feature-auth', draft: true },
          mockContext,
        );
      } catch {
        // Expected to fail at gh command execution
      }

      expect(mockGetJobByName).toHaveBeenCalledWith('feature-auth');
    });

    it('should accept all parameters together', async () => {
      const job: Job = {
        id: 'job-1',
        name: 'feature-auth',
        branch: 'mc/feature-auth',
        worktreePath: '/tmp/wt1',
        tmuxTarget: 'mc-feature-auth',
        placement: 'session',
        status: 'running',
        prompt: 'Add OAuth support',
        mode: 'plan',
        createdAt: new Date().toISOString(),
      };

      mockGetJobByName.mockResolvedValue(job);

      try {
        await mc_pr.execute(
          {
            name: 'feature-auth',
            title: 'Custom Title',
            body: 'PR body',
            draft: true,
          },
          mockContext,
        );
      } catch {
        // Expected to fail at gh command execution
      }

      expect(mockGetJobByName).toHaveBeenCalledWith('feature-auth');
    });
  });
  describe('pushing and creating the PR', () => {
    const job: Job = {
      id: 'job-1',
      name: 'feature-auth',
      branch: 'mc/feature-auth',
      // Gone already (cleaned up): the project directory is used instead.
      worktreePath: '/tmp/mc-pr-test-worktree-that-does-not-exist',
      status: 'completed',
      prompt: 'Add OAuth support',
      baseBranch: 'develop',
      createdAt: new Date().toISOString(),
    };
    const context = { sessionID: 'ses_caller', agent: 'build', messageID: 'msg_1', id: 'call_1' };

    it('asks permission for the branch, then pushes it, then opens the PR', async () => {
      mockGetJobByName.mockResolvedValue(job);
      spawnResults = [{ exitCode: 0 }, { exitCode: 0, stdout: 'https://github.com/acme/repo/pull/12\n' }];
      const order: string[] = [];
      mockAssertPermission.mockImplementation(async () => {
        order.push('permission');
      });

      const result = await mc_pr.execute({ name: 'feature-auth', title: 'feat: oauth', draft: true }, context);
      order.push(...spawned.map((entry) => entry.command.slice(0, 3).join(' ')));

      expect(mockAssertPermission).toHaveBeenCalledWith(context, 'mission-control.pr', ['mc/feature-auth']);
      expect(order).toEqual(['permission', 'git push origin', 'gh pr create']);
      expect(spawned[0].command).toEqual(['git', 'push', 'origin', 'mc/feature-auth']);
      expect(spawned[1].command).toEqual(
        expect.arrayContaining(['--title', 'feat: oauth', '--head', 'mc/feature-auth', '--base', 'develop', '--draft']),
      );
      expect(result.content).toBe('https://github.com/acme/repo/pull/12');
    });

    it('pushes nothing when the permission is denied, and lets the denial through unchanged', async () => {
      mockGetJobByName.mockResolvedValue(job);
      const denial = new Error('The user rejected permission to use this specific tool call.');
      mockAssertPermission.mockRejectedValue(denial);

      await expect(mc_pr.execute({ name: 'feature-auth' }, context)).rejects.toBe(denial);

      expect(spawned).toEqual([]);
    });

    it("runs in the project directory, never the server's own, when the worktree is gone", async () => {
      mockGetJobByName.mockResolvedValue(job);
      spawnResults = [{ exitCode: 0 }, { exitCode: 0, stdout: 'https://github.com/acme/repo/pull/12' }];

      await mc_pr.execute({ name: 'feature-auth', body: 'Body' }, context);

      expect(spawned[0].cwd).toBe(getProjectDirectory());
      expect(spawned[1].cwd).toBe(getProjectDirectory());
    });

    it('reports a failed push and does not open a PR', async () => {
      mockGetJobByName.mockResolvedValue(job);
      spawnResults = [{ exitCode: 1, stderr: 'remote: Permission denied' }];

      await expect(mc_pr.execute({ name: 'feature-auth' }, context)).rejects.toThrow(
        'Failed to push branch "mc/feature-auth": remote: Permission denied',
      );
      expect(spawned).toHaveLength(1);
    });
  });
});
