import type { PermissionPolicyConfig } from './permission-policy';

export type PlanStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'merging'
  | 'creating_pr'
  | 'completed'
  | 'failed'
  | 'canceled';

export type CheckpointType = 'pre_merge' | 'on_error' | 'pre_pr';

export type FailureKind =
  | 'touchset'
  | 'merge_conflict'
  | 'test_failure'
  | 'job_failed'
  | 'launch_failed'
  | 'uncommitted_changes';

export interface CheckpointContext {
  jobName: string;
  failureKind: FailureKind;
  touchSetViolations?: string[];
  touchSetPatterns?: string[];
  /** Why the job failed, in words (launch error, session failure, ...). */
  reason?: string;
}

/** Kept so plan files written by earlier releases still load; nothing writes audit entries now. */
export type AuditAction = 'skip_job' | 'add_job' | 'reorder_jobs' | 'fork_session' | 'relay_finding' | 'fix_prompted';

export interface AuditLogEntry {
  timestamp: string;
  action: AuditAction;
  jobName?: string;
  details: Record<string, unknown>;
  userApproved?: boolean;
}

export type JobStatus =
  | 'queued'
  | 'waiting_deps'
  | 'running'
  | 'completed'
  | 'failed'
  | 'ready_to_merge'
  | 'merging'
  | 'merged'
  | 'conflict'
  | 'needs_rebase'
  | 'stopped'
  | 'canceled';

export interface PlanSpec {
  id: string;
  name: string;
  mode: 'autopilot' | 'copilot' | 'supervisor';
  baseBranch?: string;
  status: PlanStatus;
  jobs: JobSpec[];
  integrationBranch: string;
  integrationWorktree?: string;
  baseCommit: string;
  createdAt: string;
  completedAt?: string;
  prUrl?: string;
  checkpoint?: CheckpointType | null;
  checkpointContext?: CheckpointContext | null;
  launchSessionID?: string;
  /**
   * Model ("provider/model" or "provider/model#variant") of the session that
   * created the plan. Jobs that name no model use it, also after a restart.
   */
  model?: string;
  auditLog?: AuditLogEntry[];
  permissionPolicy?: PermissionPolicyConfig;
  ghAuthenticated?: boolean;
  /**
   * Supervisor-mode approvals persisted across orchestrator instances.
   * `mc_plan_approve` runs in a fresh process, so in-memory approval sets are
   * lost between checkpoints; these fields keep the decision on disk.
   */
  approvedMergeJobs?: string[];
  approvedPrePr?: boolean;
  /** Why the plan as a whole failed (for example the push or `gh pr create` error). */
  failureReason?: string;
}

export interface JobSpec {
  id: string;
  name: string;
  prompt: string;
  touchSet?: string[];
  dependsOn?: string[];
  priority?: number;
  status: JobStatus;
  branch?: string;
  worktreePath?: string;
  /**
   * The job's own OpenCode session. When set, the merge train prompts it to fix
   * failing tests before rolling a merge back (`fixBeforeRollbackTimeout`).
   * The orchestrator does not populate it, which keeps fix-before-rollback off
   * for plan jobs exactly as it was when jobs ran in tmux.
   */
  sessionID?: string;
  mergeOrder?: number;
  mergedAt?: string;
  error?: string;
  copyFiles?: string[];
  symlinkDirs?: string[];
  commands?: string[];
  /** Agent for this job (defaults to the `defaultAgent` config). */
  agent?: string;
  /** "provider/model" or "provider/model#variant" (defaults to the plan's model). */
  model?: string;
  relayPatterns?: string[];
  launchSessionID?: string;
  permissionPolicy?: PermissionPolicyConfig;
}

export const VALID_PLAN_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  pending: ['running', 'failed', 'canceled'],
  running: ['paused', 'merging', 'creating_pr', 'completed', 'failed', 'canceled'],
  paused: ['running', 'failed', 'canceled'],
  merging: ['running', 'paused', 'creating_pr', 'failed', 'canceled'],
  creating_pr: ['running', 'completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

export const VALID_JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ['waiting_deps', 'running', 'stopped', 'canceled'],
  waiting_deps: ['running', 'stopped', 'canceled'],
  running: ['completed', 'failed', 'stopped', 'canceled'],
  completed: ['ready_to_merge', 'failed', 'stopped', 'canceled'],
  failed: ['ready_to_merge', 'queued', 'running', 'stopped', 'canceled'],
  ready_to_merge: ['merging', 'needs_rebase', 'stopped', 'canceled'],
  merging: ['merged', 'conflict', 'stopped', 'canceled'],
  merged: ['needs_rebase'],
  conflict: ['ready_to_merge', 'stopped', 'canceled'],
  needs_rebase: ['ready_to_merge', 'stopped', 'canceled'],
  stopped: [],
  canceled: [],
};

export function isValidPlanTransition(from: PlanStatus, to: PlanStatus): boolean {
  return VALID_PLAN_TRANSITIONS[from].includes(to);
}

export function isValidJobTransition(from: JobStatus, to: JobStatus): boolean {
  return VALID_JOB_TRANSITIONS[from].includes(to);
}
