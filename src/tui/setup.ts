import type { Plugin as Tui } from '@opencode/plugin/tui';
import type { PanelInput } from '@opencode/plugin/tui/context';
import type { JSX } from '@opentui/solid';
import { missionControlRpc } from '../rpc';
import { createActions, type Actions } from './actions';
import {
  DASHBOARD_COMMAND,
  DASHBOARD_PANEL,
  DASHBOARD_ROUTE,
  DASHBOARD_SLASH,
  attentionSound,
  attentionToast,
  parseAttention,
  parseOpen,
  sameLocation,
  toastFromEvent,
} from './format';
import { createSnapshotStore, type SnapshotStore } from './store';

/** What the views need: the host context, live state, and the actions. */
export interface ViewModel {
  context: Tui.Context;
  store: SnapshotStore;
  actions: Actions;
}

/** The renderer-facing half of the TUI part, kept apart so setup is testable without one. */
export interface Views {
  footer(): JSX.Element;
  sidebar(): JSX.Element;
  /** The dashboard as a session panel; renders only while its name is selected. */
  panel(panel: PanelInput): JSX.Element;
  /** The dashboard as a full page, for when no session is open. */
  page(): JSX.Element;
  showTranscript(title: string, text: string): void;
}

export type ViewFactory = (model: ViewModel) => Views;

interface LocatedEvent {
  data: Readonly<Record<string, unknown>>;
  location?: { directory?: string };
}

export function setupMissionControl(context: Tui.Context, createViews: ViewFactory): Tui.Cleanup {
  const rpc = context.client.rpc(missionControlRpc);
  // The directory whose plugin instance owns this project's jobs. A tab showing
  // a job's session sits in the job's worktree, which is a different location
  // with no jobs of its own; the server names the owning directory (`home`).
  const location: { directory?: string } = { directory: context.location?.directory };
  const at = (directory: string | undefined) => (directory ? { location: { directory } } : undefined);
  const cleanups: Array<() => void> = [];

  // Worktrees of this project's jobs, as seen in snapshots. A tab showing a
  // job's session sits in one of them, and stays there after the job is
  // cleaned up and the worktree's plugin instance is gone.
  const jobWorktrees = new Set<string>();

  const store = createSnapshotStore({
    fetch: async () => {
      const current = context.location?.directory ?? location.directory;
      // The project's home, when this tab is in one of its job worktrees. Any
      // other directory is another project and must not be shown this one's jobs.
      const known =
        current && location.directory && location.directory !== current && jobWorktrees.has(current)
          ? location.directory
          : undefined;

      let answeredBy = current;
      let snapshot;
      try {
        snapshot = await rpc.snapshot({}, at(current));
      } catch (error) {
        if (!known) throw error;
        answeredBy = known;
        snapshot = await rpc.snapshot({}, at(known));
      }

      // A location that owns no jobs names the directory that does (`home`);
      // one that cannot name it leaves the last known home.
      const home = snapshot.home ?? (answeredBy === known ? undefined : known);
      if (home && home !== answeredBy) {
        snapshot = await rpc.snapshot({}, at(home));
      }
      location.directory = snapshot.home ?? known ?? current;
      for (const job of snapshot.jobs) {
        jobWorktrees.add(job.worktreePath);
      }
      return snapshot;
    },
  });

  // The views are created below but an action can only run after that.
  let views: Views | undefined;
  const actions = createActions({
    context,
    rpc,
    location,
    refresh: () => store.refresh(),
    showTranscript: (title, text) => views?.showTranscript(title, text),
  });
  views = createViews({ context, store, actions });
  const { footer, sidebar, panel, page } = views;

  // External clients receive RPC events from every location.
  const mine = (event: LocatedEvent): boolean => sameLocation(event.location, location);

  cleanups.push(
    rpc.events.on('toast', (event) => {
      if (!mine(event)) return;
      context.ui.toast.show(toastFromEvent(event.data));
    }),
    rpc.events.on('changed', (event) => {
      if (!mine(event)) return;
      void store.refresh();
    }),
    rpc.events.on('attention', (event) => {
      if (!mine(event)) return;
      const attention = parseAttention(event.data);
      if (!attention) return;
      const toast = attentionToast(attention);
      context.ui.toast.show(toast);
      context.attention
        .notify({
          title: toast.title,
          message: toast.message,
          notification: { when: 'blurred' },
          sound: { name: attentionSound(attention.kind), when: 'blurred' },
        })
        .catch((error: unknown) => {
          // The toast above already told the user; a missing system
          // notification is not worth surfacing.
          console.debug('[Mission Control] Could not send an attention notification:', error);
        });
      void store.refresh();
    }),
    rpc.events.on('open', (event) => {
      if (!mine(event)) return;
      const target = parseOpen(event.data);
      if (target) {
        actions.openSession(target.sessionID);
      }
    }),
    rpc.events.on('output', (event) => {
      if (!mine(event)) return;
      views?.showTranscript(event.data.title, event.data.content);
    }),
  );

  cleanups.push(
    // The prompt footer is on the home screen too, so one slot covers both.
    context.ui.slot({ append: 'prompt.footer.status', render: () => footer() }),
    context.ui.slot({ append: 'sidebar.content', render: () => sidebar() }),
    context.ui.slot({ append: 'session.panel', render: (input) => panel(input) }),
    context.ui.router.register({ name: DASHBOARD_ROUTE, render: () => page() }),
  );

  const openDashboard = (): void => {
    // The panel exists only inside a session; elsewhere use the full page.
    if (!context.ui.panel.open(DASHBOARD_PANEL)) {
      context.ui.router.navigate({ type: 'plugin', name: DASHBOARD_ROUTE });
    }
  };

  // Removed by the host when the plugin deactivates.
  context.keymap.layer(() => ({
    mode: 'global',
    commands: [
      {
        id: DASHBOARD_COMMAND,
        title: 'Mission Control: Open dashboard',
        description: 'Show all Mission Control jobs and the active plan',
        group: 'Mission Control',
        bind: '<leader>j',
        palette: true,
        slash: { name: DASHBOARD_SLASH },
        run: () => {
          openDashboard();
        },
      },
    ],
    bindings: [DASHBOARD_COMMAND],
  }));

  store.start();

  return () => {
    store.stop();
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  };
}
