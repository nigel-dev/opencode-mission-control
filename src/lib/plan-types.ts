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
  placement?: 'session' | 'window';
  status: PlanStatus;
  jobs: JobSpec[];
  integrationBranch: string;
  integrationWorktree?: string;
  baseCommit: string; // SHA of main when plan started
  createdAt: string;
  completedAt?: string;
  prUrl?: string;
  checkpoint?: CheckpointType | null;
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
  tmuxTarget?: string;
  mergeOrder?: number;
  mergedAt?: string;
  error?: string;
  copyFiles?: string[];
  symlinkDirs?: string[];
  commands?: string[];
}

export const VALID_PLAN_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  pending: ['running', 'failed', 'canceled'],
  running: ['paused', 'merging', 'failed', 'canceled'],
  paused: ['running', 'failed', 'canceled'],
  merging: ['running', 'paused', 'creating_pr', 'failed', 'canceled'],
  creating_pr: ['completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

export const VALID_JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ['waiting_deps', 'running', 'stopped', 'canceled'],
  waiting_deps: ['running', 'stopped', 'canceled'],
  running: ['completed', 'failed', 'stopped', 'canceled'],
  completed: ['ready_to_merge', 'stopped', 'canceled'],
  failed: ['ready_to_merge', 'stopped', 'canceled'],
  ready_to_merge: ['merging', 'stopped', 'canceled'],
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
