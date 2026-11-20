import type { FormInfo } from '@opencode/client';
import type { PanelInput } from '@opencode/plugin/tui/context';
import type { Plugin as Tui } from '@opencode/plugin/tui';
import type { RGBA } from '@opentui/core';
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from 'solid-js';
import type { JobView, PlanView, Snapshot } from '../rpc';
import {
  DASHBOARD_COMMAND,
  DASHBOARD_PANEL,
  capJobs,
  footerSegments,
  isPlanActive,
  jobDetail,
  jobDetailRows,
  jobElapsed,
  jobIcon,
  jobLabel,
  jobTone,
  moveIndex,
  planJobIcon,
  planJobTone,
  planProgress,
  planSummary,
  sortJobs,
  truncate,
  type Tone,
} from './format';
import type { ViewFactory, ViewModel } from './setup';

type Theme = Tui.Context['theme'];

function toneColor(theme: Theme, tone: Tone): RGBA {
  switch (tone) {
    case 'info':
      return theme.text.feedback.info.base;
    case 'success':
      return theme.text.feedback.success.base;
    case 'warning':
      return theme.text.feedback.warning.base;
    case 'error':
      return theme.text.feedback.error.base;
    case 'muted':
      return theme.text.muted;
  }
}

interface ViewProps {
  model: ViewModel;
  snapshot: Accessor<Snapshot | null>;
}

function Footer(props: ViewProps) {
  const theme = () => props.model.context.theme;
  const segments = createMemo(() => footerSegments(props.snapshot()?.counts));

  return (
    <Show when={segments().length > 0}>
      <box
        flexDirection="row"
        gap={1}
        flexShrink={0}
        onMouseUp={() => props.model.context.keymap.dispatch(DASHBOARD_COMMAND)}
      >
        <text fg={theme().text.muted}>MC</text>
        <For each={segments()}>
          {(segment) => <text fg={toneColor(theme(), segment.tone)}>{segment.text}</text>}
        </For>
      </box>
    </Show>
  );
}

function Sidebar(props: ViewProps) {
  const theme = () => props.model.context.theme;
  const jobs = createMemo(() => capJobs(props.snapshot()?.jobs ?? []));
  const plan = createMemo(() => {
    const current = props.snapshot()?.plan;
    return current && isPlanActive(current) ? current : undefined;
  });

  return (
    <Show when={jobs().visible.length > 0 || plan()}>
      <box flexDirection="column">
        <box onMouseUp={() => props.model.context.keymap.dispatch(DASHBOARD_COMMAND)}>
          <text fg={theme().text.base}>
            <b>Mission Control</b>
          </text>
        </box>
        <Show when={plan()}>
          {(active: Accessor<PlanView>) => (
            <text fg={theme().text.muted} wrapMode="none" truncate>
              {planSummary(active())}
            </text>
          )}
        </Show>
        <For each={jobs().visible}>
          {(job) => (
            <box flexDirection="row" gap={1} onMouseUp={() => props.model.actions.openJob(job)}>
              <text flexShrink={0} fg={toneColor(theme(), jobTone(job))}>
                {jobIcon(job)}
              </text>
              <text flexShrink={0} fg={theme().text.base}>
                {truncate(job.name, 20)}
              </text>
              <text flexShrink={1} fg={theme().text.muted} wrapMode="none" truncate>
                {truncate(jobDetail(job), 40)}
              </text>
            </box>
          )}
        </For>
        <Show when={jobs().hidden > 0}>
          <text fg={theme().text.muted}>+{jobs().hidden} more</text>
        </Show>
      </box>
    </Show>
  );
}

function PlanSection(props: { theme: Theme; plan: PlanView }) {
  const progress = () => planProgress(props.plan);

  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={props.theme.text.base}>
        <b>Plan</b> {props.plan.name} [{props.plan.mode}] {props.plan.status} · {progress().merged}/
        {progress().total} merged
      </text>
      <Show when={props.plan.checkpoint}>
        <text fg={props.theme.text.feedback.warning.base}>
          ⚠ Checkpoint {props.plan.checkpoint}: {props.plan.checkpointMessage ?? 'waiting for approval'} (p to
          approve)
        </text>
      </Show>
      <Show when={props.plan.failureReason}>
        <text fg={toneColor(props.theme, 'error')}>✗ {props.plan.failureReason}</text>
      </Show>
      <Show when={props.plan.prUrl}>
        <text fg={props.theme.text.muted}>PR: {props.plan.prUrl}</text>
      </Show>
      <For each={props.plan.jobs}>
        {(job) => (
          <box flexDirection="row" gap={1} paddingLeft={2}>
            <text flexShrink={0} fg={toneColor(props.theme, planJobTone(job.status))}>
              {planJobIcon(job.status)}
            </text>
            <text flexShrink={0} fg={props.theme.text.base}>
              {job.name}
            </text>
            <text flexShrink={0} fg={props.theme.text.muted}>
              {job.status.replace(/_/g, ' ')}
            </text>
            <Show when={job.dependsOn.length > 0}>
              <text flexShrink={1} fg={props.theme.text.faint} wrapMode="none" truncate>
                ← {job.dependsOn.join(', ')}
              </text>
            </Show>
          </box>
        )}
      </For>
    </box>
  );
}

const HINTS =
  '↑↓ select · enter open · a answer · t transcript · x stop · d clean up · n launch · p approve · c cancel plan · r refresh · esc close';

function Dashboard(props: ViewProps & { close: () => void; panel?: PanelInput }) {
  const { context, actions, store } = props.model;
  const theme = () => context.theme;

  const [selectedName, setSelectedName] = createSignal<string>();
  const [now, setNow] = createSignal(Date.now());

  const jobs = createMemo(() => sortJobs(props.snapshot()?.jobs ?? []));
  const selectedIndex = createMemo(() => {
    const index = jobs().findIndex((job) => job.name === selectedName());
    return index < 0 ? 0 : index;
  });
  const selected = (): JobView | undefined => jobs()[selectedIndex()];
  const plan = (): PlanView | null => props.snapshot()?.plan ?? null;

  const move = (delta: number): void => {
    const next = jobs()[moveIndex(selectedIndex(), delta, jobs().length)];
    if (next) setSelectedName(next.name);
  };
  const onJob = (action: (job: JobView) => void | Promise<void>) => (): void => {
    const job = selected();
    if (job) void action(job);
  };
  const onPlan = (action: (plan: PlanView) => Promise<void>) => (): void => {
    const current = plan();
    if (current) {
      void action(current);
    } else {
      context.ui.toast.show({ title: 'Mission Control', message: 'There is no plan.', variant: 'warning' });
    }
  };

  // Single-key bindings: active only while the dashboard owns keyboard input.
  // As a session panel it shares the screen with the prompt, so the layer is
  // off unless the panel is focused; as a full page nothing else takes keys.
  // Removed with the component.
  context.keymap.layer(() => ({
    enabled: () => props.panel?.focused ?? true,
    commands: [
      { title: 'Previous job', bind: 'up', run: () => move(-1) },
      { title: 'Previous job', bind: 'k', run: () => move(-1) },
      { title: 'Next job', bind: 'down', run: () => move(1) },
      { title: 'Next job', bind: 'j', run: () => move(1) },
      { title: 'Open job session', bind: 'return', run: onJob(actions.openJob) },
      { title: 'Answer job', bind: 'a', run: onJob(actions.answer) },
      { title: 'View transcript', bind: 't', run: onJob(actions.transcript) },
      { title: 'Stop job', bind: 'x', run: onJob(actions.kill) },
      { title: 'Clean up job', bind: 'd', run: onJob(actions.cleanup) },
      { title: 'Launch job', bind: 'n', run: () => void actions.launch() },
      { title: 'Approve plan checkpoint', bind: 'p', run: onPlan(actions.approve) },
      { title: 'Cancel plan', bind: 'c', run: onPlan(actions.cancelPlan) },
      { title: 'Refresh', bind: 'r', run: () => void store.refresh() },
      { title: 'Close dashboard', bind: 'escape', run: () => props.close() },
      { title: 'Close dashboard', bind: 'q', run: () => props.close() },
    ],
  }));

  // Backstop: a job session that is waiting on a form shows it here.
  createEffect(() => actions.syncForms(jobs()));

  onMount(() => {
    void store.refresh();
    if (props.panel && !props.panel.focused) {
      props.panel.focus();
    }
  });

  const clock = setInterval(() => setNow(Date.now()), 30000);
  onCleanup(() => clearInterval(clock));

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      paddingX={1}
      gap={1}
      onMouseDown={() => {
        // Clicking the dashboard gives it the keyboard back from the prompt.
        if (props.panel && !props.panel.focused) props.panel.focus();
      }}
    >
      <text fg={theme().text.base}>
        <b>Mission Control</b>
      </text>
      <Show
        when={props.snapshot()}
        fallback={
          <text fg={theme().text.muted}>
            Mission Control is not available: the server part of the plugin is not loaded for this project.
          </text>
        }
      >
        <Show when={plan()}>{(current: Accessor<PlanView>) => <PlanSection theme={theme()} plan={current()} />}</Show>
        <Show
          when={jobs().length > 0}
          fallback={<text fg={theme().text.muted}>No jobs yet. Press n to launch one.</text>}
        >
          <scrollbox flexGrow={1} flexShrink={1}>
            <For each={jobs()}>
              {(job) => {
                const isSelected = () => selected()?.name === job.name;
                return (
                  <box
                    flexDirection="row"
                    gap={1}
                    backgroundColor={isSelected() ? theme().background.raised.base : undefined}
                    onMouseDown={() => setSelectedName(job.name)}
                  >
                    <text flexShrink={0} fg={theme().text.base}>
                      {isSelected() ? '›' : ' '}
                    </text>
                    <text flexShrink={0} fg={toneColor(theme(), jobTone(job))}>
                      {jobIcon(job)}
                    </text>
                    <text flexShrink={0} fg={theme().text.base}>
                      {job.name}
                    </text>
                    <text flexShrink={0} fg={toneColor(theme(), jobTone(job))}>
                      {jobLabel(job)}
                    </text>
                    <text flexShrink={0} fg={theme().text.muted}>
                      {jobElapsed(job, now())}
                    </text>
                    <Show when={actions.pendingForm(job)}>
                      <text flexShrink={0} fg={theme().text.feedback.warning.base}>
                        [form]
                      </text>
                    </Show>
                    <text flexShrink={1} fg={theme().text.muted} wrapMode="none" truncate>
                      {jobDetail(job)}
                    </text>
                  </box>
                );
              }}
            </For>
          </scrollbox>
          <Show when={selected()}>
            {(job: Accessor<JobView>) => (
              <box flexDirection="column" flexShrink={0}>
                <For each={jobDetailRows(job(), now())}>
                  {(row) => (
                    <box flexDirection="row" gap={1}>
                      <text flexShrink={0} width={9} fg={theme().text.muted}>
                        {row.label}
                      </text>
                      <text flexShrink={1} fg={theme().text.base}>
                        {row.value}
                      </text>
                    </box>
                  )}
                </For>
                <Show when={actions.pendingForm(job())}>
                  {(form: Accessor<FormInfo>) => (
                    <text fg={theme().text.feedback.warning.base}>
                      Waiting on a form: {form().title || 'question'} (a to answer)
                    </text>
                  )}
                </Show>
              </box>
            )}
          </Show>
        </Show>
      </Show>
      <text flexShrink={0} fg={theme().text.faint}>
        {HINTS}
      </text>
    </box>
  );
}

function Transcript(props: { context: Tui.Context; title: string; text: string }) {
  // Dialogs sit on a raised surface with its own resolved colors.
  const theme = () => props.context.theme.surface('dialog');

  return (
    <box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
      <text fg={theme().text.base}>
        <b>{props.title}</b>
      </text>
      <scrollbox maxHeight={24} stickyScroll stickyStart="bottom" focused>
        <text fg={theme().text.base}>{props.text}</text>
      </scrollbox>
      <text fg={theme().text.muted}>↑↓ scroll · esc close</text>
    </box>
  );
}

export const createViews: ViewFactory = (model) => {
  const { context, store } = model;
  const [snapshot, setSnapshot] = createSignal<Snapshot | null>(store.get());
  store.subscribe((next) => setSnapshot(() => next));

  return {
    footer: () => <Footer model={model} snapshot={snapshot} />,
    sidebar: () => <Sidebar model={model} snapshot={snapshot} />,
    panel: (panel) => (
      <Show when={panel.name === DASHBOARD_PANEL}>
        <Dashboard model={model} snapshot={snapshot} panel={panel} close={() => panel.close()} />
      </Show>
    ),
    page: () => (
      <Dashboard
        model={model}
        snapshot={snapshot}
        close={() => context.ui.router.navigate({ type: 'home' })}
      />
    ),
    showTranscript(title, text) {
      context.ui.dialog.show(() => <Transcript context={context} title={title} text={text} />);
      context.ui.dialog.set({ size: 'xlarge' });
    },
  };
};
