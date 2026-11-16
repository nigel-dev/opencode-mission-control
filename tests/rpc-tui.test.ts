import { describe, it, expect, vi, afterEach } from 'vitest';
import { missionControlRpc, setToastEmitter, showToast } from '../src/rpc';
import tuiPlugin from '../src/tui';

afterEach(() => {
  setToastEmitter(null);
});

describe('missionControlRpc', () => {
  it('defines the toast event with an object schema', () => {
    expect(missionControlRpc.id).toBe('opencode-mission-control');
    const toastEvent = (missionControlRpc as unknown as {
      events: Record<string, { schema: { type: string; required: string[] } }>;
    }).events.toast;
    expect(toastEvent.schema.type).toBe('object');
    expect(toastEvent.schema.required).toContain('message');
  });
});

describe('showToast', () => {
  it('is a no-op when no emitter is registered', async () => {
    await expect(showToast({ message: 'hello' })).resolves.toBeUndefined();
  });

  it('forwards options to the registered emitter', async () => {
    const emitter = vi.fn().mockResolvedValue(undefined);
    setToastEmitter(emitter);

    await showToast({ title: 'MC', message: 'done', variant: 'success', duration: 1000 });

    expect(emitter).toHaveBeenCalledWith({
      title: 'MC',
      message: 'done',
      variant: 'success',
      duration: 1000,
    });
  });

  it('swallows emitter failures', async () => {
    const emitter = vi.fn().mockRejectedValue(new Error('rpc down'));
    setToastEmitter(emitter);

    await expect(showToast({ message: 'best effort' })).resolves.toBeUndefined();
  });
});

describe('tui plugin', () => {
  interface FakeRpcEvent {
    data: Record<string, unknown>;
  }

  it('shows a toast when a toast RPC event arrives and unsubscribes on cleanup', () => {
    let handler: ((event: FakeRpcEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const show = vi.fn();
    const fakeContext = {
      client: {
        rpc: vi.fn().mockReturnValue({
          events: {
            on: vi.fn((name: string, cb: (event: FakeRpcEvent) => void) => {
              expect(name).toBe('toast');
              handler = cb;
              return unsubscribe;
            }),
          },
        }),
      },
      ui: { toast: { show } },
    };

    const definition = tuiPlugin as unknown as {
      id: string;
      setup: (ctx: unknown) => (() => void) | undefined;
    };

    expect(definition.id).toBe('opencode-mission-control-tui');
    const cleanup = definition.setup(fakeContext);

    expect(handler).toBeTypeOf('function');
    handler?.({ data: { message: 'job finished', variant: 'not-a-variant' } });

    expect(show).toHaveBeenCalledWith({
      title: 'Mission Control',
      message: 'job finished',
      variant: 'info',
      duration: 5000,
    });

    cleanup?.();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
