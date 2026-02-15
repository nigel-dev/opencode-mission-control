import { resolve } from 'path';

export type PermissionPolicyDecision = 'auto-approve' | 'deny' | 'ask-user';

export type PolicyScopedRule = {
  insideWorktree: PermissionPolicyDecision;
  outsideWorktree: PermissionPolicyDecision;
};

export type PermissionPolicyConfig = {
  permissions: {
    fileEdit: PolicyScopedRule;
    shellCommand: PolicyScopedRule;
    networkAccess: PermissionPolicyDecision;
    installPackages: PermissionPolicyDecision;
    mcpTools: PermissionPolicyDecision;
  };
};

export type PermissionPolicyRequest = {
  type: 'file_operation' | 'shell_command' | 'network' | 'mcp' | 'other';
  path?: string;
  description?: string;
  action?: string;
  target?: string;
};

export type PermissionJobContext = {
  worktreePath: string;
};

export type PermissionPolicyLogEntry = {
  timestamp: string;
  permissionType: keyof PermissionPolicyConfig['permissions'] | 'unknown';
  action: string;
  target: string;
  policyDecision: PermissionPolicyDecision;
  reason: string;
};

export type PermissionPolicySources = {
  jobPolicy?: PermissionPolicyConfig;
  planPolicy?: PermissionPolicyConfig;
  globalPolicy?: PermissionPolicyConfig;
};

function normalizePathForComparison(path: string): string {
  return resolve(path).replace(/\\/g, '/');
}

function isInsideWorktree(path: string, worktreePath: string): boolean {
  const normalizedPath = normalizePathForComparison(path);
  const normalizedWorktree = normalizePathForComparison(worktreePath);

  if (normalizedPath === normalizedWorktree) {
    return true;
  }

  const suffix = normalizedWorktree.endsWith('/') ? '' : '/';
  return normalizedPath.startsWith(`${normalizedWorktree}${suffix}`);
}

function looksLikePackageInstall(input?: string): boolean {
  if (!input) {
    return false;
  }

  const normalized = input.toLowerCase();
  const installSignals = ['npm install', 'pnpm add', 'yarn add', 'bun add', 'pip install', 'apt install'];
  return installSignals.some((signal) => normalized.includes(signal));
}

export class PermissionPolicy {
  private readonly policy: PermissionPolicyConfig;
  private readonly decisionLog: PermissionPolicyLogEntry[] = [];

  constructor(policy: PermissionPolicyConfig = PermissionPolicy.getDefaultPolicy()) {
    this.policy = policy;
  }

  static loadPolicy(config?: PermissionPolicyConfig | null): PermissionPolicy {
    if (!config) {
      return new PermissionPolicy(PermissionPolicy.getDefaultPolicy());
    }
    return new PermissionPolicy(config);
  }

  static resolvePolicy(sources: PermissionPolicySources = {}): PermissionPolicy {
    return PermissionPolicy.loadPolicy(
      sources.jobPolicy
      ?? sources.planPolicy
      ?? sources.globalPolicy
      ?? PermissionPolicy.getDefaultPolicy(),
    );
  }

  static getDefaultPolicy(): PermissionPolicyConfig {
    return {
      permissions: {
        fileEdit: { insideWorktree: 'auto-approve', outsideWorktree: 'deny' },
        shellCommand: { insideWorktree: 'auto-approve', outsideWorktree: 'ask-user' },
        networkAccess: 'deny',
        installPackages: 'ask-user',
        mcpTools: 'auto-approve',
      },
    };
  }

  evaluate(
    permissionRequest: PermissionPolicyRequest,
    jobContext: PermissionJobContext,
  ): PermissionPolicyDecision {
    const permissionType = this.resolvePermissionType(permissionRequest);

    let policyDecision: PermissionPolicyDecision;
    let reason: string;

    switch (permissionType) {
      case 'fileEdit': {
        const targetPath = permissionRequest.path;
        if (!targetPath) {
          policyDecision = 'ask-user';
          reason = 'File edit request is missing path context';
          break;
        }

        const inWorktree = isInsideWorktree(targetPath, jobContext.worktreePath);
        policyDecision = inWorktree
          ? this.policy.permissions.fileEdit.insideWorktree
          : this.policy.permissions.fileEdit.outsideWorktree;
        reason = inWorktree
          ? 'File edit target is inside worktree'
          : 'File edit target is outside worktree';
        break;
      }

      case 'shellCommand': {
        const targetPath = permissionRequest.path ?? jobContext.worktreePath;
        const inWorktree = isInsideWorktree(targetPath, jobContext.worktreePath);
        policyDecision = inWorktree
          ? this.policy.permissions.shellCommand.insideWorktree
          : this.policy.permissions.shellCommand.outsideWorktree;
        reason = inWorktree
          ? 'Shell command target is inside worktree'
          : 'Shell command target is outside worktree';
        break;
      }

      case 'installPackages':
        policyDecision = this.policy.permissions.installPackages;
        reason = 'Package installation request';
        break;

      case 'networkAccess':
        policyDecision = this.policy.permissions.networkAccess;
        reason = 'Network access request';
        break;

      case 'mcpTools':
        policyDecision = this.policy.permissions.mcpTools;
        reason = 'MCP tool request';
        break;

      default:
        policyDecision = 'ask-user';
        reason = 'Unknown permission type';
        break;
    }

    const action = permissionRequest.action ?? permissionRequest.description ?? permissionRequest.type;
    const target = permissionRequest.target ?? permissionRequest.path ?? '(unknown target)';

    this.decisionLog.push({
      timestamp: new Date().toISOString(),
      permissionType,
      action,
      target,
      policyDecision,
      reason,
    });

    return policyDecision;
  }

  getDecisionLog(): readonly PermissionPolicyLogEntry[] {
    return this.decisionLog;
  }

  private resolvePermissionType(
    permissionRequest: PermissionPolicyRequest,
  ): keyof PermissionPolicyConfig['permissions'] | 'unknown' {
    if (permissionRequest.type === 'mcp') {
      return 'mcpTools';
    }

    if (permissionRequest.type === 'network') {
      return 'networkAccess';
    }

    if (permissionRequest.type === 'file_operation') {
      return 'fileEdit';
    }

    if (permissionRequest.type === 'shell_command') {
      const packageInstall =
        looksLikePackageInstall(permissionRequest.description) ||
        looksLikePackageInstall(permissionRequest.action);
      return packageInstall ? 'installPackages' : 'shellCommand';
    }

    return 'unknown';
  }
}
