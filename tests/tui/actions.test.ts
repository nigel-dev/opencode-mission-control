import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobView, PlanView } from '../../src/rpc';
import { createActions, type Actions, type MissionControlRpcClient } from '../../src/tui/actions';
import { createFakeContext } from './fake-context';

const PROJECT = '/tmp/mc-tui-project';
const CALL_OPTIONS = { location: { directory: PROJECT } };

function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'job-1',
    name: 'alpha',
    status: 'running',
    attention: 'none',
    branch: 'mc/alpha',
    worktreePath: '/tmp/wt/alpha',
    sessionID: 'ses_alpha',
    createdAt: '2026-11-16T10:00:00.000Z',
    ...overrides,
  };
}

function plan(overrides: Partial<PlanView> = {}): PlanView {
  return { id: 'plan-1', name: 'Release', mode: 'supervisor', status: 'running', jobs: [], ...overrides };
}

describe('tui actions', () => {
  let fake: ReturnType<typeof createFakeContext>;
  let refresh: ReturnType<typeof vi.fn>;
  let showTranscript: ReturnType<typeof vi.fn>;
  let actions: Actions;

  const setup = (options: Parameters<typeof createFakeContext>[0] = {}) => {
    fake = createFakeContext({ directory: PROJECT, ...options });
    refresh = vi.fn(async () => {});
    showTranscript = vi.fn();
    actions = createActions({
      context: fake.context,
      rpc: fake.rpc as unknown as MissionControlRpcClient,
      location: { directory: PROJECT },
      refresh,
      showTranscript,
    });
  };

  beforeEach(() => setup());

  describe('open', () => {
    it('focuses the session tab when tabs are enabled', () => {
      actions.openJob(job());

      expect(fake.ui.tabs.focus).toHaveBeenCalledWith('ses_alpha');
      expect(fake.ui.router.navigate).not.toHaveBeenCalled();
    });

    it('navigates to the session when tabs are disabled', () => {
      setup({ tabs: false });

      actions.openSession('ses_alpha');

      expect(fake.ui.tabs.focus).not.toHaveBeenCalled();
      expect(fake.ui.router.navigate).toHaveBeenCalledWith({ type: 'session', sessionID: 'ses_alpha' });
    });

    it('navigates when focusing the tab reports failure', () => {
      fake.ui.tabs.focus.mockReturnValue(false);

      actions.openSession('ses_alpha');

      expect(fake.ui.router.navigate).toHaveBeenCalledWith({ type: 'session', sessionID: 'ses_alpha' });
    });

    it('warns for a job without a session', () => {
      actions.openJob(job({ sessionID: undefined }));

      expect(fake.ui.tabs.focus).not.toHaveBeenCalled();
      expect(fake.ui.toast.show).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));
    });
  });

  describe('kill', () => {
    it('confirms, calls the RPC for this project, toasts the result and refetches', async () => {
      await actions.kill(job());

      expect(fake.ui.dialog.confirm).toHaveBeenCalledTimes(1);
      expect(fake.rpc.kill).toHaveBeenCalledWith({ name: 'alpha' }, CALL_OPTIONS);
      expect(fake.ui.toast.show).toHaveBeenCalledWith({
        title: 'Mission Control',
        message: 'Job stopped successfully.',
        variant: 'success',
      });
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the confirmation is declined', async () => {
      fake.ui.dialog.confirm.mockResolvedValue(false);

      await actions.kill(job());

      expect(fake.rpc.kill).not.toHaveBeenCalled();
    });

    it('does not ask for a job that is not running', async () => {
      await actions.kill(job({ status: 'completed' }));

      expect(fake.ui.dialog.confirm).not.toHaveBeenCalled();
      expect(fake.rpc.kill).not.toHaveBeenCalled();
    });

    it('shows a declared failure as an error toast', async () => {
      fake.rpc.kill.mockRejectedValue({
        type: 'failed',
        message: 'failed',
        data: { message: 'Job "alpha" not found' },
      });

      await actions.kill(job());

      expect(fake.ui.toast.show).toHaveBeenCalledWith({
        title: 'Mission Control',
        message: 'Job "alpha" not found',
        variant: 'error',
      });
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('confirms and cleans up a finished job', async () => {
      await actions.cleanup(job({ status: 'completed' }));

      expect(fake.ui.dialog.confirm).toHaveBeenCalledTimes(1);
      expect(fake.rpc.cleanup).toHaveBeenCalledWith({ name: 'alpha' }, CALL_OPTIONS);
    });

    it('refuses a running job', async () => {
      await actions.cleanup(job());

      expect(fake.ui.dialog.confirm).not.toHaveBeenCalled();
      expect(fake.rpc.cleanup).not.toHaveBeenCalled();
      expect(fake.ui.toast.show).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));
    });

    const refusal = {
      type: 'failed',
      data: {
        message:
          '✗ Failed to cleanup job "alpha": its worktree has uncommitted changes that would be lost: src/new.ts. Commit or discard them, or pass force: true to remove the worktree anyway.',
      },
    };

    it('shows why the server refused and forces the cleanup only after a second confirmation', async () => {
      fake.rpc.cleanup.mockRejectedValueOnce(refusal);

      await actions.cleanup(job({ status: 'completed' }));

      expect(fake.ui.dialog.confirm).toHaveBeenCalledTimes(2);
      expect(fake.ui.dialog.confirm).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: 'Force clean up of job "alpha"?',
          message: expect.stringContaining('uncommitted changes that would be lost: src/new.ts'),
        }),
      );
      expect(fake.rpc.cleanup).toHaveBeenNthCalledWith(1, { name: 'alpha' }, CALL_OPTIONS);
      expect(fake.rpc.cleanup).toHaveBeenNthCalledWith(2, { name: 'alpha', force: true }, CALL_OPTIONS);
      expect(refresh).toHaveBeenCalled();
    });

    it('does not force the cleanup when the second confirmation is declined', async () => {
      fake.rpc.cleanup.mockRejectedValueOnce(refusal);
      fake.ui.dialog.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await actions.cleanup(job({ status: 'completed' }));

      expect(fake.rpc.cleanup).toHaveBeenCalledTimes(1);
    });

    it('just reports a failure that forcing would not fix', async () => {
      fake.rpc.cleanup.mockRejectedValueOnce({ type: 'failed', data: { message: 'Job "alpha" not found' } });

      await actions.cleanup(job({ status: 'completed' }));

      expect(fake.ui.dialog.confirm).toHaveBeenCalledTimes(1);
      expect(fake.rpc.cleanup).toHaveBeenCalledTimes(1);
      expect(fake.ui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Job "alpha" not found', variant: 'error' }),
      );
    });
  });

  describe('answer', () => {
    it('prompts and sends the response', async () => {
      fake.ui.dialog.prompt.mockResolvedValue('use blue');

      await actions.answer(job({ report: { status: 'blocked', message: 'Which color?' } }));

      expect(fake.ui.dialog.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Which color?' }),
      );
      expect(fake.rpc.answer).toHaveBeenCalledWith({ name: 'alpha', response: 'use blue' }, CALL_OPTIONS);
    });

    it('sends nothing when the prompt is dismissed or empty', async () => {
      await actions.answer(job());
      fake.ui.dialog.prompt.mockResolvedValue('   ');
      await actions.answer(job());

      expect(fake.rpc.answer).not.toHaveBeenCalled();
    });

    it('answers a pending form through the form API instead', async () => {
      const form = {
        id: 'frm_1',
        sessionID: 'ses_alpha',
        title: 'Which color?',
        fields: [
          { key: 'color', type: 'string', options: [{ value: 'b', label: 'Blue' }] },
          { key: 'ok', type: 'boolean' },
        ],
      };
      fake.form.list.mockReturnValue([form]);
      fake.ui.dialog.prompt.mockResolvedValueOnce('Blue').mockResolvedValueOnce('yes');

      await actions.answer(job());

      expect(fake.form.list).toHaveBeenCalledWith('ses_alpha', { directory: '/tmp/wt/alpha' });
      expect(fake.ui.dialog.prompt).toHaveBeenCalledTimes(2);
      expect(fake.form.reply).toHaveBeenCalledWith(
        { sessionID: 'ses_alpha', formID: 'frm_1', answer: { color: 'b', ok: true } },
        { directory: '/tmp/wt/alpha' },
      );
      expect(fake.rpc.answer).not.toHaveBeenCalled();
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('abandons a form when a field prompt is dismissed', async () => {
      fake.form.list.mockReturnValue([
        { id: 'frm_1', sessionID: 'ses_alpha', title: 'Q', fields: [{ key: 'a', type: 'string' }] },
      ]);

      await actions.answer(job());

      expect(fake.form.reply).not.toHaveBeenCalled();
    });

    it('reports a failed form reply', async () => {
      fake.form.list.mockReturnValue([
        { id: 'frm_1', sessionID: 'ses_alpha', title: 'Q', fields: [{ key: 'a', type: 'string' }] },
      ]);
      fake.ui.dialog.prompt.mockResolvedValue('x');
      fake.form.reply.mockRejectedValue(new Error('form gone'));

      await actions.answer(job());

      expect(fake.ui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'form gone', variant: 'error' }),
      );
    });
  });

  describe('pending forms', () => {
    it('finds no form for a finished job or a job without a session', () => {
      expect(actions.pendingForm(job({ status: 'completed' }))).toBeUndefined();
      expect(actions.pendingForm(job({ sessionID: undefined }))).toBeUndefined();
      expect(fake.form.list).not.toHaveBeenCalled();
    });

    it('tolerates an unloaded form list', () => {
      fake.form.list.mockReturnValue(undefined);

      expect(actions.pendingForm(job())).toBeUndefined();
    });

    it('syncs the forms of running jobs only, tolerating failures', async () => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      fake.form.sync.mockRejectedValueOnce(new Error('session gone'));

      actions.syncForms([
        job(),
        job({ name: 'beta', sessionID: 'ses_beta', worktreePath: '/tmp/wt/beta' }),
        job({ name: 'done', status: 'completed' }),
        job({ name: 'legacy', sessionID: undefined }),
      ]);
      await Bun.sleep(0);

      expect(fake.form.sync.mock.calls).toEqual([
        ['ses_alpha', { directory: '/tmp/wt/alpha' }],
        ['ses_beta', { directory: '/tmp/wt/beta' }],
      ]);
      expect(debug).toHaveBeenCalledTimes(1);
      debug.mockRestore();
    });
  });

  describe('transcript', () => {
    it('captures the tail and hands it to the view', async () => {
      await actions.transcript(job());

      expect(fake.rpc.capture).toHaveBeenCalledWith({ name: 'alpha', lines: 200 }, CALL_OPTIONS);
      expect(showTranscript).toHaveBeenCalledWith('Transcript of "alpha"', 'line 1\nline 2');
    });

    it('shows an error toast when the capture fails', async () => {
      fake.rpc.capture.mockRejectedValue({ type: 'failed', message: 'no session', data: { message: 'no session' } });

      await actions.transcript(job());

      expect(showTranscript).not.toHaveBeenCalled();
      expect(fake.ui.toast.show).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }));
    });
  });

  describe('plan', () => {
    it('approves the current checkpoint after confirmation', async () => {
      await actions.approve(plan({ status: 'paused', checkpoint: 'pre_merge', checkpointMessage: 'Waiting' }));

      expect(fake.ui.dialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Waiting' }));
      expect(fake.rpc.approve).toHaveBeenCalledWith({ checkpoint: 'pre_merge' }, CALL_OPTIONS);
    });

    it('approves a pending plan without a checkpoint', async () => {
      await actions.approve(plan({ status: 'pending' }));

      expect(fake.rpc.approve).toHaveBeenCalledWith({}, CALL_OPTIONS);
    });

    it('has nothing to approve on a running plan without a checkpoint', async () => {
      await actions.approve(plan());

      expect(fake.ui.dialog.confirm).not.toHaveBeenCalled();
      expect(fake.rpc.approve).not.toHaveBeenCalled();
    });

    it('cancels the plan only after confirmation', async () => {
      fake.ui.dialog.confirm.mockResolvedValueOnce(undefined);
      await actions.cancelPlan(plan());
      expect(fake.rpc.cancelPlan).not.toHaveBeenCalled();

      await actions.cancelPlan(plan());
      expect(fake.rpc.cancelPlan).toHaveBeenCalledWith({}, CALL_OPTIONS);
    });
  });

  describe('launch', () => {
    it('asks for a name then a task and launches', async () => {
      fake.ui.dialog.prompt.mockResolvedValueOnce(' fix-login ').mockResolvedValueOnce('Fix the login bug');

      await actions.launch();

      expect(fake.rpc.launch).toHaveBeenCalledWith({ name: 'fix-login', prompt: 'Fix the login bug' }, CALL_OPTIONS);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid name without asking for the task', async () => {
      fake.ui.dialog.prompt.mockResolvedValueOnce('bad name');

      await actions.launch();

      expect(fake.ui.dialog.prompt).toHaveBeenCalledTimes(1);
      expect(fake.rpc.launch).not.toHaveBeenCalled();
      expect(fake.ui.toast.show).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }));
    });

    it('launches nothing when either prompt is dismissed', async () => {
      await actions.launch();
      fake.ui.dialog.prompt.mockResolvedValueOnce('ok-name').mockResolvedValueOnce(undefined);
      await actions.launch();

      expect(fake.rpc.launch).not.toHaveBeenCalled();
    });
  });

  it('sends no location when the TUI has none', async () => {
    fake = createFakeContext();
    actions = createActions({
      context: fake.context,
      rpc: fake.rpc as unknown as MissionControlRpcClient,
      location: undefined,
      refresh: vi.fn(async () => {}),
      showTranscript: vi.fn(),
    });

    await actions.kill(job());

    expect(fake.rpc.kill).toHaveBeenCalledWith({ name: 'alpha' }, undefined);
  });
});
