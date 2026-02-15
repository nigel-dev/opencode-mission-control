import { mock, describe, it, expect, beforeEach } from 'bun:test';
import {
  buildTaskSummary,
  isPathInsideWorktree,
  shouldAutoApprove,
  buildQuestionPrompt,
  QuestionRelay,
  type PermissionRequest,
} from '../../src/lib/question-relay';
import type { Job } from '../../src/lib/job-state';

describe('buildTaskSummary', () => {
  it('should return the full prompt if under 120 chars', () => {
    const prompt = 'Fix the login bug';
    expect(buildTaskSummary(prompt)).toBe(prompt);
  });

  it('should truncate and add ellipsis if over 120 chars', () => {
    const prompt = 'A'.repeat(150);
    const result = buildTaskSummary(prompt);
    expect(result.length).toBe(120);
    expect(result.endsWith('...')).toBe(true);
  });

  it('should handle exactly 120 chars without truncation', () => {
    const prompt = 'A'.repeat(120);
    expect(buildTaskSummary(prompt)).toBe(prompt);
  });
});

describe('isPathInsideWorktree', () => {
  it('should return true for paths inside worktree', () => {
    expect(isPathInsideWorktree('/home/user/project/src/file.ts', '/home/user/project')).toBe(true);
  });

  it('should return false for paths outside worktree', () => {
    expect(isPathInsideWorktree('/etc/passwd', '/home/user/project')).toBe(false);
  });

  it('should handle paths with trailing slashes', () => {
    expect(isPathInsideWorktree('/home/user/project/src/file.ts', '/home/user/project/')).toBe(true);
  });

  it('should handle Windows-style paths', () => {
    expect(isPathInsideWorktree('C:\\Users\\project\\src\\file.ts', 'C:\\Users\\project')).toBe(true);
  });

  it('should return false for sibling directories', () => {
    expect(isPathInsideWorktree('/home/user/other/file.ts', '/home/user/project')).toBe(false);
  });
});

describe('shouldAutoApprove', () => {
  const worktreePath = '/home/user/project';

  it('should auto-approve MCP tool execution', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'mcp',
      description: 'Execute MCP tool',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(true);
    expect(result.autoApproved).toBe(true);
  });

  it('should auto-approve file operations inside worktree', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'file_operation',
      path: '/home/user/project/src/file.ts',
      description: 'Edit file',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(true);
    expect(result.autoApproved).toBe(true);
  });

  it('should NOT auto-approve file operations outside worktree', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'file_operation',
      path: '/etc/passwd',
      description: 'Edit system file',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(false);
    expect(result.autoApproved).toBe(false);
  });

  it('should auto-approve shell commands inside worktree', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'shell_command',
      path: '/home/user/project',
      description: 'Run npm install',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(true);
    expect(result.autoApproved).toBe(true);
  });

  it('should auto-approve shell commands without specified path', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'shell_command',
      description: 'Run ls',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(true);
    expect(result.autoApproved).toBe(true);
  });

  it('should NOT auto-approve shell commands outside worktree', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'shell_command',
      path: '/etc',
      description: 'Run system command',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(false);
    expect(result.autoApproved).toBe(false);
  });

  it('should NOT auto-approve network operations', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'network',
      description: 'Make HTTP request',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(false);
    expect(result.autoApproved).toBe(false);
  });

  it('should NOT auto-approve unknown permission types', () => {
    const permission: PermissionRequest = {
      id: 'perm-1',
      type: 'other',
      description: 'Unknown operation',
    };

    const result = shouldAutoApprove(permission, worktreePath);

    expect(result.approved).toBe(false);
    expect(result.autoApproved).toBe(false);
  });
});

describe('buildQuestionPrompt', () => {
  it('should include job name and task summary', () => {
    const context = {
      jobName: 'fix-auth',
      taskSummary: 'Fix the authentication bug',
    };

    const prompt = buildQuestionPrompt(context);

    expect(prompt).toContain('fix-auth');
    expect(prompt).toContain('Fix the authentication bug');
  });

  it('should include current file when provided', () => {
    const context = {
      jobName: 'fix-auth',
      taskSummary: 'Fix the authentication bug',
      currentFile: 'src/auth.ts',
    };

    const prompt = buildQuestionPrompt(context);

    expect(prompt).toContain('src/auth.ts');
  });

  it('should include permission request details', () => {
    const context = {
      jobName: 'fix-auth',
      taskSummary: 'Fix the authentication bug',
      permissionRequest: {
        id: 'perm-1',
        type: 'file_operation' as const,
        path: '/etc/config',
        description: 'Edit system config',
      },
    };

    const prompt = buildQuestionPrompt(context);

    expect(prompt).toContain('file_operation');
    expect(prompt).toContain('/etc/config');
    expect(prompt).toContain('Edit system config');
  });

  it('should include all options', () => {
    const context = {
      jobName: 'fix-auth',
      taskSummary: 'Fix the authentication bug',
    };

    const prompt = buildQuestionPrompt(context);

    expect(prompt).toContain('yes');
    expect(prompt).toContain('no');
    expect(prompt).toContain('best judgment');
  });
});

describe('QuestionRelay', () => {
  let relay: QuestionRelay;

  beforeEach(() => {
    relay = new QuestionRelay();
  });

  const mockJob: Job = {
    id: 'job-1',
    name: 'Test Job',
    worktreePath: '/home/user/project',
    branch: 'main',
    tmuxTarget: 'mc-test',
    placement: 'session',
    status: 'running',
    prompt: 'Fix the authentication bug',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    port: 8080,
    launchSessionID: 'session-123',
  };

  describe('handlePermissionRequest', () => {
    it('should auto-approve MCP permissions without relaying', async () => {
      const permission: PermissionRequest = {
        id: 'perm-1',
        type: 'mcp',
        description: 'Execute MCP tool',
      };

      const result = await relay.handlePermissionRequest(mockJob, permission);

      expect(result.autoApproved).toBe(true);
    });

    it('should auto-approve file operations inside worktree', async () => {
      const permission: PermissionRequest = {
        id: 'perm-1',
        type: 'file_operation',
        path: '/home/user/project/src/file.ts',
        description: 'Edit file',
      };

      const result = await relay.handlePermissionRequest(mockJob, permission);

      expect(result.autoApproved).toBe(true);
    });

    it('should not auto-approve operations outside worktree', async () => {
      const permission: PermissionRequest = {
        id: 'perm-1',
        type: 'file_operation',
        path: '/etc/passwd',
        description: 'Edit system file',
      };

      const result = await relay.handlePermissionRequest(mockJob, permission);

      expect(result.autoApproved).toBe(false);
      expect(result.approved).toBe(false);
    });

    it('should handle jobs without port gracefully', async () => {
      const jobWithoutPort = { ...mockJob, port: undefined };
      const permission: PermissionRequest = {
        id: 'perm-1',
        type: 'mcp',
        description: 'Execute MCP tool',
      };

      const result = await relay.handlePermissionRequest(jobWithoutPort, permission);

      expect(result.autoApproved).toBe(true);
    });

    it('should handle jobs without launchSessionID gracefully', async () => {
      const jobWithoutSession = { ...mockJob, launchSessionID: undefined };
      const permission: PermissionRequest = {
        id: 'perm-1',
        type: 'file_operation',
        path: '/etc/passwd',
        description: 'Edit system file',
      };

      const result = await relay.handlePermissionRequest(jobWithoutSession, permission);

      expect(result.autoApproved).toBe(false);
    });
  });

  describe('configuration', () => {
    it('should accept custom timeout configuration', () => {
      const customRelay = new QuestionRelay({
        autoResponseTimeoutMs: 60000,
        defaultResponse: 'custom response',
      });

      expect(customRelay).toBeDefined();
    });
  });

  describe('cleanup', () => {
    it('should clean up without errors', () => {
      relay.cleanup('job-1');
    });

    it('should dispose without errors', () => {
      relay.dispose();
    });
  });
});
