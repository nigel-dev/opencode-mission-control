import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';

// Pure contract module shared by the server part and the TUI part: it may only
// import `@opencode/plugin/rpc` and `zod`.

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  title?: string;
  message: string;
  variant?: ToastVariant;
  duration?: number;
}

const jobView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'stopped']),
  attention: z.enum(['none', 'blocked', 'needs_review', 'question']),
  branch: z.string(),
  worktreePath: z.string(),
  sessionID: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  planId: z.string().optional(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  /** Something to know about a finished job: why it failed, or that it left uncommitted changes. */
  note: z.string().optional(),
  report: z
    .object({
      status: z.string(),
      message: z.string(),
      progress: z.number().optional(),
    })
    .optional(),
  activity: z
    .object({
      currentTool: z.string().optional(),
      currentFile: z.string().optional(),
      filesEdited: z.number(),
    })
    .optional(),
});

const planView = z.object({
  id: z.string(),
  name: z.string(),
  mode: z.string(),
  status: z.string(),
  checkpoint: z.string().optional(),
  checkpointMessage: z.string().optional(),
  prUrl: z.string().optional(),
  failureReason: z.string().optional(),
  jobs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      dependsOn: z.array(z.string()),
    }),
  ),
});

const counts = z.object({
  running: z.number(),
  blocked: z.number(),
  completed: z.number(),
  failed: z.number(),
  stopped: z.number(),
});

const snapshot = z.object({
  jobs: z.array(jobView),
  plan: planView.nullable(),
  counts,
  /**
   * Directory of the plugin instance that owns this project's jobs. A client
   * whose location is a job worktree gets an empty snapshot and should ask
   * this directory instead.
   */
  home: z.string().optional(),
});

const attentionEvent = z.object({
  kind: z.enum(['complete', 'failed', 'blocked', 'needs_review', 'question', 'checkpoint']),
  title: z.string(),
  message: z.string(),
  jobName: z.string().optional(),
  sessionID: z.string().optional(),
});

const openEvent = z.object({
  sessionID: z.string(),
  title: z.string().optional(),
});

export type JobView = z.infer<typeof jobView>;
export type JobStatusView = JobView['status'];
export type JobAttention = JobView['attention'];
export type PlanView = z.infer<typeof planView>;
export type PlanJobView = PlanView['jobs'][number];
export type SnapshotCounts = z.infer<typeof counts>;
export type Snapshot = z.infer<typeof snapshot>;
export type AttentionEvent = z.infer<typeof attentionEvent>;
export type AttentionKind = AttentionEvent['kind'];
export type OpenEvent = z.infer<typeof openEvent>;

const outputEvent = z.object({
  title: z.string(),
  content: z.string(),
  sessionID: z.string().optional(),
});
export type OutputEvent = z.infer<typeof outputEvent>;
export type ActionResult = { content: string };

// Every action returns the text its tool produced, and reports expected
// failures (unknown job, job not running, ...) as the declared `failed` error.
const output = z.object({ content: z.string() });
const errors = { failed: z.object({ message: z.string() }) };

export const missionControlRpc = Rpc.define({
  id: 'opencode-mission-control',
  methods: {
    snapshot: {
      input: z.object({}),
      output: snapshot,
    },
    kill: {
      input: z.object({ name: z.string() }),
      output,
      errors,
    },
    cleanup: {
      input: z.object({
        name: z.string().optional(),
        all: z.boolean().optional(),
        deleteBranch: z.boolean().optional(),
        force: z.boolean().optional(),
      }),
      output,
      errors,
    },
    answer: {
      input: z.object({ name: z.string(), response: z.string() }),
      output,
      errors,
    },
    approve: {
      input: z.object({
        checkpoint: z.enum(['pre_merge', 'on_error', 'pre_pr']).optional(),
      }),
      output,
      errors,
    },
    cancelPlan: {
      input: z.object({}),
      output,
      errors,
    },
    capture: {
      input: z.object({ name: z.string(), lines: z.number().optional() }),
      output,
      errors,
    },
    launch: {
      input: z.object({
        name: z.string(),
        prompt: z.string(),
        agent: z.string().optional(),
        model: z.string().optional(),
        baseBranch: z.string().optional(),
      }),
      output,
      errors,
    },
  },
  events: {
    toast: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          message: { type: 'string' },
          variant: {
            type: 'string',
            enum: ['info', 'success', 'warning', 'error'],
          },
          duration: { type: 'number' },
        },
        required: ['message'],
        additionalProperties: false,
      },
    },
    /** Job or plan state changed; clients refetch `snapshot`. */
    changed: {
      schema: z.object({ reason: z.string() }),
    },
    /** Something needs the user's attention. */
    attention: {
      schema: attentionEvent,
    },
    /** Ask the TUI to open or focus a session's tab. */
    open: {
      schema: openEvent,
    },
    /** Show the text output of a slash command to the user who ran it. */
    output: {
      schema: outputEvent,
    },
  },
});
