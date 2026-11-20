import { describe, it, expect, vi } from 'vitest';
import type { Snapshot } from '../../src/rpc';
import { createSnapshotStore } from '../../src/tui/store';

function snapshot(running = 0): Snapshot {
  return {
    jobs: [],
    plan: null,
    counts: { running, blocked: 0, completed: 0, failed: 0, stopped: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('snapshot store', () => {
  it('starts empty and publishes fetched snapshots', async () => {
    const fetch = vi.fn(async () => snapshot(2));
    const store = createSnapshotStore({ fetch, log: vi.fn() });
    const seen: Array<Snapshot | null> = [];
    store.subscribe((next) => seen.push(next));

    expect(store.get()).toBeNull();
    await store.refresh();

    expect(store.get()).toEqual(snapshot(2));
    expect(seen).toEqual([snapshot(2)]);
    store.stop();
  });

  it('fetches on start and again on the interval', async () => {
    const fetch = vi.fn(async () => snapshot());
    const store = createSnapshotStore({ fetch, intervalMs: 20, log: vi.fn() });

    store.start();
    await Bun.sleep(90);
    store.stop();
    const calls = fetch.mock.calls.length;

    expect(calls).toBeGreaterThanOrEqual(3);
    await Bun.sleep(60);
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it('collapses refreshes requested during a fetch into one more fetch', async () => {
    const first = deferred<Snapshot>();
    const fetch = vi
      .fn<() => Promise<Snapshot>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => snapshot(7));
    const store = createSnapshotStore({ fetch, log: vi.fn() });

    const pending = store.refresh();
    void store.refresh();
    void store.refresh();
    void store.refresh();
    first.resolve(snapshot(1));
    await pending;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.get()).toEqual(snapshot(7));
    store.stop();
  });

  it('clears the snapshot and logs once while the server is unreachable', async () => {
    const log = vi.fn();
    const fetch = vi
      .fn<() => Promise<Snapshot>>()
      .mockResolvedValueOnce(snapshot(1))
      .mockRejectedValueOnce({ type: 'rpc.unavailable', message: 'down' })
      .mockRejectedValueOnce({ type: 'rpc.unavailable', message: 'down' })
      .mockResolvedValueOnce(snapshot(3))
      .mockRejectedValueOnce(new Error('down again'));
    const store = createSnapshotStore({ fetch, log });
    const seen: Array<Snapshot | null> = [];
    store.subscribe((next) => seen.push(next));

    await store.refresh();
    await expect(store.refresh()).resolves.toBeUndefined();
    expect(store.get()).toBeNull();
    await store.refresh();
    expect(log).toHaveBeenCalledTimes(1);

    await store.refresh();
    expect(store.get()).toEqual(snapshot(3));

    // After a recovery a new outage is reported again.
    await store.refresh();
    expect(log).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([snapshot(1), null, snapshot(3), null]);
    store.stop();
  });

  it('stops notifying after unsubscribe', async () => {
    const store = createSnapshotStore({ fetch: async () => snapshot(), log: vi.fn() });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    await store.refresh();
    unsubscribe();
    await store.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it('ignores results and requests after stop', async () => {
    const inFlight = deferred<Snapshot>();
    const fetch = vi.fn(() => inFlight.promise);
    const store = createSnapshotStore({ fetch, log: vi.fn() });
    const listener = vi.fn();
    store.subscribe(listener);

    const pending = store.refresh();
    store.stop();
    inFlight.resolve(snapshot(9));
    await pending;
    await store.refresh();

    expect(store.get()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
