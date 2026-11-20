import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  disposeSharedState,
  getSharedOrchestrator,
  getSharedOrchestratorCallbacks,
  replaceSharedOrchestrator,
  setSharedOrchestrator,
} from '../../src/lib/orchestrator-singleton';
import { Orchestrator } from '../../src/lib/orchestrator';
import type { MCConfig } from '../../src/lib/config';
import { runInProject } from '../../src/lib/project-context';
import { setRpcEventEmitter, type RpcEventEmitter } from '../../src/lib/rpc-events';

const PROJECT = '/tmp/mc-singleton-project';

afterEach(() => {
  runInProject(PROJECT, () => setRpcEventEmitter(null));
});

describe('shared orchestrator callbacks', () => {
  it('sends a checkpoint as an attention event when the project can emit RPC events', async () => {
    const emitter: RpcEventEmitter = {
      changed: vi.fn(async () => {}),
      attention: vi.fn(async () => {}),
      open: vi.fn(async () => {}),
      output: vi.fn(async () => {}),
    };

    const delivered = runInProject(PROJECT, () => {
      setRpcEventEmitter(emitter);
      return getSharedOrchestratorCallbacks().attention('pre_merge', 'Plan "P" is paused.');
    });
    await Bun.sleep(0);

    expect(delivered).toBe(true);
    expect(emitter.attention).toHaveBeenCalledWith({
      kind: 'checkpoint',
      title: 'Checkpoint: pre_merge',
      message: 'Plan "P" is paused.',
    });
  });

  it('reports the checkpoint as undelivered without an emitter', () => {
    const delivered = runInProject(PROJECT, () =>
      getSharedOrchestratorCallbacks().attention('on_error', 'Plan "P" is paused.'),
    );

    expect(delivered).toBe(false);
  });
});

describe('shared orchestrator', () => {
  const OTHER_PROJECT = '/tmp/mc-singleton-other-project';
  const CONFIG: MCConfig = { pollInterval: 10000, worktreeBasePath: '/tmp' };

  function fakeOrchestrator() {
    return { dispose: vi.fn(async () => {}) };
  }
  type Fake = ReturnType<typeof fakeOrchestrator>;
  const asOrchestrator = (fake: Fake) => fake as unknown as Orchestrator;

  afterEach(() => {
    for (const project of [PROJECT, OTHER_PROJECT]) {
      runInProject(project, () => disposeSharedState());
    }
    vi.restoreAllMocks();
  });

  it('disposes the orchestrator it replaces', () => {
    const first = fakeOrchestrator();
    const second = fakeOrchestrator();

    runInProject(PROJECT, () => {
      setSharedOrchestrator(asOrchestrator(first));
      setSharedOrchestrator(asOrchestrator(second));
    });

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
    expect(runInProject(PROJECT, () => getSharedOrchestrator())).toBe(asOrchestrator(second));
  });

  it('does not dispose an orchestrator that is set again', () => {
    const only = fakeOrchestrator();

    runInProject(PROJECT, () => {
      setSharedOrchestrator(asOrchestrator(only));
      setSharedOrchestrator(asOrchestrator(only));
    });

    expect(only.dispose).not.toHaveBeenCalled();
  });

  it('disposes the orchestrator when it is cleared', () => {
    const only = fakeOrchestrator();

    runInProject(PROJECT, () => {
      setSharedOrchestrator(asOrchestrator(only));
      setSharedOrchestrator(null);
    });

    expect(only.dispose).toHaveBeenCalledTimes(1);
    expect(runInProject(PROJECT, () => getSharedOrchestrator())).toBeNull();
  });

  it('disposes the orchestrator when the plugin instance unloads', () => {
    // Its reconcile timer would otherwise keep running after a reload, next
    // to the orchestrator the reloaded plugin creates.
    const live = fakeOrchestrator();
    runInProject(PROJECT, () => setSharedOrchestrator(asOrchestrator(live)));

    runInProject(PROJECT, () => disposeSharedState());

    expect(live.dispose).toHaveBeenCalledTimes(1);
    expect(runInProject(PROJECT, () => getSharedOrchestrator())).toBeNull();
  });

  it("leaves another project's orchestrator alone", () => {
    const mine = fakeOrchestrator();
    const theirs = fakeOrchestrator();
    runInProject(PROJECT, () => setSharedOrchestrator(asOrchestrator(mine)));
    runInProject(OTHER_PROJECT, () => setSharedOrchestrator(asOrchestrator(theirs)));

    runInProject(PROJECT, () => disposeSharedState());

    expect(theirs.dispose).not.toHaveBeenCalled();
    expect(runInProject(OTHER_PROJECT, () => getSharedOrchestrator())).toBe(asOrchestrator(theirs));
  });

  it('replaceSharedOrchestrator waits for the old orchestrator to finish before the new one exists', async () => {
    const order: string[] = [];
    const live = {
      dispose: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('old disposed');
      }),
    };
    runInProject(PROJECT, () => setSharedOrchestrator(live as unknown as Orchestrator));

    const replacement = await runInProject(PROJECT, async () => {
      const created = await replaceSharedOrchestrator(CONFIG);
      order.push('new created');
      return created;
    });

    expect(order).toEqual(['old disposed', 'new created']);
    expect(live.dispose).toHaveBeenCalledTimes(1);
    expect(replacement).toBeInstanceOf(Orchestrator);
    expect(runInProject(PROJECT, () => getSharedOrchestrator())).toBe(replacement);
  });

  it('never leaves two live orchestrators when two callers replace at once', async () => {
    const disposeSpy = vi.spyOn(Orchestrator.prototype, 'dispose');
    runInProject(PROJECT, () => setSharedOrchestrator(fakeOrchestrator() as unknown as Orchestrator));

    const [first, second] = await runInProject(PROJECT, () =>
      Promise.all([replaceSharedOrchestrator(CONFIG), replaceSharedOrchestrator(CONFIG)]),
    );

    const current = runInProject(PROJECT, () => getSharedOrchestrator());
    const retired = current === first ? second : first;
    expect([first, second]).toContain(current);
    expect(retired.isDisposed()).toBe(true);
    expect(current?.isDisposed()).toBe(false);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('still installs a new orchestrator when the old one fails to shut down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { dispose: vi.fn(async () => { throw new Error('boom'); }) };
    runInProject(PROJECT, () => setSharedOrchestrator(broken as unknown as Orchestrator));

    const replacement = await runInProject(PROJECT, () => replaceSharedOrchestrator(CONFIG));

    expect(runInProject(PROJECT, () => getSharedOrchestrator())).toBe(replacement);
    expect(warn).toHaveBeenCalled();
  });
});
