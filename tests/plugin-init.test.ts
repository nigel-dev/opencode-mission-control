import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Plugin } from '@opencode/plugin';

const mockState = { isManaged: false };
import * as worktree from '../src/lib/worktree';
import * as jobRuntime from '../src/lib/job-runtime';
import * as orchestrator from '../src/lib/orchestrator-singleton';
import * as notifications from '../src/hooks/notifications';
import * as planState from '../src/lib/plan-state';
import * as jobState from '../src/lib/job-state';
import { getProjectDirectory, runInProject } from '../src/lib/project-context';
import { CHANGED_DEBOUNCE_MS, hasRpcEventEmitter } from '../src/lib/rpc-events';
import { showToast } from '../src/lib/toast';
import * as modelTracker from '../src/lib/model-tracker';
import * as configMod from '../src/lib/config';
import { Orchestrator } from '../src/lib/orchestrator';
import { mc_kill } from '../src/tools/kill';
import { mc_jobs } from '../src/tools/jobs';

// The real host replays transform callbacks from its own async context, not the
// plugin's; simulate that so tools and commands must bind their own directory.
const HOST_CONTEXT = '/tmp/mc-host-context';

const mockMonitor = {
  start: vi.fn(),
  on: vi.fn(),
};

interface AddedTool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

type RpcHandler = (input: unknown, context: unknown) => Promise<unknown>;

interface MockContext {
  ctx: Plugin.Context;
  addedTools: AddedTool[];
  addedCommands: unknown[];
  /** Events emitted through the RPC registration, as [name, data]. */
  emitted: Array<[string, unknown]>;
  /** The handlers passed to ctx.rpc.register. */
  rpcHandlers: () => Record<string, RpcHandler>;
}

const createMockContext = (directory: string = process.cwd()): MockContext => {
  const addedTools: AddedTool[] = [];
  const addedCommands: unknown[] = [];
  const emitted: Array<[string, unknown]> = [];
  let registeredHandlers: Record<string, RpcHandler> = {};

  const ctx = {
    session: {
      list: vi.fn(async () => ({ data: [], cursor: {} })),
      get: vi.fn(async () => ({ id: 'ses_test', projectID: 'p' })),
      synthetic: vi.fn(async () => {}),
      prompt: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      hook: vi.fn(async () => ({ dispose: async () => {} })),
    },
    tool: {
      transform: vi.fn(
        async (cb: (editor: { add: (tool: AddedTool) => void }) => void) => {
          runInProject(HOST_CONTEXT, () => cb({ add: (tool) => addedTools.push(tool) }));
          return { dispose: async () => {} };
        },
      ),
      hook: vi.fn(async () => ({ dispose: async () => {} })),
    },
    command: {
      transform: vi.fn(
        async (cb: (editor: { add: (command: unknown) => void }) => void) => {
          runInProject(HOST_CONTEXT, () => cb({ add: (command) => addedCommands.push(command) }));
          return { dispose: async () => {} };
        },
      ),
    },
    event: {
      subscribe: vi.fn(() => ({
        [Symbol.asyncIterator]: async function* () {},
      })),
    },
    permission: {
      hook: vi.fn(async () => ({ dispose: async () => {} })),
      reply: vi.fn(async () => {}),
    },
    model: {
      default: vi.fn(async () => ({ location: {}, data: null })),
    },
    rpc: {
      register: vi.fn(async (_definition: unknown, handlers: Record<string, RpcHandler>) => {
        registeredHandlers = handlers;
        return {
          dispose: async () => {},
          events: {
            emit: async (name: string, data: unknown) => {
              emitted.push([name, data]);
            },
          },
        };
      }),
    },
    location: { directory, project: {} },
    options: {},
  } as unknown as Plugin.Context;

  return { ctx, addedTools, addedCommands, emitted, rpcHandlers: () => registeredHandlers };
};

const runSetup = async (directory?: string, customize?: (ctx: Plugin.Context) => void) => {
  const { default: plugin } = await import('../src/index');
  expect(plugin.id).toBe('opencode-mission-control');

  const { ctx, addedTools, addedCommands, emitted, rpcHandlers } = createMockContext(directory);
  customize?.(ctx);
  const cleanup = await plugin.setup(ctx);

  return { plugin, ctx, addedTools, addedCommands, emitted, rpcHandlers, cleanup };
};

const runCleanup = async (cleanup: Awaited<ReturnType<typeof runSetup>>['cleanup']) => {
  if (typeof cleanup === 'function') {
    await cleanup();
  }
};

describe('plugin initialization', () => {
  beforeEach(() => {
    mockState.isManaged = false;
    vi.clearAllMocks();
    vi.spyOn(jobState, 'loadJobState').mockResolvedValue({
      version: 4,
      jobs: [],
      updatedAt: new Date().toISOString(),
    });
    vi.spyOn(worktree, 'isInManagedWorktree').mockImplementation(async () => ({
      isManaged: mockState.isManaged,
    }));
    vi.spyOn(orchestrator, 'getSharedMonitor').mockReturnValue(
      mockMonitor as unknown as ReturnType<typeof orchestrator.getSharedMonitor>,
    );
    vi.spyOn(orchestrator, 'setSharedNotifyCallback').mockImplementation(() => {});
    vi.spyOn(orchestrator, 'getSharedNotifyCallback').mockReturnValue(null);
    vi.spyOn(orchestrator, 'setSharedOrchestrator').mockImplementation(() => {});
    vi.spyOn(notifications, 'setupNotifications').mockImplementation(() => {});
    vi.spyOn(planState, 'loadPlan').mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('project context', () => {
    // The V2 server's process cwd is unrelated to the project, so setup and
    // every registered tool must run in the plugin instance's location.
    const location = '/tmp/mc-plugin-location';

    it('runs setup in the plugin location', async () => {
      let seen: string | undefined;
      vi.spyOn(orchestrator, 'getSharedMonitor').mockImplementation(() => {
        seen = getProjectDirectory();
        return mockMonitor as unknown as ReturnType<typeof orchestrator.getSharedMonitor>;
      });

      const { cleanup } = await runSetup(location);

      expect(location).not.toBe(process.cwd());
      expect(seen).toBe(location);

      await runCleanup(cleanup);
    });

    it('runs tools in the plugin location', async () => {
      let seen: string | undefined;
      vi.spyOn(jobState, 'loadJobState').mockImplementation(async () => {
        seen = getProjectDirectory();
        return { version: 4, jobs: [], updatedAt: new Date().toISOString() };
      });

      const { addedTools, cleanup } = await runSetup(location);
      const jobsTool = addedTools.find((tool) => tool.name === 'mc_jobs');
      expect(jobsTool).toBeDefined();

      // The host calls tools from its own context; the tool must re-enter its project.
      await runInProject(HOST_CONTEXT, () => jobsTool!.execute({}));

      expect(seen).toBe(location);

      await runCleanup(cleanup);
    });

    it('runs slash commands in the plugin location', async () => {
      let seen: string | undefined;
      vi.spyOn(jobState, 'loadJobState').mockImplementation(async () => {
        seen = getProjectDirectory();
        return { version: 4, jobs: [], updatedAt: new Date().toISOString() };
      });

      const { addedCommands, cleanup } = await runSetup(location);
      const jobsCommand = (addedCommands as Array<{
        name: string;
        execute: (input: unknown) => Promise<void>;
      }>).find((command) => command.name === 'mc-jobs');
      expect(jobsCommand).toBeDefined();

      await runInProject(HOST_CONTEXT, () =>
        jobsCommand!.execute({ sessionID: 'ses_test', prompt: { text: '' }, delivery: 'steer' }),
      );

      expect(seen).toBe(location);

      await runCleanup(cleanup);
    });
  });

  describe('rpc', () => {
    const location = '/tmp/mc-plugin-rpc-location';
    const ACTIONS = ['kill', 'cleanup', 'answer', 'approve', 'cancelPlan', 'capture', 'launch'];
    const rpcContext = () => ({
      signal: new AbortController().signal,
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
    });
    const settle = () => Bun.sleep(CHANGED_DEBOUNCE_MS + 80);

    it('registers a handler for every RPC method', async () => {
      const { ctx, rpcHandlers, cleanup } = await runSetup(location);

      expect(ctx.rpc.register).toHaveBeenCalledTimes(1);
      expect(Object.keys(rpcHandlers()).sort()).toEqual(['snapshot', ...ACTIONS].sort());

      await runCleanup(cleanup);
    });

    it('runs RPC handlers in the plugin location', async () => {
      let seen: string | undefined;
      vi.spyOn(jobState, 'loadJobState').mockImplementation(async () => {
        seen = getProjectDirectory();
        return { version: 4, jobs: [], updatedAt: new Date().toISOString() };
      });

      const { rpcHandlers, cleanup } = await runSetup(location);

      // The host calls RPC handlers from its own context.
      const snapshot = await runInProject(HOST_CONTEXT, () => rpcHandlers().snapshot({}, rpcContext()));

      expect(seen).toBe(location);
      expect(snapshot).toMatchObject({ jobs: [], plan: null });

      await runCleanup(cleanup);
    });

    it('gives a job agent handlers that mutate nothing', async () => {
      mockState.isManaged = true;
      const kill = vi.spyOn(mc_kill, 'execute');

      const { rpcHandlers, cleanup } = await runSetup(location);

      expect(await rpcHandlers().snapshot({}, rpcContext())).toMatchObject({ jobs: [] });
      for (const action of ACTIONS) {
        expect(await rpcHandlers()[action]({ name: 'a' }, rpcContext())).toMatchObject({ type: 'failed' });
      }
      expect(kill).not.toHaveBeenCalled();

      await runCleanup(cleanup);
    });

    it('installs the event emitters for its location and removes them on cleanup', async () => {
      const { emitted, cleanup } = await runSetup(location);

      expect(runInProject(location, () => hasRpcEventEmitter())).toBe(true);
      expect(runInProject(HOST_CONTEXT, () => hasRpcEventEmitter())).toBe(false);

      await runInProject(location, () => showToast({ message: 'hello' }));
      expect(emitted).toContainEqual([
        'toast',
        { title: 'Mission Control', message: 'hello', variant: 'info', duration: 5000 },
      ]);

      await runCleanup(cleanup);

      expect(runInProject(location, () => hasRpcEventEmitter())).toBe(false);
    });

    it('emits changed when the monitor reports a job event', async () => {
      const { emitted, cleanup } = await runSetup(location);

      const events = mockMonitor.on.mock.calls.map(([event]) => event);
      for (const event of ['complete', 'failed', 'blocked', 'needs_review', 'awaiting_input', 'agent_report', 'question']) {
        expect(events).toContain(event);
      }

      const [, onComplete] = mockMonitor.on.mock.calls.find(([event]) => event === 'complete')!;
      runInProject(location, () => (onComplete as () => void)());
      await settle();

      expect(emitted).toContainEqual(['changed', { reason: 'complete' }]);

      await runCleanup(cleanup);
    });

    it('emits changed after a tool that mutates state, even when it fails', async () => {
      vi.spyOn(mc_kill, 'execute').mockRejectedValue(new Error('Job "ghost" not found'));

      const { addedTools, emitted, cleanup } = await runSetup(location);
      const killTool = addedTools.find((tool) => tool.name === 'mc_kill')!;

      await expect(runInProject(HOST_CONTEXT, () => killTool.execute({ name: 'ghost' }))).rejects.toThrow(
        'Job "ghost" not found',
      );
      await settle();

      expect(emitted).toContainEqual(['changed', { reason: 'mc_kill' }]);

      await runCleanup(cleanup);
    });

    it('does not emit changed after a read-only tool', async () => {
      vi.spyOn(mc_jobs, 'execute').mockResolvedValue({ content: 'No jobs' });

      const { addedTools, emitted, cleanup } = await runSetup(location);
      const jobsTool = addedTools.find((tool) => tool.name === 'mc_jobs')!;

      await runInProject(HOST_CONTEXT, () => jobsTool.execute({}));
      await settle();

      expect(emitted.filter(([name]) => name === 'changed')).toEqual([]);

      await runCleanup(cleanup);
    });
  });

  describe('runtime client', () => {
    const location = '/tmp/mc-plugin-runtime-location';

    it('installs the plugin context as the runtime client of its location', async () => {
      const { ctx, cleanup } = await runSetup(location);

      runInProject(location, () => {
        expect(jobRuntime.hasRuntimeClient()).toBe(true);
        expect(jobRuntime.getRuntimeClient()).toBe(ctx);
      });
      expect(runInProject(HOST_CONTEXT, () => jobRuntime.hasRuntimeClient())).toBe(false);

      await runCleanup(cleanup);
    });

    it('installs the runtime client before the monitor starts', async () => {
      let hadClientAtStart: boolean | undefined;
      mockMonitor.start.mockImplementationOnce(() => {
        hadClientAtStart = jobRuntime.hasRuntimeClient();
      });

      const { cleanup } = await runSetup(location);

      expect(hadClientAtStart).toBe(true);

      await runCleanup(cleanup);
    });

    it('removes the runtime client on cleanup', async () => {
      const { cleanup } = await runSetup(location);

      await runCleanup(cleanup);

      runInProject(location, () => {
        expect(jobRuntime.hasRuntimeClient()).toBe(false);
      });
    });

    it('remembers the sessions of existing jobs so their events are not taken for user activity', async () => {
      vi.spyOn(jobState, 'loadJobState').mockResolvedValue({
        version: 4,
        jobs: [
          {
            id: 'job-1',
            name: 'done-job',
            worktreePath: '/tmp/wt/done-job',
            branch: 'mc/done-job',
            status: 'completed',
            prompt: 'Work',
            createdAt: new Date().toISOString(),
            sessionID: 'ses_donejob',
          },
        ],
        updatedAt: new Date().toISOString(),
      });

      const { cleanup } = await runSetup(location);

      runInProject(location, () => {
        expect(jobRuntime.isJobSession('ses_donejob')).toBe(true);
        expect(jobRuntime.isJobSession('ses_user')).toBe(false);
      });

      await runCleanup(cleanup);
    });

    it('also installs the runtime client for a job agent, without starting a monitor', async () => {
      mockState.isManaged = true;

      const { ctx, cleanup } = await runSetup(location);

      runInProject(location, () => {
        expect(jobRuntime.getRuntimeClient()).toBe(ctx);
      });
      expect(mockMonitor.start).not.toHaveBeenCalled();

      await runCleanup(cleanup);
    });
  });

  describe('job agent context', () => {
    it('tool editor receives only mc_report and mc_status', async () => {
      mockState.isManaged = true;

      const { addedTools, cleanup } = await runSetup();

      const toolNames = addedTools.map((tool) => tool.name);
      expect(toolNames).toHaveLength(2);
      expect(toolNames).toContain('mc_report');
      expect(toolNames).toContain('mc_status');

      await runCleanup(cleanup);
    });

    it('monitor.start() is not called', async () => {
      mockState.isManaged = true;

      const { cleanup } = await runSetup();

      const monitor = orchestrator.getSharedMonitor();
      expect(monitor.start).not.toHaveBeenCalled();

      await runCleanup(cleanup);
    });

    it('setupNotifications is not called', async () => {
      mockState.isManaged = true;

      const { cleanup } = await runSetup();

      expect(notifications.setupNotifications).not.toHaveBeenCalled();

      await runCleanup(cleanup);
    });

    it('setSharedNotifyCallback is not called', async () => {
      mockState.isManaged = true;

      const { cleanup } = await runSetup();

      expect(orchestrator.setSharedNotifyCallback).not.toHaveBeenCalled();

      await runCleanup(cleanup);
    });

    it('loadPlan is not called', async () => {
      mockState.isManaged = true;

      const { cleanup } = await runSetup();

      expect(planState.loadPlan).not.toHaveBeenCalled();

      await runCleanup(cleanup);
    });

    it('registerCommands is not called', async () => {
      mockState.isManaged = true;

      const { ctx, addedCommands, cleanup } = await runSetup();

      expect(ctx.command.transform).not.toHaveBeenCalled();
      expect(addedCommands).toHaveLength(0);

      await runCleanup(cleanup);
    });
  });

  describe('command center context', () => {
    it('tool editor receives all 18 tools', async () => {
      mockState.isManaged = false;

      const { addedTools, cleanup } = await runSetup();

      const toolNames = addedTools.map((tool) => tool.name);
      expect(toolNames).toHaveLength(18);
      expect(toolNames).toContain('mc_launch');
      expect(toolNames).toContain('mc_jobs');
      expect(toolNames).toContain('mc_status');
      expect(toolNames).toContain('mc_diff');
      expect(toolNames).toContain('mc_pr');
      expect(toolNames).toContain('mc_merge');
      expect(toolNames).toContain('mc_sync');
      expect(toolNames).toContain('mc_cleanup');
      expect(toolNames).toContain('mc_kill');
      expect(toolNames).toContain('mc_attach');
      expect(toolNames).toContain('mc_capture');
      expect(toolNames).toContain('mc_plan');
      expect(toolNames).toContain('mc_plan_status');
      expect(toolNames).toContain('mc_plan_cancel');
      expect(toolNames).toContain('mc_plan_approve');
      expect(toolNames).toContain('mc_report');
      expect(toolNames).toContain('mc_overview');
      expect(toolNames).toContain('mc_answer');

      await runCleanup(cleanup);
    });

    it('monitor.start() is called', async () => {
      mockState.isManaged = false;

      const { cleanup } = await runSetup();

      const monitor = orchestrator.getSharedMonitor();
      expect(monitor.start).toHaveBeenCalled();

      await runCleanup(cleanup);
    });

    it('setupNotifications is called', async () => {
      mockState.isManaged = false;

      const { cleanup } = await runSetup();

      expect(notifications.setupNotifications).toHaveBeenCalled();

      await runCleanup(cleanup);
    });

    it('setSharedNotifyCallback is called', async () => {
      mockState.isManaged = false;

      const { cleanup } = await runSetup();

      expect(orchestrator.setSharedNotifyCallback).toHaveBeenCalled();

      await runCleanup(cleanup);
    });

    it('loadPlan is called', async () => {
      mockState.isManaged = false;

      const { cleanup } = await runSetup();

      expect(planState.loadPlan).toHaveBeenCalled();

      await runCleanup(cleanup);
    });
  });

  describe('location', () => {
    it('refuses to start without a plugin location instead of guessing from the process directory', async () => {
      const { default: plugin } = await import('../src/index');
      const { ctx } = createMockContext();
      (ctx as unknown as { location: unknown }).location = {};

      expect(() => plugin.setup(ctx)).toThrow('plugin location');
    });
  });

  describe('active session', () => {
    const location = '/tmp/mc-plugin-active-location';

    /** Feed events to the plugin's own subscription, then let it run. */
    function scriptedEvents(events: unknown[]) {
      return (ctx: Plugin.Context) => {
        (ctx.event as unknown as { subscribe: unknown }).subscribe = vi.fn(() => ({
          [Symbol.asyncIterator]: async function* () {
            for (const event of events) {
              yield event;
            }
          },
        }));
      };
    }

    async function activeSessionAfter(events: unknown[]): Promise<string | undefined> {
      const { ctx, cleanup } = await runSetup(location, scriptedEvents(events));
      await Bun.sleep(20);
      const [[options]] = (notifications.setupNotifications as unknown as { mock: { calls: Array<[{ getActiveSessionID: () => Promise<string | undefined> }]> } }).mock.calls;
      const active = await options.getActiveSessionID();
      expect(ctx.event.subscribe).toHaveBeenCalledTimes(1);
      await runCleanup(cleanup);
      return active;
    }

    it("follows the sessions of the plugin's own location", async () => {
      const active = await activeSessionAfter([
        { type: 'session.execution.started', location: { directory: location }, data: { sessionID: 'ses_user1' } },
        { type: 'session.execution.started', location: { directory: location }, data: { sessionID: 'ses_user2' } },
      ]);

      expect(active).toBe('ses_user2');
    });

    it('ignores sessions in other locations: other projects, job worktrees and the subagents jobs start', async () => {
      const active = await activeSessionAfter([
        { type: 'session.execution.started', location: { directory: location }, data: { sessionID: 'ses_user' } },
        // A subagent of a job runs in the job's worktree. It used to become
        // the "active" session, and being a subagent, silenced notifications.
        { type: 'session.created', location: { directory: '/tmp/mc-worktrees/mc-job' }, data: { sessionID: 'ses_jobchild', parentID: 'ses_job' } },
        { type: 'session.execution.succeeded', location: { directory: '/tmp/some-other-project' }, data: { sessionID: 'ses_elsewhere' } },
      ]);

      expect(active).toBe('ses_user');
    });

    it('ignores known job sessions even without a location on the event', async () => {
      vi.spyOn(jobState, 'loadJobState').mockResolvedValue({
        version: 4,
        jobs: [
          {
            id: 'job-1',
            name: 'a-job',
            worktreePath: '/tmp/wt/a-job',
            branch: 'mc/a-job',
            status: 'running',
            prompt: 'Work',
            createdAt: new Date().toISOString(),
            sessionID: 'ses_knownjob',
          },
        ],
        updatedAt: new Date().toISOString(),
      });

      const active = await activeSessionAfter([
        { type: 'session.execution.started', data: { sessionID: 'ses_user' } },
        { type: 'session.execution.started', data: { sessionID: 'ses_knownjob' } },
      ]);

      expect(active).toBe('ses_user');
    });

    it('subscribes only to permission events in a job worktree', async () => {
      mockState.isManaged = true;

      const { ctx, cleanup } = await runSetup(location);

      // The permission gate listens for its own location's permission requests;
      // nothing tracks sessions or shows status from a job worktree.
      const calls = (ctx.event.subscribe as unknown as { mock: { calls: Array<[{ types?: string[] }?]> } }).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]?.types).toEqual(['permission.asked', 'permission.replied']);
      expect(ctx.permission.hook).toHaveBeenCalledWith('evaluate', expect.any(Function));
      await runCleanup(cleanup);
    });
  });

  describe('session hooks', () => {
    const location = '/tmp/mc-plugin-hooks-location';

    function hookCallback(ctx: Plugin.Context, name: string): ((input: unknown) => unknown) | undefined {
      const calls = (ctx.session.hook as unknown as { mock: { calls: Array<[string, (input: unknown) => unknown]> } }).mock.calls;
      return calls.find(([hook]) => hook === name)?.[1];
    }

    it("tracks the model of the command center's sessions, in its own project", async () => {
      const { ctx, cleanup } = await runSetup(location);
      const onContext = hookCallback(ctx, 'context')!;

      // The host calls hooks from its own context.
      runInProject(HOST_CONTEXT, () =>
        onContext({ sessionID: 'ses_user', model: { id: 'claude-sonnet-4', providerID: 'anthropic' }, tools: {} }),
      );

      expect(runInProject(location, () => modelTracker.getCurrentModel('ses_user'))).toBe('anthropic/claude-sonnet-4');
      expect(runInProject(HOST_CONTEXT, () => modelTracker.getCurrentModel('ses_user'))).toBeUndefined();

      await runCleanup(cleanup);
      // Unloading the plugin instance forgets the project's models.
      expect(runInProject(location, () => modelTracker.getCurrentModel('ses_user'))).toBeUndefined();
    });

    it("does not track a job's model, and takes the question tool away from jobs", async () => {
      mockState.isManaged = true;
      const track = vi.spyOn(modelTracker, 'setCurrentModelFromSDK');

      const { ctx, cleanup } = await runSetup(location);
      const tools: Record<string, unknown> = { question: {}, bash: {} };
      hookCallback(ctx, 'context')!({ sessionID: 'ses_job', model: { id: 'cheap', providerID: 'acme' }, tools });

      expect(track).not.toHaveBeenCalled();
      expect(tools).toEqual({ bash: {} });

      await runCleanup(cleanup);
    });

    it("records a job session's own background work when it goes idle", async () => {
      mockState.isManaged = true;

      const { ctx, cleanup } = await runSetup(location);
      const onIdle = hookCallback(ctx, 'experimental.idle')!;

      runInProject(HOST_CONTEXT, () =>
        onIdle({
          sessionID: 'ses_job',
          background: [
            { kind: 'shell', sessionID: 'ses_job', shellID: 'sh_1', command: 'bun test --watch' },
            // Owned by a subagent: it wakes the subagent, not this session.
            { kind: 'shell', sessionID: 'ses_child', shellID: 'sh_2', command: 'sleep 100' },
          ],
        }),
      );
      expect(jobRuntime.hasBackgroundWork(location, 'ses_job')).toBe(true);

      onIdle({ sessionID: 'ses_job', background: [] });
      expect(jobRuntime.hasBackgroundWork(location, 'ses_job')).toBe(false);

      onIdle({ sessionID: 'ses_job', background: [{ kind: 'subagent', sessionID: 'ses_job', childSessionID: 'c', agent: 'explore', description: 'look' }] });
      await runCleanup(cleanup);
      // A plugin reload does not end the work: the record survives the unload.
      expect(jobRuntime.hasBackgroundWork(location, 'ses_job')).toBe(true);
      jobRuntime.clearBackgroundWork(location);
    });

    it('does not watch for background work in the command center', async () => {
      const { ctx, cleanup } = await runSetup(location);

      expect(hookCallback(ctx, 'experimental.idle')).toBeUndefined();
      await runCleanup(cleanup);
    });
  });

  describe('plan resume on load', () => {
    const location = '/tmp/mc-plugin-resume-location';

    beforeEach(() => {
      vi.spyOn(configMod, 'loadConfig').mockResolvedValue({ pollInterval: 10000, worktreeBasePath: '/tmp' });
    });

    function plan(status: string, mode = 'autopilot') {
      return {
        id: 'plan-1',
        name: 'Plan',
        mode,
        status,
        jobs: [],
        integrationBranch: 'mc/integration-plan-1',
        integrationWorktree: '/tmp/integration-plan-1',
        baseCommit: 'abc123',
        createdAt: new Date().toISOString(),
      } as never;
    }

    it.each(['running', 'paused', 'merging', 'creating_pr', 'pending'])(
      'resumes a plan that was %s through the one shared orchestrator',
      async (status) => {
        vi.spyOn(planState, 'loadPlan').mockResolvedValue(plan(status));
        const resumePlan = vi.spyOn(Orchestrator.prototype, 'resumePlan').mockResolvedValue(undefined);
        const replace = vi.spyOn(orchestrator, 'replaceSharedOrchestrator');

        const { cleanup } = await runSetup(location);
        await Bun.sleep(20);

        expect(replace).toHaveBeenCalledTimes(1);
        expect(resumePlan).toHaveBeenCalledTimes(1);
        await runCleanup(cleanup);
      },
    );

    it.each([
      ['completed', 'autopilot'],
      ['failed', 'autopilot'],
      ['canceled', 'autopilot'],
      ['pending', 'copilot'],
    ])('does not resume a plan that is %s (%s)', async (status, mode) => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(plan(status, mode));
      const replace = vi.spyOn(orchestrator, 'replaceSharedOrchestrator');

      const { cleanup } = await runSetup(location);
      await Bun.sleep(20);

      expect(replace).not.toHaveBeenCalled();
      await runCleanup(cleanup);
    });

    it('stops the orchestrator when the plugin instance unloads, so a reload never leaves two', async () => {
      vi.spyOn(planState, 'loadPlan').mockResolvedValue(plan('running'));
      vi.spyOn(Orchestrator.prototype, 'resumePlan').mockResolvedValue(undefined);
      const dispose = vi.spyOn(Orchestrator.prototype, 'dispose');

      const { cleanup } = await runSetup(location);
      await Bun.sleep(20);
      const live = runInProject(location, () => orchestrator.getSharedOrchestrator());
      expect(live).toBeInstanceOf(Orchestrator);

      await runCleanup(cleanup);

      expect(dispose).toHaveBeenCalledTimes(1);
      expect(live!.isDisposed()).toBe(true);
      expect(runInProject(location, () => orchestrator.getSharedOrchestrator())).toBeNull();
    });

    it('says so when the plan cannot be resumed', async () => {
      vi.spyOn(planState, 'loadPlan').mockRejectedValue(new Error('Invalid plan state'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { cleanup } = await runSetup(location);
      await Bun.sleep(20);

      expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not resume the active plan'), expect.any(Error));
      await runCleanup(cleanup);
    });
  });

  describe('slash command output', () => {
    const location = '/tmp/mc-plugin-output-location';
    const rpcContext = () => ({
      signal: new AbortController().signal,
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
    });

    async function runJobsCommand(setup: Awaited<ReturnType<typeof runSetup>>): Promise<void> {
      const command = (setup.addedCommands as Array<{ name: string; execute: (input: unknown) => Promise<void> }>).find(
        (candidate) => candidate.name === 'mc-jobs',
      )!;
      await runInProject(HOST_CONTEXT, () =>
        command.execute({ sessionID: 'ses_test', prompt: { text: '' }, delivery: 'steer' }),
      );
    }

    it('goes to the session when no TUI is listening, so web and desktop clients see it', async () => {
      vi.spyOn(mc_jobs, 'execute').mockResolvedValue({ content: 'No jobs' });
      const setup = await runSetup(location);

      await runJobsCommand(setup);

      expect(setup.emitted.filter(([name]) => name === 'output')).toEqual([]);
      expect(setup.ctx.session.synthetic).toHaveBeenCalledWith({
        sessionID: 'ses_test',
        text: '/mc-jobs\n\nNo jobs',
        resume: false,
      });
      await runCleanup(setup.cleanup);
    });

    it('goes to the TUI dialog, and stays out of the conversation, when a TUI asked for state recently', async () => {
      vi.spyOn(mc_jobs, 'execute').mockResolvedValue({ content: 'No jobs' });
      const setup = await runSetup(location);
      // The TUI part refetches its snapshot at least every 15 seconds.
      await runInProject(HOST_CONTEXT, () => setup.rpcHandlers().snapshot({}, rpcContext()));

      await runJobsCommand(setup);

      expect(setup.emitted).toContainEqual(['output', { title: '/mc-jobs', content: 'No jobs', sessionID: 'ses_test' }]);
      expect(setup.ctx.session.synthetic).not.toHaveBeenCalled();
      await runCleanup(setup.cleanup);
    });

    it('delivers a command error the same way', async () => {
      vi.spyOn(mc_jobs, 'execute').mockRejectedValue(new Error('state file unreadable'));
      const setup = await runSetup(location);

      await runJobsCommand(setup);

      expect(setup.ctx.session.synthetic).toHaveBeenCalledWith({
        sessionID: 'ses_test',
        text: '/mc-jobs\n\nError: state file unreadable',
        resume: false,
      });
      await runCleanup(setup.cleanup);
    });

    it('keeps `$&` and similar in template command arguments literal', async () => {
      const setup = await runSetup(location);
      const launch = (setup.addedCommands as Array<{ name: string; execute: (input: unknown) => Promise<void> }>).find(
        (candidate) => candidate.name === 'mc-launch',
      )!;

      await runInProject(HOST_CONTEXT, () =>
        launch.execute({ sessionID: 'ses_test', prompt: { text: "price is $& and $' and $1" }, delivery: 'steer' }),
      );

      expect(setup.ctx.session.prompt).toHaveBeenCalledWith({
        sessionID: 'ses_test',
        text: "Launch a new Mission Control parallel coding session with these instructions: price is $& and $' and $1",
      });
      await runCleanup(setup.cleanup);
    });
  });
});
