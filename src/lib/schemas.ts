import { z } from 'zod';

export const JobSchema = z.object({
  id: z.string(),
  name: z.string(),
  worktreePath: z.string(),
  branch: z.string(),
  baseBranch: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'stopped']),
  prompt: z.string(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  planId: z.string().optional(),
  /** Session that launched the job; notifications are routed to it. */
  launchSessionID: z.string().optional(),
  /** The job's own OpenCode session, running in the job's worktree. */
  sessionID: z.string().optional(),
  agent: z.string().optional(),
  /** "provider/model" or "provider/model#variant". */
  model: z.string().optional(),
  /** Why the job failed (session failure, deleted session, interruption). */
  failureReason: z.string().optional(),
  /**
   * Paths (relative to the worktree) Mission Control itself put there during
   * setup: copied files and symlinked directories. They are not the job's work.
   */
  setupArtifacts: z.array(z.string()).optional(),
  /** When the job was asked to commit changes it left uncommitted (asked once). */
  commitPromptedAt: z.string().optional(),
  /** Files the job left uncommitted when it finished. */
  uncommittedChanges: z.array(z.string()).optional(),
  /** When the job was last told to continue after a server restart. */
  restartResumedAt: z.string().optional(),
});

export const JOB_STATE_VERSION = 4;

export const JobStateSchema = z.object({
  version: z.literal(JOB_STATE_VERSION),
  jobs: z.array(JobSchema),
  updatedAt: z.string(),
});

export const PlanStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'merging',
  'creating_pr',
  'completed',
  'failed',
  'canceled',
]);

export const CheckpointTypeSchema = z.enum(['pre_merge', 'on_error', 'pre_pr']);

export const JobStatusSchema = z.enum([
  'queued',
  'waiting_deps',
  'running',
  'completed',
  'failed',
  'ready_to_merge',
  'merging',
  'merged',
  'conflict',
  'needs_rebase',
  'stopped',
  'canceled',
]);

export const AuditActionSchema = z.enum(['skip_job', 'add_job', 'reorder_jobs', 'fork_session', 'relay_finding', 'fix_prompted']);

export const AuditLogEntrySchema = z.object({
  timestamp: z.string(),
  action: AuditActionSchema,
  jobName: z.string().optional(),
  details: z.record(z.string(), z.unknown()),
  userApproved: z.boolean().optional(),
});

export const PermissionPolicyDecisionSchema = z.enum(['auto-approve', 'deny', 'ask-user']);

export const PermissionPolicyScopeSchema = z.object({
  insideWorktree: PermissionPolicyDecisionSchema,
  outsideWorktree: PermissionPolicyDecisionSchema,
});

export const PermissionPolicySchema = z.object({
  permissions: z.object({
    fileEdit: PermissionPolicyScopeSchema,
    shellCommand: PermissionPolicyScopeSchema,
    networkAccess: PermissionPolicyDecisionSchema,
    installPackages: PermissionPolicyDecisionSchema,
    mcpTools: PermissionPolicyDecisionSchema,
  }),
});

export const JobSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  touchSet: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  priority: z.number().optional(),
  status: JobStatusSchema,
  branch: z.string().optional(),
  worktreePath: z.string().optional(),
  sessionID: z.string().optional(),
  mergeOrder: z.number().optional(),
  mergedAt: z.string().optional(),
  error: z.string().optional(),
  copyFiles: z.array(z.string()).optional(),
  symlinkDirs: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  relayPatterns: z.array(z.string()).optional(),
  launchSessionID: z.string().optional(),
  permissionPolicy: PermissionPolicySchema.optional(),
});

export const FailureKindSchema = z.enum([
  'touchset',
  'merge_conflict',
  'test_failure',
  'job_failed',
  'launch_failed',
  'uncommitted_changes',
]);

export const CheckpointContextSchema = z.object({
  jobName: z.string(),
  failureKind: FailureKindSchema,
  touchSetViolations: z.array(z.string()).optional(),
  touchSetPatterns: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

export const PlanSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: z.enum(['autopilot', 'copilot', 'supervisor']),
  baseBranch: z.string().optional(),
  status: PlanStatusSchema,
  jobs: z.array(JobSpecSchema),
  integrationBranch: z.string(),
  integrationWorktree: z.string().optional(),
  baseCommit: z.string(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  prUrl: z.string().optional(),
  checkpoint: CheckpointTypeSchema.nullable().optional(),
  checkpointContext: CheckpointContextSchema.nullable().optional(),
  ghAuthenticated: z.boolean().optional(),
  approvedMergeJobs: z.array(z.string()).optional(),
  approvedPrePr: z.boolean().optional(),
  failureReason: z.string().optional(),
  launchSessionID: z.string().optional(),
  model: z.string().optional(),
  auditLog: z.array(AuditLogEntrySchema).optional(),
  permissionPolicy: PermissionPolicySchema.optional(),
});

export const WorktreeSetupSchema = z.object({
  copyFiles: z.array(z.string()).optional(),
  symlinkDirs: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
});

export const MCConfigSchema = z.object({
  /** How often the monitor reconciles running jobs against their sessions. */
  pollInterval: z.number(),
  worktreeBasePath: z.string(),
  maxParallel: z.number().optional(),
  autoCommit: z.boolean().optional(),
  testCommand: z.string().optional(),
  testTimeout: z.number().optional(),
  mergeStrategy: z.enum(['squash', 'ff-only', 'merge']).optional(),
  worktreeSetup: WorktreeSetupSchema.optional(),
  allowUnsafeCommands: z.boolean().optional(),
  fixBeforeRollbackTimeout: z.number().optional(),
  defaultPermissionPolicy: PermissionPolicySchema.optional(),
  /** Agent used for jobs that do not specify one. */
  defaultAgent: z.string().optional(),
  /** Model ("provider/model" or "provider/model#variant") for jobs that do not specify one. */
  defaultModel: z.string().optional(),
});

// z.object strips unknown keys, so settings removed in 2.0 (defaultPlacement,
// useServeMode, portRangeStart, portRangeEnd, serverPassword, idleThreshold,
// omo) are ignored when they are still present in an existing config.json.
export const PartialMCConfigSchema = MCConfigSchema.partial();
