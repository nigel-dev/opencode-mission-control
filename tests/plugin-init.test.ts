import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Plugin } from '@opencode/plugin';

const mockState = { isManaged: false };
import * as tmux from '../src/lib/tmux';
import * as worktree from '../src/lib/worktree';
import * as orchestrator from '../src/lib/orchestrator-singleton';
import * as notifications from '../src/hooks/notifications';
import * as planState from '../src/lib/plan-state';

const mockMonitor = {
  start: vi.fn(),
  on: vi.fn(),
};

interface AddedTool {
  name: string;
}

interface MockContext {
  ctx: Plugin.Context;
  addedTools: AddedTool[];
  addedCommands: unknown[];
}

const createMockContext = (): MockContext => {
  const addedTools: AddedTool[] = [];
  const addedCommands: unknown[] = [];

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
          cb({ add: (tool) => addedTools.push(tool) });
          return { dispose: async () => {} };
        },
      ),
      hook: vi.fn(async () => ({ dispose: async () => {} })),
    },
    command: {
      transform: vi.fn(
        async (cb: (editor: { add: (command: unknown) => void }) => void) => {
          cb({ add: (command) => addedCommands.push(command) });
          return { dispose: async () => {} };
        },
      ),
    },
    event: {
      subscribe: vi.fn(() => ({
        [Symbol.asyncIterator]: async function* () {},
      })),
    },
    model: {
      default: vi.fn(async () => ({ location: {}, data: null })),
    },
    rpc: {
      register: vi.fn(async () => ({
        dispose: async () => {},
        events: { emit: async () => {} },
      })),
    },
    location: { directory: process.cwd(), project: {} },
    options: {},
  } as unknown as Plugin.Context;

  return { ctx, addedTools, addedCommands };
};

const runSetup = async () => {
  const { default: plugin } = await import('../src/index');
  expect(plugin.id).toBe('opencode-mission-control');

  const { ctx, addedTools, addedCommands } = createMockContext();
  const cleanup = await plugin.setup(ctx);

  return { plugin, ctx, addedTools, addedCommands, cleanup };
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
    vi.spyOn(tmux, 'isTmuxAvailable').mockResolvedValue(true);
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
});
