import { describe, expect, it } from 'bun:test';
import {
  PermissionPolicy,
  resolveAgainstWorktree,
  type PermissionPolicyConfig,
} from '../../src/lib/permission-policy';

const WORKTREE = '/tmp/project';

describe('PermissionPolicy', () => {
  it('default policy auto-approves worktree operations', () => {
    const policy = PermissionPolicy.loadPolicy(PermissionPolicy.getDefaultPolicy());

    const fileDecision = policy.evaluate(
      {
        type: 'file_operation',
        path: '/tmp/project/src/index.ts',
        description: 'edit file in worktree',
      },
      { worktreePath: WORKTREE },
    );

    const shellDecision = policy.evaluate(
      {
        type: 'shell_command',
        path: '/tmp/project',
        description: 'run build in worktree',
      },
      { worktreePath: WORKTREE },
    );

    expect(fileDecision).toBe('auto-approve');
    expect(shellDecision).toBe('auto-approve');
  });

  it('default policy denies outside worktree file operations', () => {
    const policy = PermissionPolicy.loadPolicy(PermissionPolicy.getDefaultPolicy());

    const decision = policy.evaluate(
      {
        type: 'file_operation',
        path: '/etc/passwd',
        description: 'edit outside worktree',
      },
      { worktreePath: WORKTREE },
    );

    expect(decision).toBe('deny');
  });

  it('per-job policy overrides global default', () => {
    const globalPolicy: PermissionPolicyConfig = {
      permissions: {
        fileEdit: { insideWorktree: 'auto-approve', outsideWorktree: 'deny' },
        shellCommand: { insideWorktree: 'auto-approve', outsideWorktree: 'ask-user' },
        networkAccess: 'deny',
        installPackages: 'ask-user',
        mcpTools: 'auto-approve',
      },
    };

    const perJobPolicy: PermissionPolicyConfig = {
      permissions: {
        fileEdit: { insideWorktree: 'auto-approve', outsideWorktree: 'deny' },
        shellCommand: { insideWorktree: 'deny', outsideWorktree: 'deny' },
        networkAccess: 'deny',
        installPackages: 'deny',
        mcpTools: 'auto-approve',
      },
    };

    const policy = PermissionPolicy.resolvePolicy({
      jobPolicy: perJobPolicy,
      globalPolicy,
    });

    const decision = policy.evaluate(
      {
        type: 'shell_command',
        path: '/tmp/project',
        description: 'run command in worktree',
      },
      { worktreePath: WORKTREE },
    );

    expect(decision).toBe('deny');
  });

  it('policy cascade applies job > plan > global > default priority', () => {
    const globalPolicy: PermissionPolicyConfig = {
      permissions: {
        fileEdit: { insideWorktree: 'deny', outsideWorktree: 'deny' },
        shellCommand: { insideWorktree: 'deny', outsideWorktree: 'deny' },
        networkAccess: 'deny',
        installPackages: 'deny',
        mcpTools: 'deny',
      },
    };

    const planPolicy: PermissionPolicyConfig = {
      permissions: {
        fileEdit: { insideWorktree: 'ask-user', outsideWorktree: 'deny' },
        shellCommand: { insideWorktree: 'ask-user', outsideWorktree: 'deny' },
        networkAccess: 'ask-user',
        installPackages: 'ask-user',
        mcpTools: 'ask-user',
      },
    };

    const jobPolicy: PermissionPolicyConfig = {
      permissions: {
        fileEdit: { insideWorktree: 'auto-approve', outsideWorktree: 'deny' },
        shellCommand: { insideWorktree: 'auto-approve', outsideWorktree: 'ask-user' },
        networkAccess: 'deny',
        installPackages: 'ask-user',
        mcpTools: 'auto-approve',
      },
    };

    const fromJob = PermissionPolicy.resolvePolicy({
      jobPolicy,
      planPolicy,
      globalPolicy,
    });
    const fromPlan = PermissionPolicy.resolvePolicy({
      planPolicy,
      globalPolicy,
    });
    const fromGlobal = PermissionPolicy.resolvePolicy({ globalPolicy });
    const fromDefault = PermissionPolicy.resolvePolicy({});

    expect(
      fromJob.evaluate(
        { type: 'mcp', description: 'execute mcp tool' },
        { worktreePath: WORKTREE },
      ),
    ).toBe('auto-approve');

    expect(
      fromPlan.evaluate(
        { type: 'mcp', description: 'execute mcp tool' },
        { worktreePath: WORKTREE },
      ),
    ).toBe('ask-user');

    expect(
      fromGlobal.evaluate(
        { type: 'mcp', description: 'execute mcp tool' },
        { worktreePath: WORKTREE },
      ),
    ).toBe('deny');

    expect(
      fromDefault.evaluate(
        { type: 'mcp', description: 'execute mcp tool' },
        { worktreePath: WORKTREE },
      ),
    ).toBe('auto-approve');
  });

  it('logs all policy decisions', () => {
    const policy = PermissionPolicy.resolvePolicy({});

    policy.evaluate(
      {
        type: 'file_operation',
        path: '/tmp/project/src/a.ts',
        description: 'edit a file',
        action: 'edit',
      },
      { worktreePath: WORKTREE },
    );

    policy.evaluate(
      {
        type: 'file_operation',
        path: '/etc/passwd',
        description: 'edit outside file',
        action: 'edit',
      },
      { worktreePath: WORKTREE },
    );

    const log = policy.getDecisionLog();
    expect(log.length).toBe(2);
    expect(typeof log[0].timestamp).toBe('string');
    expect(log[0].permissionType).toBe('fileEdit');
    expect(log[0].policyDecision).toBe('auto-approve');
    expect(log[1].policyDecision).toBe('deny');
    expect(log[1].reason.length).toBeGreaterThan(0);
  });

  describe('paths', () => {
    it("resolves a relative path against the worktree, not the process's working directory", () => {
      expect(resolveAgainstWorktree('src/index.ts', WORKTREE)).toBe('/tmp/project/src/index.ts');
      expect(resolveAgainstWorktree('./src/index.ts', WORKTREE)).toBe('/tmp/project/src/index.ts');
      expect(resolveAgainstWorktree('../other/file.ts', WORKTREE)).toBe('/tmp/other/file.ts');
      expect(resolveAgainstWorktree('/etc/hosts', WORKTREE)).toBe('/etc/hosts');
    });

    it('expands a home-relative path', () => {
      const resolved = resolveAgainstWorktree('~/.ssh/id_rsa', WORKTREE);

      expect(resolved.endsWith('/.ssh/id_rsa')).toBe(true);
      expect(resolved.startsWith('/tmp/project')).toBe(false);
    });

    it('treats a relative file path as inside the worktree and one that climbs out as outside', () => {
      const policy = PermissionPolicy.loadPolicy(PermissionPolicy.getDefaultPolicy());

      expect(policy.evaluate({ type: 'file_operation', path: 'src/index.ts' }, { worktreePath: WORKTREE })).toBe(
        'auto-approve',
      );
      expect(policy.evaluate({ type: 'file_operation', path: '../../etc/hosts' }, { worktreePath: WORKTREE })).toBe(
        'deny',
      );
      expect(policy.evaluate({ type: 'file_operation', path: '/tmp/project-evil/x.ts' }, { worktreePath: WORKTREE })).toBe(
        'deny',
      );
    });
  });

  describe('shell commands', () => {
    const policy = (): PermissionPolicy => PermissionPolicy.loadPolicy(PermissionPolicy.getDefaultPolicy());

    it('decides a command without a working directory by the rule for commands run from the worktree', () => {
      const decided = policy();

      expect(decided.evaluate({ type: 'shell_command', command: 'rm -rf /etc' }, { worktreePath: WORKTREE })).toBe(
        'auto-approve',
      );
      expect(decided.getDecisionLog().at(-1)).toMatchObject({
        permissionType: 'shellCommand',
        reason: 'Shell command target is inside worktree',
        target: 'rm -rf /etc',
      });
    });

    it('still honours an explicit working directory outside the worktree', () => {
      expect(
        policy().evaluate({ type: 'shell_command', command: 'ls', path: '/var/log' }, { worktreePath: WORKTREE }),
      ).toBe('ask-user');
    });

    it('recognizes a package install from the command line itself', () => {
      const decided = policy();

      expect(
        decided.evaluate(
          { type: 'shell_command', command: 'bun add left-pad', description: 'Run a command', action: 'bash' },
          { worktreePath: WORKTREE },
        ),
      ).toBe('ask-user');
      expect(decided.getDecisionLog().at(-1)?.permissionType).toBe('installPackages');
    });
  });
});
