import { describe, it, expect, vi, afterEach } from 'vitest';
import { missionControlRpc } from '../src/rpc';
import { setToastEmitter, showToast } from '../src/lib/toast';
import tuiPlugin from '../src/tui.tsx';
import { runInProject } from '../src/lib/project-context';
import { createFakeContext, EMPTY_SNAPSHOT } from './tui/fake-context';

afterEach(() => {
  setToastEmitter(null);
});

describe('toast emitters', () => {
  it('are kept per project', async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    runInProject('/tmp/mc-toast-a', () => setToastEmitter(a));

    await runInProject('/tmp/mc-toast-b', () => showToast({ message: 'other project' }));
    expect(a).not.toHaveBeenCalled();

    await runInProject('/tmp/mc-toast-a', () => showToast({ message: 'mine' }));
    expect(a).toHaveBeenCalledWith({ message: 'mine' });
    runInProject('/tmp/mc-toast-a', () => setToastEmitter(null));
  });
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

  it('defines every method with a content output and a declared failed error', () => {
    const methods = missionControlRpc.methods;
    expect(Object.keys(methods).sort()).toEqual(
      ['answer', 'approve', 'cancelPlan', 'capture', 'cleanup', 'kill', 'launch', 'snapshot'].sort(),
    );

    for (const name of ['kill', 'cleanup', 'answer', 'approve', 'cancelPlan', 'capture', 'launch'] as const) {
      const method = methods[name];
      expect(method.output.safeParse({ content: 'ok' }).success).toBe(true);
      expect(method.output.safeParse({}).success).toBe(false);
      expect(method.errors.failed.safeParse({ message: 'nope' }).success).toBe(true);
      expect(method.errors.failed.safeParse({}).success).toBe(false);
    }
  });

  it('validates action inputs', () => {
    const { kill, cleanup, answer, approve, cancelPlan, capture, launch, snapshot } = missionControlRpc.methods;

    expect(snapshot.input.safeParse({}).success).toBe(true);
    expect(cancelPlan.input.safeParse({}).success).toBe(true);
    expect(kill.input.safeParse({ name: 'a' }).success).toBe(true);
    expect(kill.input.safeParse({}).success).toBe(false);
    expect(cleanup.input.safeParse({}).success).toBe(true);
    expect(cleanup.input.safeParse({ name: 'a', all: false, deleteBranch: true }).success).toBe(true);
    expect(answer.input.safeParse({ name: 'a', response: 'r' }).success).toBe(true);
    expect(answer.input.safeParse({ name: 'a' }).success).toBe(false);
    expect(approve.input.safeParse({}).success).toBe(true);
    expect(approve.input.safeParse({ checkpoint: 'pre_pr' }).success).toBe(true);
    expect(approve.input.safeParse({ checkpoint: 'later' }).success).toBe(false);
    expect(capture.input.safeParse({ name: 'a', lines: 20 }).success).toBe(true);
    expect(capture.input.safeParse({ name: 'a', lines: 'many' }).success).toBe(false);
    expect(launch.input.safeParse({ name: 'a', prompt: 'p', agent: 'build', model: 'x/y', baseBranch: 'main' }).success).toBe(true);
    expect(launch.input.safeParse({ name: 'a' }).success).toBe(false);
  });

  it('validates the snapshot output', () => {
    const { output } = missionControlRpc.methods.snapshot;
    const counts = { running: 1, blocked: 0, completed: 0, failed: 0, stopped: 0 };
    const job = {
      id: 'job-1',
      name: 'alpha',
      status: 'running',
      attention: 'blocked',
      branch: 'mc/alpha',
      worktreePath: '/tmp/wt/alpha',
      sessionID: 'ses_1',
      createdAt: '2026-11-16T10:00:00.000Z',
      report: { status: 'blocked', message: 'help', progress: 10 },
      activity: { currentTool: 'edit', filesEdited: 2 },
    };
    const plan = {
      id: 'plan-1',
      name: 'Release',
      mode: 'supervisor',
      status: 'paused',
      checkpoint: 'pre_merge',
      checkpointMessage: 'Waiting',
      jobs: [{ name: 'alpha', status: 'running', dependsOn: [] }],
    };

    expect(output.safeParse({ jobs: [], plan: null, counts }).success).toBe(true);
    expect(output.safeParse({ jobs: [job], plan, counts }).success).toBe(true);
    expect(output.safeParse({ jobs: [{ ...job, status: 'paused' }], plan: null, counts }).success).toBe(false);
    expect(output.safeParse({ jobs: [{ ...job, attention: 'urgent' }], plan: null, counts }).success).toBe(false);
    expect(output.safeParse({ jobs: [], plan: null }).success).toBe(false);
  });

  it('defines the changed, attention and open events', () => {
    const { changed, attention, open } = missionControlRpc.events;

    expect(changed.schema.safeParse({ reason: 'plan' }).success).toBe(true);
    expect(changed.schema.safeParse({}).success).toBe(false);
    for (const kind of ['complete', 'failed', 'blocked', 'needs_review', 'question', 'checkpoint']) {
      expect(attention.schema.safeParse({ kind, title: 't', message: 'm' }).success).toBe(true);
    }
    expect(
      attention.schema.safeParse({ kind: 'blocked', title: 't', message: 'm', jobName: 'a', sessionID: 'ses_1' })
        .success,
    ).toBe(true);
    expect(attention.schema.safeParse({ kind: 'other', title: 't', message: 'm' }).success).toBe(false);
    expect(open.schema.safeParse({ sessionID: 'ses_1' }).success).toBe(true);
    expect(open.schema.safeParse({ sessionID: 'ses_1', title: '[MC] a' }).success).toBe(true);
    expect(open.schema.safeParse({ title: 'x' }).success).toBe(false);
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
  const PROJECT = '/tmp/mc-tui-project';
  const here = { directory: PROJECT };
  const elsewhere = { directory: '/tmp/mc-other-project' };

  const definition = tuiPlugin as unknown as {
    id: string;
    setup: (ctx: unknown) => () => void;
  };

  const tick = () => Bun.sleep(0);

  it('keeps its plugin id', () => {
    expect(definition.id).toBe('opencode-mission-control-tui');
  });

  it('shows a toast when a toast RPC event arrives and unsubscribes on cleanup', () => {
    const fake = createFakeContext();
    const cleanup = definition.setup(fake.context);

    fake.emit('toast', { data: { message: 'job finished', variant: 'not-a-variant' } });

    expect(fake.ui.toast.show).toHaveBeenCalledWith({
      title: 'Mission Control',
      message: 'job finished',
      variant: 'info',
      duration: 5000,
    });

    cleanup();
    expect(fake.unsubscribes.get('toast')).toHaveBeenCalledTimes(1);
  });

  it('subscribes to every event and fetches a snapshot for its location on setup', async () => {
    const fake = createFakeContext({ directory: PROJECT });
    const cleanup = definition.setup(fake.context);
    await tick();

    expect(fake.rpc.events.on.mock.calls.map(([name]) => name).sort()).toEqual([
      'attention',
      'changed',
      'open',
      'output',
      'toast',
    ]);
    expect(fake.rpc.snapshot).toHaveBeenCalledTimes(1);
    expect(fake.rpc.snapshot).toHaveBeenCalledWith({}, { location: here });

    cleanup();
  });

  it('registers the footer, sidebar and panel slots and the dashboard page', () => {
    const fake = createFakeContext({ directory: PROJECT });
    const cleanup = definition.setup(fake.context);

    expect(fake.slots.map(({ claim }) => claim.append)).toEqual([
      'prompt.footer.status',
      'sidebar.content',
      'session.panel',
    ]);
    for (const { claim } of fake.slots) {
      expect(claim.render).toBeTypeOf('function');
    }
    expect(fake.ui.router.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'dashboard', render: expect.any(Function) }),
    );

    cleanup();
  });

  it('registers the dashboard command in the palette and as /mc-dashboard', () => {
    const fake = createFakeContext({ directory: PROJECT });
    const cleanup = definition.setup(fake.context);

    expect(fake.keymap.layer).toHaveBeenCalledTimes(1);
    const layer = fake.layers[0]();
    expect(layer.mode).toBe('global');
    expect(layer.bindings).toEqual(['mission-control.dashboard']);
    expect(layer.commands).toHaveLength(1);
    expect(layer.commands?.[0]).toMatchObject({
      id: 'mission-control.dashboard',
      palette: true,
      slash: { name: 'mc-dashboard' },
      bind: '<leader>j',
    });

    cleanup();
  });

  it('opens the dashboard panel, or the page when no session panel is available', () => {
    const inSession = createFakeContext({ directory: PROJECT, panelOpens: true });
    const cleanupA = definition.setup(inSession.context);
    (inSession.layers[0]().commands?.[0].run as () => void)();
    expect(inSession.ui.panel.open).toHaveBeenCalledWith('mission-control.dashboard');
    expect(inSession.ui.router.navigate).not.toHaveBeenCalled();
    cleanupA();

    const onHome = createFakeContext({ directory: PROJECT, panelOpens: false });
    const cleanupB = definition.setup(onHome.context);
    (onHome.layers[0]().commands?.[0].run as () => void)();
    expect(onHome.ui.router.navigate).toHaveBeenCalledWith({ type: 'plugin', name: 'dashboard' });
    cleanupB();
  });

  it('refetches the snapshot on a changed event from its own project only', async () => {
    const fake = createFakeContext({ directory: PROJECT });
    const cleanup = definition.setup(fake.context);
    await tick();
    expect(fake.rpc.snapshot).toHaveBeenCalledTimes(1);

    fake.emit('changed', { data: { reason: 'plan' }, location: elsewhere });
    await tick();
    expect(fake.rpc.snapshot).toHaveBeenCalledTimes(1);

    fake.emit('changed', { data: { reason: 'plan' }, location: here });
    await tick();
    expect(fake.rpc.snapshot).toHaveBeenCalledTimes(2);

    cleanup();
  });

  it('ignores toasts, attention and open requests from other projects', () => {
    const fake = createFakeContext({ directory: PROJECT });
    const cleanup = definition.setup(fake.context);

    fake.emit('toast', { data: { message: 'other' }, location: elsewhere });
    fake.emit('attention', { data: { kind: 'failed', title: 't', message: 'm' }, location: elsewhere });
    fake.emit('open', { data: { sessionID: 'ses_other' }, location: elsewhere });

    expect(fake.ui.toast.show).not.toHaveBeenCalled();
    expect(fake.attention.notify).not.toHaveBeenCalled();
    expect(fake.ui.tabs.focus).not.toHaveBeenCalled();

    cleanup();
  });

  it('turns an attention event into a toast and a notification when blurred', () => {
    const fake = createFakeContext({ directory: PROJECT });
    const cleanup = definition.setup(fake.context);

    fake.emit('attention', {
      data: { kind: 'blocked', title: 'Job "a" is blocked', message: 'Need a key.', jobName: 'a' },
      location: here,
    });

    const toast = fake.ui.toast.show.mock.calls[0][0];
    expect(toast.title).toBe('Job "a" is blocked');
    expect(toast.message).toContain('Need a key.');
    expect(toast.message).toContain('/mc-dashboard');
    expect(toast.variant).toBe('warning');
    expect(fake.attention.notify).toHaveBeenCalledWith({
      title: 'Job "a" is blocked',
      message: toast.message,
      notification: { when: 'blurred' },
      sound: { name: 'question', when: 'blurred' },
    });

    cleanup();
  });

  it('ignores malformed attention data and survives a failed notification', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const fake = createFakeContext({ directory: PROJECT });
    const cleanup = definition.setup(fake.context);

    fake.emit('attention', { data: { kind: 'nonsense', message: 'x' }, location: here });
    expect(fake.ui.toast.show).not.toHaveBeenCalled();

    fake.attention.notify.mockRejectedValueOnce(new Error('renderer destroyed'));
    fake.emit('attention', { data: { kind: 'complete', title: 't', message: 'm' }, location: here });
    await tick();
    expect(fake.ui.toast.show).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledTimes(1);

    debug.mockRestore();
    cleanup();
  });

  it('focuses the session tab on an open event, or navigates when tabs are disabled', () => {
    const tabs = createFakeContext({ directory: PROJECT, tabs: true });
    const cleanupA = definition.setup(tabs.context);
    tabs.emit('open', { data: { sessionID: 'ses_job', title: '[MC] a' }, location: here });
    expect(tabs.ui.tabs.focus).toHaveBeenCalledWith('ses_job');
    expect(tabs.ui.router.navigate).not.toHaveBeenCalled();
    cleanupA();

    const noTabs = createFakeContext({ directory: PROJECT, tabs: false });
    const cleanupB = definition.setup(noTabs.context);
    noTabs.emit('open', { data: { sessionID: 'ses_job' }, location: here });
    expect(noTabs.ui.router.navigate).toHaveBeenCalledWith({ type: 'session', sessionID: 'ses_job' });
    cleanupB();
  });

  describe('a tab in a job worktree', () => {
    const WORKTREE = '/tmp/mc-tui-worktrees/mc-alpha';
    const homeSnapshot = {
      ...EMPTY_SNAPSHOT,
      home: PROJECT,
      jobs: [
        {
          id: 'job-1',
          name: 'alpha',
          status: 'running' as const,
          attention: 'none' as const,
          branch: 'mc/alpha',
          worktreePath: WORKTREE,
          sessionID: 'ses_alpha',
          createdAt: '2026-11-16T10:00:00.000Z',
        },
      ],
    };
    const moveTo = (fake: ReturnType<typeof createFakeContext>, directory: string) => {
      (fake.context as unknown as { location: { directory: string } }).location = { directory };
    };
    const calledDirectories = (fake: ReturnType<typeof createFakeContext>) =>
      fake.rpc.snapshot.mock.calls.map(([, options]) => (options as { location: { directory: string } }).location.directory);

    async function openJobTab() {
      const fake = createFakeContext({ directory: PROJECT });
      fake.rpc.snapshot.mockResolvedValue(homeSnapshot);
      const cleanup = definition.setup(fake.context);
      await tick();
      // The user opens the job's session: the tab now sits in the job's worktree.
      moveTo(fake, WORKTREE);
      fake.rpc.snapshot.mockClear();
      return { fake, cleanup };
    }

    it("asks the project's home when the worktree's instance points there", async () => {
      const { fake, cleanup } = await openJobTab();
      fake.rpc.snapshot.mockImplementation((async (_input: unknown, options: { location: { directory: string } }) =>
        options.location.directory === WORKTREE ? { ...EMPTY_SNAPSHOT, home: PROJECT } : homeSnapshot) as never);

      fake.emit('changed', { data: { reason: 'x' }, location: here });
      await tick();

      expect(calledDirectories(fake)).toEqual([WORKTREE, PROJECT]);
      cleanup();
    });

    it("keeps showing the project's jobs when the worktree's instance is gone", async () => {
      // The job was cleaned up: its worktree no longer has a plugin instance.
      // The whole job list used to disappear from this tab.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { fake, cleanup } = await openJobTab();
      fake.rpc.snapshot.mockImplementation((async (_input: unknown, options: { location: { directory: string } }) => {
        if (options.location.directory === WORKTREE) {
          throw { type: 'rpc.unavailable', message: 'RPC not registered' };
        }
        return { ...homeSnapshot, jobs: [] };
      }) as never);

      fake.emit('changed', { data: { reason: 'cleanup' }, location: here });
      await tick();
      // And again: the cleaned-up job is no longer in the snapshot, the tab is
      // still in its worktree.
      fake.emit('changed', { data: { reason: 'x' }, location: here });
      await tick();

      expect(calledDirectories(fake)).toEqual([WORKTREE, PROJECT, WORKTREE, PROJECT]);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
      cleanup();
    });

    it("does not show one project's jobs in another project that has no Mission Control", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fake = createFakeContext({ directory: PROJECT });
      fake.rpc.snapshot.mockResolvedValue(homeSnapshot);
      const cleanup = definition.setup(fake.context);
      await tick();
      moveTo(fake, elsewhere.directory);
      fake.rpc.snapshot.mockClear();
      fake.rpc.snapshot.mockRejectedValue({ type: 'rpc.unavailable', message: 'RPC not registered' });

      fake.emit('changed', { data: { reason: 'x' } });
      await tick();

      // Only the other project was asked; nothing fell back to the first one.
      expect(calledDirectories(fake)).toEqual([elsewhere.directory]);
      warn.mockRestore();
      cleanup();
    });
  });

  it('stays quiet when the server part is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = createFakeContext({ directory: PROJECT });
    fake.rpc.snapshot.mockRejectedValue({ type: 'rpc.unavailable', message: 'RPC not registered' });

    const cleanup = definition.setup(fake.context);
    await tick();
    fake.emit('changed', { data: { reason: 'x' }, location: here });
    await tick();

    expect(fake.rpc.snapshot).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fake.ui.toast.show).not.toHaveBeenCalled();

    warn.mockRestore();
    cleanup();
  });

  it('cleans up subscriptions, slots, the page and the refresh timer', async () => {
    const fake = createFakeContext({ directory: PROJECT });
    fake.rpc.snapshot.mockResolvedValue(EMPTY_SNAPSHOT);
    const cleanup = definition.setup(fake.context);
    await tick();

    cleanup();

    for (const name of ['toast', 'changed', 'attention', 'open']) {
      expect(fake.unsubscribes.get(name)).toHaveBeenCalledTimes(1);
    }
    for (const { dispose } of fake.slots) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
    expect(fake.routeDispose).toHaveBeenCalledTimes(1);

    // A stopped store no longer fetches.
    const calls = fake.rpc.snapshot.mock.calls.length;
    await tick();
    expect(fake.rpc.snapshot.mock.calls.length).toBe(calls);
  });
});
