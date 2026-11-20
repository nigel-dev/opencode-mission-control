import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CHANGED_DEBOUNCE_MS,
  emitAttention,
  emitChanged,
  emitOpen,
  hasRecentClient,
  hasRpcEventEmitter,
  recordClientSeen,
  setRpcEventEmitter,
  type RpcEventEmitter,
} from '../../src/lib/rpc-events';
import { runInProject } from '../../src/lib/project-context';

const PROJECT_A = '/tmp/mc-rpc-events-a';
const PROJECT_B = '/tmp/mc-rpc-events-b';

function makeEmitter(): RpcEventEmitter & {
  changed: ReturnType<typeof vi.fn>;
  attention: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
} {
  return {
    changed: vi.fn(async () => {}),
    attention: vi.fn(async () => {}),
    open: vi.fn(async () => {}),
    output: vi.fn(async () => {}),
  };
}

const settle = () => Bun.sleep(CHANGED_DEBOUNCE_MS + 80);

afterEach(() => {
  runInProject(PROJECT_A, () => setRpcEventEmitter(null));
  runInProject(PROJECT_B, () => setRpcEventEmitter(null));
});

describe('rpc events', () => {
  it('is a no-op without a registered emitter', async () => {
    await runInProject(PROJECT_A, async () => {
      expect(hasRpcEventEmitter()).toBe(false);
      expect(() => emitChanged('jobs')).not.toThrow();
      await expect(emitAttention({ kind: 'failed', title: 't', message: 'm' })).resolves.toBeUndefined();
      await expect(emitOpen({ sessionID: 'ses_1' })).resolves.toBeUndefined();
    });
  });

  it('routes events to the emitter of the current project only', async () => {
    const a = makeEmitter();
    const b = makeEmitter();
    runInProject(PROJECT_A, () => setRpcEventEmitter(a));
    runInProject(PROJECT_B, () => setRpcEventEmitter(b));

    await runInProject(PROJECT_A, () => emitOpen({ sessionID: 'ses_a', title: 'A' }));
    await runInProject(PROJECT_B, () =>
      emitAttention({ kind: 'blocked', title: 'Blocked', message: 'help', jobName: 'job-b' }),
    );
    runInProject(PROJECT_A, () => emitChanged('kill'));
    await settle();

    expect(a.open).toHaveBeenCalledWith({ sessionID: 'ses_a', title: 'A' });
    expect(b.open).not.toHaveBeenCalled();
    expect(b.attention).toHaveBeenCalledWith({
      kind: 'blocked',
      title: 'Blocked',
      message: 'help',
      jobName: 'job-b',
    });
    expect(a.attention).not.toHaveBeenCalled();
    expect(a.changed).toHaveBeenCalledWith({ reason: 'kill' });
    expect(b.changed).not.toHaveBeenCalled();
  });

  it('reports whether the current project has an emitter', () => {
    runInProject(PROJECT_A, () => setRpcEventEmitter(makeEmitter()));

    expect(runInProject(PROJECT_A, () => hasRpcEventEmitter())).toBe(true);
    expect(runInProject(PROJECT_B, () => hasRpcEventEmitter())).toBe(false);
  });

  it('coalesces a burst of changes into one event listing the distinct reasons', async () => {
    const emitter = makeEmitter();
    runInProject(PROJECT_A, () => {
      setRpcEventEmitter(emitter);
      emitChanged('plan');
      emitChanged('complete');
      emitChanged('plan');
    });

    expect(emitter.changed).not.toHaveBeenCalled();
    await settle();

    expect(emitter.changed).toHaveBeenCalledTimes(1);
    expect(emitter.changed).toHaveBeenCalledWith({ reason: 'plan,complete' });
  });

  it('emits again for a change after the debounce window', async () => {
    const emitter = makeEmitter();
    runInProject(PROJECT_A, () => {
      setRpcEventEmitter(emitter);
      emitChanged('first');
    });
    await settle();
    runInProject(PROJECT_A, () => emitChanged('second'));
    await settle();

    expect(emitter.changed.mock.calls).toEqual([[{ reason: 'first' }], [{ reason: 'second' }]]);
  });

  it('drops a pending change when the emitter is removed', async () => {
    const emitter = makeEmitter();
    runInProject(PROJECT_A, () => {
      setRpcEventEmitter(emitter);
      emitChanged('late');
      setRpcEventEmitter(null);
    });
    await settle();

    expect(emitter.changed).not.toHaveBeenCalled();
  });

  it('never throws when the emitter fails', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const emitter: RpcEventEmitter = {
      changed: vi.fn(async () => {
        throw new Error('rpc down');
      }),
      attention: vi.fn(() => {
        throw new Error('sync failure');
      }),
      open: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    };

    await runInProject(PROJECT_A, async () => {
      setRpcEventEmitter(emitter);
      await expect(emitAttention({ kind: 'failed', title: 't', message: 'm' })).resolves.toBeUndefined();
      await expect(emitOpen({ sessionID: 'ses_1' })).resolves.toBeUndefined();
      emitChanged('jobs');
    });
    await settle();

    expect(emitter.changed).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledTimes(3);
    debug.mockRestore();
  });

  describe('connected clients', () => {
    it('knows no client until one asks for state', () => {
      runInProject(PROJECT_A, () => {
        setRpcEventEmitter(makeEmitter());
        expect(hasRecentClient()).toBe(false);

        recordClientSeen();
        expect(hasRecentClient()).toBe(true);
      });
    });

    it("keeps each project's clients apart", () => {
      runInProject(PROJECT_A, () => setRpcEventEmitter(makeEmitter()));
      runInProject(PROJECT_B, () => setRpcEventEmitter(makeEmitter()));

      runInProject(PROJECT_A, () => recordClientSeen());

      expect(runInProject(PROJECT_A, () => hasRecentClient())).toBe(true);
      expect(runInProject(PROJECT_B, () => hasRecentClient())).toBe(false);
    });

    it('forgets a client that has not asked for a while', async () => {
      runInProject(PROJECT_A, () => {
        setRpcEventEmitter(makeEmitter());
        recordClientSeen();
      });
      await Bun.sleep(30);

      expect(runInProject(PROJECT_A, () => hasRecentClient(10))).toBe(false);
      expect(runInProject(PROJECT_A, () => hasRecentClient(60_000))).toBe(true);
    });

    it('starts over when the plugin instance is replaced', () => {
      runInProject(PROJECT_A, () => {
        setRpcEventEmitter(makeEmitter());
        recordClientSeen();
        setRpcEventEmitter(makeEmitter());

        expect(hasRecentClient()).toBe(false);
      });
    });

    it('records nothing without an emitter', () => {
      runInProject(PROJECT_A, () => {
        recordClientSeen();
        expect(hasRecentClient()).toBe(false);
      });
    });
  });
});
