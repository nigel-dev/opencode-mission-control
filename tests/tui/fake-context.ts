import { vi } from 'vitest';
import type { Plugin as Tui } from '@opencode/plugin/tui';
import type { Snapshot } from '../../src/rpc';

export interface FakeRpcEvent {
  data: Record<string, unknown>;
  location?: { directory: string };
}

type Handler = (event: FakeRpcEvent) => void;

export const EMPTY_SNAPSHOT: Snapshot = {
  jobs: [],
  plan: null,
  counts: { running: 0, blocked: 0, completed: 0, failed: 0, stopped: 0 },
};

/** A stand-in for the TUI plugin context, recording everything the plugin does with it. */
export function createFakeContext(options: { directory?: string; tabs?: boolean; panelOpens?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const unsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
  const slots: Array<{ claim: Record<string, unknown>; dispose: ReturnType<typeof vi.fn> }> = [];
  const layers: Array<() => { mode?: string; commands?: Array<Record<string, unknown>>; bindings?: string[] }> = [];
  const routeDispose = vi.fn();

  const ok = (content: string) => vi.fn(async () => ({ content }));
  const rpc = {
    snapshot: vi.fn(async (): Promise<Snapshot> => EMPTY_SNAPSHOT),
    kill: ok('Job stopped successfully.'),
    cleanup: ok('Cleaned up.'),
    answer: ok('Answer sent.'),
    approve: ok('Approved.'),
    cancelPlan: ok('Plan canceled.'),
    capture: ok('line 1\nline 2'),
    launch: ok('Job launched successfully.'),
    events: {
      on: vi.fn((name: string, handler: Handler) => {
        handlers.set(name, handler);
        const unsubscribe = vi.fn();
        unsubscribes.set(name, unsubscribe);
        return unsubscribe;
      }),
    },
  };

  const ui = {
    toast: { show: vi.fn() },
    dialog: {
      confirm: vi.fn(async (): Promise<boolean | undefined> => true),
      prompt: vi.fn(async (): Promise<string | undefined> => undefined),
      alert: vi.fn(async () => {}),
      show: vi.fn(),
      set: vi.fn(),
      clear: vi.fn(),
    },
    tabs: {
      enabled: vi.fn(() => options.tabs ?? true),
      focus: vi.fn(() => options.tabs ?? true),
    },
    router: {
      navigate: vi.fn(),
      register: vi.fn(() => routeDispose),
    },
    panel: {
      open: vi.fn(() => options.panelOpens ?? true),
      close: vi.fn(),
    },
    slot: vi.fn((claim: Record<string, unknown>) => {
      const dispose = vi.fn();
      slots.push({ claim, dispose });
      return dispose;
    }),
  };

  const form = {
    list: vi.fn((): unknown[] | undefined => []),
    sync: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };

  const context = {
    location: options.directory ? { directory: options.directory } : undefined,
    client: { rpc: vi.fn(() => rpc) },
    ui,
    attention: {
      notify: vi.fn(async () => ({ ok: true, notification: false, sound: false })),
    },
    keymap: {
      layer: vi.fn((factory: (typeof layers)[number]) => {
        layers.push(factory);
      }),
    },
    data: { session: { form } },
    theme: {},
  };

  return {
    context: context as unknown as Tui.Context,
    rpc,
    ui,
    form,
    attention: context.attention,
    keymap: context.keymap,
    slots,
    layers,
    routeDispose,
    unsubscribes,
    emit(name: string, event: FakeRpcEvent) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No handler subscribed to "${name}"`);
      handler(event);
    },
  };
}
