import { z } from 'zod';

export const JobSchema = z.object({
  id: z.string(),
  name: z.string(),
  worktreePath: z.string(),
  branch: z.string(),
  baseBranch: z.string().optional(),
  tmuxTarget: z.string(),
  placement: z.enum(['session', 'window']),
  status: z.enum(['running', 'completed', 'failed', 'stopped']),
  prompt: z.string(),
  mode: z.enum(['vanilla', 'plan', 'ralph', 'ulw']),
  planFile: z.string().optional(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  exitCode: z.number().optional(),
  planId: z.string().optional(),
});

export const JobStateSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
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
  tmuxTarget: z.string().optional(),
  mergeOrder: z.number().optional(),
  mergedAt: z.string().optional(),
  error: z.string().optional(),
  copyFiles: z.array(z.string()).optional(),
  symlinkDirs: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
});

export const PlanSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: z.enum(['autopilot', 'copilot', 'supervisor']),
  placement: z.enum(['session', 'window']).optional(),
  status: PlanStatusSchema,
  jobs: z.array(JobSpecSchema),
  integrationBranch: z.string(),
  integrationWorktree: z.string().optional(),
  baseCommit: z.string(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  prUrl: z.string().optional(),
  checkpoint: CheckpointTypeSchema.nullable().optional(),
  ghAuthenticated: z.boolean().optional(),
});

export const WorktreeSetupSchema = z.object({
  copyFiles: z.array(z.string()).optional(),
  symlinkDirs: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
});

export const OmoConfigSchema = z.object({
  enabled: z.boolean(),
  defaultMode: z.enum(['vanilla', 'plan', 'ralph', 'ulw']),
});

export const MCConfigSchema = z.object({
  defaultPlacement: z.enum(['session', 'window']),
  pollInterval: z.number(),
  idleThreshold: z.number(),
  worktreeBasePath: z.string(),
  maxParallel: z.number().optional(),
  autoCommit: z.boolean().optional(),
  testCommand: z.string().optional(),
  testTimeout: z.number().optional(),
  mergeStrategy: z.enum(['squash', 'ff-only', 'merge']).optional(),
  worktreeSetup: WorktreeSetupSchema.optional(),
  allowUnsafeCommands: z.boolean().optional(),
  omo: OmoConfigSchema,
});

export const PartialMCConfigSchema = MCConfigSchema.partial().extend({
  omo: OmoConfigSchema.partial().optional(),
});
