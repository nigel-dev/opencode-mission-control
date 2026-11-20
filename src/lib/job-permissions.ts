import type { Plugin } from '@opencode/plugin';
import { loadConfig } from './config';
import { loadJobState, type Job } from './job-state';
import { loadPlan } from './plan-state';
import { canonicalPath } from './paths';
import { bindToProject } from './project-context';
import {
  PermissionPolicy,
  resolveAgainstWorktree,
  type PermissionPolicyConfig,
  type PermissionPolicyDecision,
} from './permission-policy';
import type { PermissionRequest } from './question-relay';

/** How long a permission request that needs a human may stay unanswered before it is denied. */
export const PERMISSION_ANSWER_TIMEOUT_MS = 120_000;

export const PERMISSION_TIMEOUT_MESSAGE =
  'No one answered this permission request in time, so it was denied. Continue without it or report blocked.';

/** The fields of a permission request (or evaluation) the policy looks at. */
export interface PermissionData {
  id?: unknown;
  action?: unknown;
  message?: unknown;
  metadata?: unknown;
  resources?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function extractString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function inferPermissionType(data: PermissionData): PermissionRequest['type'] {
  const metadata = asRecord(data.metadata);
  const typeHint = String(data.action || metadata?.type || '').toLowerCase();

  if (typeHint.includes('mcp') || typeHint.includes('tool')) {
    return 'mcp';
  }
  if (typeHint.includes('network') || typeHint.includes('http') || typeHint.includes('fetch') || typeHint.includes('web')) {
    return 'network';
  }
  if (typeHint.includes('shell') || typeHint.includes('command') || typeHint.includes('exec') || typeHint.includes('bash')) {
    return 'shell_command';
  }
  if (typeHint.includes('file') || typeHint.includes('write') || typeHint.includes('edit') || typeHint === 'read') {
    return 'file_operation';
  }

  return 'other';
}

/**
 * The file a file-operation request targets, absolute. Relative paths are
 * relative to the job's worktree, where its tools run.
 */
function extractFilePath(data: PermissionData, worktreePath: string): string | undefined {
  const firstResource: unknown = Array.isArray(data.resources) ? data.resources[0] : undefined;
  const raw = extractString(firstResource) ?? extractString(asRecord(data.metadata)?.path);
  return raw ? resolveAgainstWorktree(raw, worktreePath) : undefined;
}

export function buildPermissionRequest(data: PermissionData, job: Pick<Job, 'worktreePath'>): PermissionRequest {
  const rawType = extractString(data.action) || 'unknown';
  const type = inferPermissionType(data);
  // Only file operations have a path. A shell request's resources are its
  // command line; no path is ever derived from that.
  const path = type === 'file_operation' ? extractFilePath(data, job.worktreePath) : undefined;
  const command =
    type === 'shell_command' && Array.isArray(data.resources)
      ? data.resources.filter((resource): resource is string => typeof resource === 'string').join(' ') || undefined
      : undefined;
  const description = extractString(data.message) || (command ? `Run: ${command}` : `Permission request: ${rawType}`);

  return {
    id: String(data.id ?? ''),
    type,
    path,
    target: path ?? command,
    action: rawType,
    rawType,
    description,
    command,
  };
}

export async function resolvePolicyForJob(job: Pick<Job, 'name' | 'planId'>): Promise<PermissionPolicy> {
  const config = await loadConfig();
  let planPolicy: PermissionPolicyConfig | undefined;
  let jobPolicy: PermissionPolicyConfig | undefined;

  if (job.planId) {
    const plan = await loadPlan();
    if (plan && plan.id === job.planId) {
      planPolicy = plan.permissionPolicy;
      jobPolicy = plan.jobs.find((planJob) => planJob.name === job.name)?.permissionPolicy;
    }
  }

  return PermissionPolicy.resolvePolicy({ jobPolicy, planPolicy, globalPolicy: config.defaultPermissionPolicy });
}

export interface PermissionVerdict {
  decision: PermissionPolicyDecision;
  reason: string;
  request: PermissionRequest;
}

/**
 * What the job's permission policy says about a request OpenCode wants a human
 * for. A file request can name several files: each is judged on its own, and
 * the strictest answer wins (any denied file denies the request, any file that
 * needs a human asks), so a safe first file cannot carry an unsafe second one.
 */
export async function decidePermission(job: Job, data: PermissionData): Promise<PermissionVerdict> {
  const policy = await resolvePolicyForJob(job);
  const judge = (item: PermissionData): PermissionVerdict => {
    const request = buildPermissionRequest(item, job);
    const decision = policy.evaluate(request, { worktreePath: job.worktreePath });
    const log = policy.getDecisionLog();
    return { decision, reason: log[log.length - 1]?.reason ?? 'Permission decision from policy', request };
  };

  const resources = Array.isArray(data.resources)
    ? data.resources.filter((resource): resource is string => typeof resource === 'string')
    : [];
  if (inferPermissionType(data) !== 'file_operation' || resources.length <= 1) {
    return judge(data);
  }

  const verdicts = resources.map((resource) => judge({ ...data, resources: [resource] }));
  const strictest =
    verdicts.find((verdict) => verdict.decision === 'deny') ??
    verdicts.find((verdict) => verdict.decision === 'ask-user') ??
    verdicts[0];
  return { ...strictest, request: { ...strictest.request, id: String(data.id ?? '') } };
}

function requestKey(sessionID: string, action: unknown, resources: unknown): string {
  return `${sessionID}\u0000${String(action)}\u0000${Array.isArray(resources) ? resources.join('\u0000') : ''}`;
}

export interface PermissionGateOptions {
  timeoutMs?: number;
  /** Test seam: the running job for this worktree. */
  findJob?: () => Promise<Job | undefined>;
}

/**
 * Apply the job's permission policy inside the job's own location.
 *
 * A plugin context reaches only its own location, and a job runs in its
 * worktree: the command center's instance cannot answer a job's permission
 * requests ("not found"). The plugin instance loaded in the worktree can, and
 * it can do better than answering: its `evaluate` hook decides before anyone
 * is asked. The policy only applies where OpenCode's own rules want a human
 * (`ask`); an `allow` or `deny` from the user's rules is left alone.
 *
 *  - auto-approve: the request is allowed without a prompt;
 *  - deny: it is denied with the policy's reason, which the agent sees;
 *  - ask-user: it is asked as usual (the command center relays it to the
 *    user), and denied if nobody answers within the timeout.
 */
export async function installPermissionGate(
  ctx: Plugin.Context,
  worktreePath: string,
  options: PermissionGateOptions = {},
): Promise<() => void> {
  const timeoutMs = options.timeoutMs ?? PERMISSION_ANSWER_TIMEOUT_MS;
  const home = canonicalPath(worktreePath);
  const findJob =
    options.findJob ??
    (async () =>
      (await loadJobState()).jobs.find(
        (job) => job.status === 'running' && canonicalPath(job.worktreePath) === home,
      ));

  // Requests the policy left for a human, until OpenCode announces them. A
  // count, not a set: two identical requests can be in flight at once.
  const awaitingAsk = new Map<string, number>();
  const expectAsk = (key: string) => awaitingAsk.set(key, (awaitingAsk.get(key) ?? 0) + 1);
  const takeAsk = (key: string): boolean => {
    const count = awaitingAsk.get(key) ?? 0;
    if (count === 0) return false;
    if (count === 1) awaitingAsk.delete(key);
    else awaitingAsk.set(key, count - 1);
    return true;
  };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  // The host calls hooks from its own context: re-enter this project's.
  await ctx.permission.hook('evaluate', bindToProject(async (event) => {
    if (event.effect !== 'ask') {
      return;
    }
    const job = await findJob();
    if (!job) {
      return;
    }
    const verdict = await decidePermission(job, event);
    if (verdict.decision === 'auto-approve') {
      event.effect = 'allow';
    } else if (verdict.decision === 'deny') {
      event.effect = 'deny';
      event.message = `Denied by Mission Control's permission policy: ${verdict.reason}`;
    } else {
      expectAsk(requestKey(event.sessionID, event.action, event.resources));
    }
  }));

  const armTimer = (sessionID: string, requestID: string): void => {
    if (timers.has(requestID)) {
      return;
    }
    timers.set(
      requestID,
      setTimeout(() => {
        timers.delete(requestID);
        ctx.permission
          .reply({ sessionID, requestID, decision: 'reject', message: PERMISSION_TIMEOUT_MESSAGE })
          .catch((error: unknown) => {
            // Usually the request was answered (or the session ended) meanwhile.
            console.warn(`[Mission Control] Could not deny unanswered permission ${requestID}:`, error);
          });
      }, timeoutMs),
    );
  };

  const controller = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({
      types: ['permission.asked', 'permission.replied'],
      signal: controller.signal,
    })) {
      if (event.type === 'permission.replied') {
        const requestID = String(event.data.requestID);
        const timer = timers.get(requestID);
        if (timer) {
          clearTimeout(timer);
          timers.delete(requestID);
        }
        continue;
      }
      const data = event.data;
      const key = requestKey(String(data.sessionID), data.action, data.resources);
      if (!takeAsk(key)) {
        continue;
      }
      armTimer(String(data.sessionID), String(data.id));
    }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) {
      console.warn('[Mission Control] Permission gate stopped listening for permission requests:', error);
    }
  });

  // Requests already pending when this instance loaded (a plugin reload drops
  // the previous instance's timers) get the policy's answer now. Their clock
  // restarts: the original deadline is not recorded anywhere.
  await reconcilePending(ctx, findJob, armTimer).catch((error: unknown) => {
    console.warn('[Mission Control] Could not check pending permission requests after loading:', error);
  });

  return () => {
    controller.abort();
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    awaitingAsk.clear();
  };
}

async function reconcilePending(
  ctx: Plugin.Context,
  findJob: () => Promise<Job | undefined>,
  armTimer: (sessionID: string, requestID: string) => void,
): Promise<void> {
  const job = await findJob();
  if (!job?.sessionID) {
    return;
  }
  for (const request of await ctx.permission.list({ sessionID: job.sessionID })) {
    const verdict = await decidePermission(job, request);
    if (verdict.decision === 'ask-user') {
      armTimer(request.sessionID, request.id);
      continue;
    }
    await ctx.permission.reply({
      sessionID: request.sessionID,
      requestID: request.id,
      decision: verdict.decision === 'auto-approve' ? 'once' : 'reject',
      message:
        verdict.decision === 'auto-approve'
          ? `Approved by Mission Control's permission policy: ${verdict.reason}`
          : `Denied by Mission Control's permission policy: ${verdict.reason}`,
    });
  }
}
