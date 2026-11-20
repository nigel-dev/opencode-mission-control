import type { Snapshot } from '../rpc';

export const REFRESH_INTERVAL_MS = 15000;

export interface SnapshotStoreOptions {
  fetch: () => Promise<Snapshot>;
  /** Safety-net refetch period: RPC events are live-only, so one can be missed. */
  intervalMs?: number;
  log?: (message: string, error: unknown) => void;
}

export interface SnapshotStore {
  /** The latest snapshot, or null while the server part cannot be reached. */
  get(): Snapshot | null;
  subscribe(listener: (snapshot: Snapshot | null) => void): () => void;
  /** Refetch now. Never rejects: a failed fetch clears the snapshot. */
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * Holds the latest Mission Control snapshot for the views. Overlapping
 * refreshes are collapsed: a request arriving while one is in flight triggers
 * exactly one more fetch after it, so the last state always wins.
 */
export function createSnapshotStore(options: SnapshotStoreOptions): SnapshotStore {
  const intervalMs = options.intervalMs ?? REFRESH_INTERVAL_MS;
  const log = options.log ?? ((message, error) => console.warn(message, error));
  const listeners = new Set<(snapshot: Snapshot | null) => void>();

  let snapshot: Snapshot | null = null;
  let inFlight: Promise<void> | undefined;
  let queued = false;
  let stopped = false;
  let failureLogged = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const publish = (next: Snapshot | null): void => {
    if (next === null && snapshot === null) return;
    snapshot = next;
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const fetchOnce = async (): Promise<void> => {
    try {
      const next = await options.fetch();
      if (stopped) return;
      failureLogged = false;
      publish(next);
    } catch (error) {
      if (stopped) return;
      // The server may be unreachable or the server part not loaded: show
      // nothing instead of stale state, and say so once until it recovers.
      if (!failureLogged) {
        failureLogged = true;
        log('[Mission Control] Could not load job state; the TUI integration is idle until it can:', error);
      }
      publish(null);
    }
  };

  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        queued = false;
        await fetchOnce();
      } while (queued && !stopped);
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => {
        void refresh();
      }, intervalMs);
      void refresh();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      listeners.clear();
    },
  };
}
