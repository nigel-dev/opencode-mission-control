import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Plugin } from '@opencode/plugin';
import type { Job } from '../../src/lib/job-state';
import * as configMod from '../../src/lib/config';
import { PermissionPolicy } from '../../src/lib/permission-policy';
import {
  buildPermissionRequest,
  installPermissionGate,
  PERMISSION_TIMEOUT_MESSAGE,
} from '../../src/lib/job-permissions';

interface Evaluation {
  sessionID: string;
  action: string;
  resources: string[];
  effect: 'allow' | 'deny' | 'ask';
  message?: string;
}

/** An async iterable fed by `push`, like the server's event stream. */
function channel() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  return {
    push(event: unknown) {
      queue.push(event);
      wake?.();
    },
    iterable(signal?: AbortSignal): AsyncIterable<unknown> {
      return {
        async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve;
                signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              continue;
            }
            yield queue.shift();
          }
        },
      };
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('permission gate', () => {
  const job: Job = {
    id: 'job-1',
    name: 'gate-job',
    worktreePath: '/wt/gate-job',
    branch: 'mc/gate-job',
    status: 'running',
    prompt: 'work',
    createdAt: new Date().toISOString(),
    sessionID: 'ses_job',
  };

  let evaluate: (event: Evaluation) => Promise<void>;
  let events: ReturnType<typeof channel>;
  let reply: ReturnType<typeof vi.fn>;
  let list: ReturnType<typeof vi.fn>;
  let ctx: Plugin.Context;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    vi.spyOn(configMod, 'loadConfig').mockResolvedValue({
      defaultPermissionPolicy: PermissionPolicy.getDefaultPolicy(),
    } as Awaited<ReturnType<typeof configMod.loadConfig>>);
    events = channel();
    reply = vi.fn(async () => {});
    list = vi.fn(async () => []);
    ctx = {
      permission: {
        hook: vi.fn(async (_name: string, callback: (event: Evaluation) => Promise<void>) => {
          evaluate = callback;
          return { dispose: async () => {} };
        }),
        reply,
        list,
      },
      event: {
        subscribe: vi.fn((options?: { signal?: AbortSignal }) => events.iterable(options?.signal)),
      },
    } as unknown as Plugin.Context;
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.restoreAllMocks();
  });

  const install = async (timeoutMs = 60_000, found: Job | null = job) => {
    dispose = await installPermissionGate(ctx, job.worktreePath, { timeoutMs, findJob: async () => found ?? undefined });
  };

  it('allows what the policy auto-approves, without asking anyone', async () => {
    await install();
    const event: Evaluation = { sessionID: 'ses_job', action: 'shell', resources: ['git status'], effect: 'ask' };

    await evaluate(event);

    expect(event.effect).toBe('allow');
  });

  it('denies what the policy denies, with its reason', async () => {
    await install();
    const event: Evaluation = { sessionID: 'ses_job', action: 'webfetch', resources: ['https://example.com'], effect: 'ask' };

    await evaluate(event);

    expect(event.effect).toBe('deny');
    expect(event.message).toContain("Mission Control's permission policy");
  });

  it("leaves the user's own allow and deny rules alone", async () => {
    await install();
    const allowed: Evaluation = { sessionID: 'ses_job', action: 'webfetch', resources: ['x'], effect: 'allow' };
    const denied: Evaluation = { sessionID: 'ses_job', action: 'shell', resources: ['git status'], effect: 'deny' };

    await evaluate(allowed);
    await evaluate(denied);

    expect(allowed.effect).toBe('allow');
    expect(denied.effect).toBe('deny');
  });

  it('does nothing when this worktree has no running job', async () => {
    await install(60_000, null);
    const event: Evaluation = { sessionID: 'ses_x', action: 'shell', resources: ['git status'], effect: 'ask' };

    await evaluate(event);

    expect(event.effect).toBe('ask');
  });

  it('asks the user, and denies the request when nobody answers in time', async () => {
    await install(30);
    const event: Evaluation = { sessionID: 'ses_job', action: 'shell', resources: ['bun add left-pad'], effect: 'ask' };

    await evaluate(event);
    expect(event.effect).toBe('ask');

    events.push({ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_job', action: 'shell', resources: ['bun add left-pad'] } });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(reply).toHaveBeenCalledWith({
      sessionID: 'ses_job',
      requestID: 'per_1',
      decision: 'reject',
      message: PERMISSION_TIMEOUT_MESSAGE,
    });
  });

  it('does not deny a request the user answered', async () => {
    await install(40);
    await evaluate({ sessionID: 'ses_job', action: 'shell', resources: ['bun add left-pad'], effect: 'ask' });

    events.push({ type: 'permission.asked', data: { id: 'per_2', sessionID: 'ses_job', action: 'shell', resources: ['bun add left-pad'] } });
    await settle();
    events.push({ type: 'permission.replied', data: { sessionID: 'ses_job', requestID: 'per_2' } });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(reply).not.toHaveBeenCalled();
  });

  it('never times out requests the policy did not leave for a human', async () => {
    await install(20);

    // Asked because of some other plugin or rule: not ours to deny.
    events.push({ type: 'permission.asked', data: { id: 'per_3', sessionID: 'ses_job', action: 'edit', resources: ['a.txt'] } });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(reply).not.toHaveBeenCalled();
  });

  it('denies a file request when any of its files is outside the worktree', async () => {
    await install();
    const event: Evaluation = {
      sessionID: 'ses_job',
      action: 'edit',
      resources: ['/wt/gate-job/safe.ts', '/etc/hosts'],
      effect: 'ask',
    };

    await evaluate(event);

    expect(event.effect).toBe('deny');
  });

  it('allows a file request only when every file is inside the worktree', async () => {
    await install();
    const event: Evaluation = { sessionID: 'ses_job', action: 'edit', resources: ['a.ts', 'src/b.ts'], effect: 'ask' };

    await evaluate(event);

    expect(event.effect).toBe('allow');
  });

  it('times out each of two identical requests asked at the same time', async () => {
    await install(30);
    const same = (): Evaluation => ({ sessionID: 'ses_job', action: 'shell', resources: ['bun add left-pad'], effect: 'ask' });
    await evaluate(same());
    await evaluate(same());

    events.push({ type: 'permission.asked', data: { id: 'per_a', sessionID: 'ses_job', action: 'shell', resources: ['bun add left-pad'] } });
    events.push({ type: 'permission.asked', data: { id: 'per_b', sessionID: 'ses_job', action: 'shell', resources: ['bun add left-pad'] } });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const denied = reply.mock.calls.map(([input]) => (input as { requestID: string }).requestID).sort();
    expect(denied).toEqual(['per_a', 'per_b']);
  });

  it('answers requests already pending when it loads (after a plugin reload)', async () => {
    list.mockResolvedValue([
      { id: 'per_ask', sessionID: 'ses_job', action: 'shell', resources: ['bun add left-pad'] },
      { id: 'per_ok', sessionID: 'ses_job', action: 'shell', resources: ['git status'] },
      { id: 'per_no', sessionID: 'ses_job', action: 'webfetch', resources: ['https://example.com'] },
    ]);

    await install(30);

    expect(list).toHaveBeenCalledWith({ sessionID: 'ses_job' });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ requestID: 'per_ok', decision: 'once' }));
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ requestID: 'per_no', decision: 'reject' }));
    expect(reply).not.toHaveBeenCalledWith(expect.objectContaining({ requestID: 'per_ask' }));

    // The request that needs a human gets a fresh timer.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(reply).toHaveBeenCalledWith({
      sessionID: 'ses_job',
      requestID: 'per_ask',
      decision: 'reject',
      message: PERMISSION_TIMEOUT_MESSAGE,
    });
  });

  it('stops its timers when the plugin unloads', async () => {
    await install(30);
    await evaluate({ sessionID: 'ses_job', action: 'shell', resources: ['bun add left-pad'], effect: 'ask' });
    events.push({ type: 'permission.asked', data: { id: 'per_4', sessionID: 'ses_job', action: 'shell', resources: ['bun add left-pad'] } });
    await settle();

    dispose?.();
    dispose = undefined;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(reply).not.toHaveBeenCalled();
  });
});

describe('buildPermissionRequest', () => {
  it('describes a shell request by its command, with no path', () => {
    const request = buildPermissionRequest({ id: 'p', action: 'shell', resources: ['rm -rf ~/x'] }, { worktreePath: '/wt' });

    expect(request).toMatchObject({ type: 'shell_command', command: 'rm -rf ~/x', path: undefined });
  });

  it("resolves a relative file path against the job's worktree", () => {
    const request = buildPermissionRequest({ id: 'p', action: 'edit', resources: ['src/a.ts'] }, { worktreePath: '/wt' });

    expect(request).toMatchObject({ type: 'file_operation', path: '/wt/src/a.ts' });
  });
});
