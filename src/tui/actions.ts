import type { FormInfo, LocationRef, RpcClient } from '@opencode/client';
import type { Plugin as Tui } from '@opencode/plugin/tui';
import type { ActionResult, JobView, PlanView, missionControlRpc } from '../rpc';
import {
  answerableFields,
  buildFormReply,
  errorText,
  firstLine,
  formFieldPrompt,
  validateJobName,
} from './format';

export type MissionControlRpcClient = RpcClient<typeof missionControlRpc>;

const TRANSCRIPT_LINES = 200;
const TITLE = 'Mission Control';

export interface ActionDeps {
  context: Tui.Context;
  rpc: MissionControlRpcClient;
  /** The project this TUI shows; RPC calls are sent to its plugin instance. */
  /** Mutable: `directory` is re-pointed at the project's owning plugin instance once known. */
  location: { directory?: string } | undefined;
  refresh: () => Promise<void>;
  /** Shows a job's transcript tail; provided by the view layer. */
  showTranscript: (title: string, text: string) => void;
}

export interface Actions {
  openSession(sessionID: string): void;
  openJob(job: JobView): void;
  kill(job: JobView): Promise<void>;
  cleanup(job: JobView): Promise<void>;
  answer(job: JobView): Promise<void>;
  transcript(job: JobView): Promise<void>;
  approve(plan: PlanView): Promise<void>;
  cancelPlan(plan: PlanView): Promise<void>;
  launch(): Promise<void>;
  /** The form a job's session is waiting on, if any. Reactive in a Solid computation. */
  pendingForm(job: JobView): FormInfo | undefined;
  /** Load the pending forms of the running jobs into the TUI's data cache. */
  syncForms(jobs: readonly JobView[]): void;
}

function jobLocation(job: JobView): LocationRef {
  // A job's session lives in its worktree, which is its own location.
  return { directory: job.worktreePath };
}

export function createActions(deps: ActionDeps): Actions {
  const { context, rpc } = deps;
  // Read on every call: the owning directory is resolved after the first snapshot.
  const callOptions = () =>
    deps.location?.directory ? { location: { directory: deps.location.directory } } : undefined;

  const toast = (message: string, variant: 'success' | 'error' | 'warning' | 'info'): void => {
    context.ui.toast.show({ title: TITLE, message, variant });
  };

  /** Run an RPC action, report its outcome as a toast, and refetch state. */
  const run = async (call: () => Promise<ActionResult>): Promise<ActionResult | undefined> => {
    try {
      const result = await call();
      toast(firstLine(result.content) || 'Done', 'success');
      await deps.refresh();
      return result;
    } catch (error) {
      toast(errorText(error), 'error');
      return undefined;
    }
  };

  const openSession = (sessionID: string): void => {
    // With tabs enabled, focus opens the tab when needed; `false` means tabs
    // turned out to be unavailable, so fall back to plain navigation.
    if (context.ui.tabs.enabled() && context.ui.tabs.focus(sessionID)) {
      return;
    }
    context.ui.router.navigate({ type: 'session', sessionID });
  };

  const pendingForm = (job: JobView): FormInfo | undefined => {
    if (job.status !== 'running' || !job.sessionID) {
      return undefined;
    }
    const forms = context.data.session.form.list(job.sessionID, jobLocation(job)) ?? [];
    return forms.find((form) => answerableFields(form).length > 0);
  };

  const answerForm = async (job: JobView, form: FormInfo): Promise<void> => {
    const responses: string[] = [];
    for (const field of answerableFields(form)) {
      const response = await context.ui.dialog.prompt(formFieldPrompt(form, field));
      if (response === undefined) {
        return;
      }
      responses.push(response);
    }

    try {
      await context.data.session.form.reply(buildFormReply(form, responses), jobLocation(job));
      toast(`Answered the form of job "${job.name}".`, 'success');
      await deps.refresh();
    } catch (error) {
      toast(errorText(error), 'error');
    }
  };

  return {
    openSession,

    openJob(job) {
      if (!job.sessionID) {
        toast(`Job "${job.name}" has no session to open.`, 'warning');
        return;
      }
      openSession(job.sessionID);
    },

    async kill(job) {
      if (job.status !== 'running') {
        toast(`Job "${job.name}" is not running.`, 'warning');
        return;
      }
      const confirmed = await context.ui.dialog.confirm({
        title: `Stop job "${job.name}"?`,
        message: 'Its session is interrupted. The worktree and branch are kept.',
        label: { confirm: 'Stop job', cancel: 'Cancel' },
      });
      if (!confirmed) return;
      await run(() => rpc.kill({ name: job.name }, callOptions()));
    },

    async cleanup(job) {
      if (job.status === 'running') {
        toast(`Job "${job.name}" is still running. Stop it first (x).`, 'warning');
        return;
      }
      const confirmed = await context.ui.dialog.confirm({
        title: `Clean up job "${job.name}"?`,
        message: `Removes its worktree and session. The branch ${job.branch} is kept.`,
        label: { confirm: 'Clean up', cancel: 'Cancel' },
      });
      if (!confirmed) return;
      try {
        const result = await rpc.cleanup({ name: job.name }, callOptions());
        toast(firstLine(result.content) || 'Done', 'success');
        await deps.refresh();
      } catch (error) {
        // The server refuses to discard uncommitted work or to take a job out
        // of an active plan unless forced: show why and let the user decide.
        const reason = errorText(error);
        if (!/force: true/.test(reason)) {
          toast(reason, 'error');
          return;
        }
        const forced = await context.ui.dialog.confirm({
          title: `Force clean up of job "${job.name}"?`,
          message: reason,
          label: { confirm: 'Remove anyway', cancel: 'Keep' },
        });
        if (!forced) return;
        await run(() => rpc.cleanup({ name: job.name, force: true }, callOptions()));
      }
    },

    async answer(job) {
      if (job.status !== 'running') {
        toast(`Job "${job.name}" is not running.`, 'warning');
        return;
      }
      const form = pendingForm(job);
      if (form) {
        await answerForm(job, form);
        return;
      }
      const response = await context.ui.dialog.prompt({
        title: `Message for job "${job.name}"`,
        description: job.report?.message,
        placeholder: 'Answer or further instructions',
      });
      if (response === undefined || response.trim() === '') return;
      await run(() => rpc.answer({ name: job.name, response }, callOptions()));
    },

    async transcript(job) {
      try {
        const result = await rpc.capture({ name: job.name, lines: TRANSCRIPT_LINES }, callOptions());
        deps.showTranscript(`Transcript of "${job.name}"`, result.content || '(no output yet)');
      } catch (error) {
        toast(errorText(error), 'error');
      }
    },

    async approve(plan) {
      if (!plan.checkpoint && plan.status !== 'pending') {
        toast(`Plan "${plan.name}" has nothing to approve.`, 'warning');
        return;
      }
      const confirmed = await context.ui.dialog.confirm({
        title: plan.checkpoint ? `Approve checkpoint ${plan.checkpoint}?` : `Start plan "${plan.name}"?`,
        message: plan.checkpointMessage ?? `Plan "${plan.name}" continues once approved.`,
        label: { confirm: 'Approve', cancel: 'Cancel' },
      });
      if (!confirmed) return;
      const checkpoint =
        plan.checkpoint === 'pre_merge' || plan.checkpoint === 'on_error' || plan.checkpoint === 'pre_pr'
          ? plan.checkpoint
          : undefined;
      await run(() => rpc.approve(checkpoint ? { checkpoint } : {}, callOptions()));
    },

    async cancelPlan(plan) {
      const confirmed = await context.ui.dialog.confirm({
        title: `Cancel plan "${plan.name}"?`,
        message: 'All of its running jobs are stopped.',
        label: { confirm: 'Cancel plan', cancel: 'Keep running' },
      });
      if (!confirmed) return;
      await run(() => rpc.cancelPlan({}, callOptions()));
    },

    async launch() {
      const name = await context.ui.dialog.prompt({
        title: 'Launch job: name',
        description: 'Used for the branch (mc/<name>) and the session title.',
        placeholder: 'fix-login',
      });
      if (name === undefined) return;
      const invalid = validateJobName(name);
      if (invalid) {
        toast(invalid, 'error');
        return;
      }
      const prompt = await context.ui.dialog.prompt({
        title: `Launch job "${name.trim()}": task`,
        placeholder: 'What should the agent do?',
      });
      if (prompt === undefined || prompt.trim() === '') return;
      await run(() => rpc.launch({ name: name.trim(), prompt }, callOptions()));
    },

    pendingForm,

    syncForms(jobs) {
      for (const job of jobs) {
        if (job.status !== 'running' || !job.sessionID) continue;
        context.data.session.form.sync(job.sessionID, jobLocation(job)).catch((error: unknown) => {
          // A backstop only: jobs normally cannot open forms, and a job whose
          // session is gone simply has none to show.
          console.debug(`[Mission Control] Could not load forms of job "${job.name}":`, error);
        });
      }
    },
  };
}
