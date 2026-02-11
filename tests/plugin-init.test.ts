import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockState = { isManaged: false };

vi.mock('../src/lib/tmux', () => ({
  isTmuxAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock('../src/lib/worktree', () => ({
  isInManagedWorktree: vi.fn(() => Promise.resolve({ isManaged: mockState.isManaged })),
}));

vi.mock('../src/lib/orchestrator-singleton', () => ({
  getSharedMonitor: vi.fn().mockReturnValue({
    start: vi.fn(),
    on: vi.fn(),
  }),
  setSharedNotifyCallback: vi.fn(),
  getSharedNotifyCallback: vi.fn(),
  setSharedOrchestrator: vi.fn(),
}));

vi.mock('../src/hooks/notifications', () => ({
  setupNotifications: vi.fn(),
}));

vi.mock('../src/lib/plan-state', () => ({
  loadPlan: vi.fn().mockResolvedValue(null),
}));

vi.mock('../src/lib/config', () => ({
  loadConfig: vi.fn().mockResolvedValue({}),
}));

import * as worktree from '../src/lib/worktree';
import * as orchestrator from '../src/lib/orchestrator-singleton';
import * as notifications from '../src/hooks/notifications';
import * as planState from '../src/lib/plan-state';

const createMockClient = () => ({
  session: {
    list: vi.fn().mockResolvedValue([]),
    prompt: vi.fn().mockResolvedValue(undefined),
  },
  config: {
    get: vi.fn().mockResolvedValue({ data: {} }),
  },
  tui: {
    showToast: vi.fn().mockResolvedValue(undefined),
  },
});

describe('plugin initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('job agent context', () => {
    it('tool object has only mc_report and mc_status', async () => {
      mockState.isManaged = true;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true });
      
      const { default: MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      const plugin = await MissionControl({ client: mockClient } as any);
      
      const toolKeys = Object.keys(plugin.tool || {});
      expect(toolKeys).toHaveLength(2);
      expect(toolKeys).toContain('mc_report');
      expect(toolKeys).toContain('mc_status');
    });

    it('monitor.start() is not called', async () => {
      mockState.isManaged = true;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true });
      
      const { default: MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      const mockMonitor = orchestrator.getSharedMonitor();
      expect(mockMonitor.start).not.toHaveBeenCalled();
    });

    it('setupNotifications is not called', async () => {
      mockState.isManaged = true;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true });
      
      const { default: MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      expect(notifications.setupNotifications).not.toHaveBeenCalled();
    });

    it('setSharedNotifyCallback is not called', async () => {
      mockState.isManaged = true;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true });
      
      const { default: MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      expect(orchestrator.setSharedNotifyCallback).not.toHaveBeenCalled();
    });

    it('loadPlan is not called', async () => {
      mockState.isManaged = true;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true });
      
      const { default: MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      expect(planState.loadPlan).not.toHaveBeenCalled();
    });

    it('registerCommands is not called in config hook', async () => {
      mockState.isManaged = true;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: true });
      
      const { default: MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      const plugin = await MissionControl({ client: mockClient } as any);
      
      const mockConfig = { commands: [] } as any;
      if (plugin.config) {
        await plugin.config(mockConfig);
      }
      
      expect(mockConfig.commands.length).toBe(0);
    });
  });

  describe('command center context', () => {
    it('tool object has all 17 tools', async () => {
      mockState.isManaged = false;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: false });
      
      const { default: MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      const plugin = await MissionControl({ client: mockClient } as any);
      
      const toolKeys = Object.keys(plugin.tool || {});
      expect(toolKeys).toHaveLength(17);
      expect(toolKeys).toContain('mc_launch');
      expect(toolKeys).toContain('mc_jobs');
      expect(toolKeys).toContain('mc_status');
      expect(toolKeys).toContain('mc_diff');
      expect(toolKeys).toContain('mc_pr');
      expect(toolKeys).toContain('mc_merge');
      expect(toolKeys).toContain('mc_sync');
      expect(toolKeys).toContain('mc_cleanup');
      expect(toolKeys).toContain('mc_kill');
      expect(toolKeys).toContain('mc_attach');
      expect(toolKeys).toContain('mc_capture');
      expect(toolKeys).toContain('mc_plan');
      expect(toolKeys).toContain('mc_plan_status');
      expect(toolKeys).toContain('mc_plan_cancel');
      expect(toolKeys).toContain('mc_plan_approve');
      expect(toolKeys).toContain('mc_report');
      expect(toolKeys).toContain('mc_overview');
    });

    it('monitor.start() is called', async () => {
      mockState.isManaged = false;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: false });
      
      const { default: MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      const mockMonitor = orchestrator.getSharedMonitor();
      expect(mockMonitor.start).toHaveBeenCalled();
    });

    it('setupNotifications is called', async () => {
      mockState.isManaged = false;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: false });
      
      const { default: MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      expect(notifications.setupNotifications).toHaveBeenCalled();
    });

    it('setSharedNotifyCallback is called', async () => {
      mockState.isManaged = false;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: false });
      
      const { default: MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      expect(orchestrator.setSharedNotifyCallback).toHaveBeenCalled();
    });

    it('loadPlan is called', async () => {
      mockState.isManaged = false;
      vi.spyOn(worktree, 'isInManagedWorktree').mockResolvedValue({ isManaged: false });
      
      const { default: MissionControl } = await import('../src/index');
      const mockClient = createMockClient();
      await MissionControl({ client: mockClient } as any);
      
      expect(planState.loadPlan).toHaveBeenCalled();
    });
  });
});
