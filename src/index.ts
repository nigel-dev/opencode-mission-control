import { Plugin } from '@opencode/plugin';
import { getSharedMonitor, setSharedNotifyCallback, replaceSharedOrchestrator, disposeSharedState } from './lib/orchestrator-singleton';
import { getCompactionContext, getJobCompactionContext } from './hooks/compaction';
import { shouldShowAutoStatus, getAutoStatusMessage } from './hooks/auto-status';
import { setupNotifications, hasAnnotation, resetSessionTitle, isTitleResetSuppressed, ensureMCPrefix } from './hooks/notifications';
import { registerCommands } from './commands';
import { isJobSession, recordBackgroundWork, registerJobSession, setRuntimeClient } from './lib/job-runtime';
import { installPermissionGate } from './lib/job-permissions';
import { loadJobState } from './lib/job-state';
import { loadPlan } from './lib/plan-state';
import { loadConfig } from './lib/config';
import { clearProjectModels, setCurrentModelFromSDK, setConfigFallbackModel } from './lib/model-tracker';
import { canonicalPath } from './lib/paths';
import { isInManagedWorktree } from './lib/worktree';
import { missionControlRpc } from './rpc';
import { setToastEmitter, showToast } from './lib/toast';
import { emitChanged, setRpcEventEmitter } from './lib/rpc-events';
import { createJobAgentRpcHandlers, createRpcHandlers } from './lib/rpc-handlers';
import { bindToDirectory, bindToProject, registerProject, runInProject } from './lib/project-context';
import { mc_launch } from './tools/launch';
import { mc_jobs } from './tools/jobs';
import { mc_status } from './tools/status';
import { mc_diff } from './tools/diff';
import { mc_pr } from './tools/pr';
import { mc_merge } from './tools/merge';
import { mc_sync } from './tools/sync';
import { mc_cleanup } from './tools/cleanup';
import { mc_kill } from './tools/kill';
import { mc_attach } from './tools/attach';
import { mc_capture } from './tools/capture';
import { mc_plan } from './tools/plan';
import { mc_plan_status } from './tools/plan-status';
import { mc_plan_cancel } from './tools/plan-cancel';
import { mc_plan_approve } from './tools/plan-approve';
import { mc_report } from './tools/report';
import { mc_overview } from './tools/overview';
import { mc_answer } from './tools/answer';

const MONITOR_EVENTS = [
  'complete',
  'failed',
  'blocked',
  'needs_review',
  'awaiting_input',
  'agent_report',
  'question',
] as const;

interface SessionWithID {
  id?: string;
}

function isValidSessionID(id: string): boolean {
  return id.startsWith('ses');
}

function extractSessionIDFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') {
    return undefined;
  }

  const candidate = event as {
    sessionID?: string;
    sessionId?: string;
    session?: SessionWithID;
    data?: { sessionID?: string; sessionId?: string };
    properties?: {
      sessionID?: string;
      info?: SessionWithID;
    };
  };

  if (typeof candidate.sessionID === 'string' && isValidSessionID(candidate.sessionID)) {
    return candidate.sessionID;
  }

  if (typeof candidate.sessionId === 'string' && isValidSessionID(candidate.sessionId)) {
    return candidate.sessionId;
  }

  if (candidate.data) {
    if (typeof candidate.data.sessionID === 'string' && isValidSessionID(candidate.data.sessionID)) {
      return candidate.data.sessionID;
    }
    if (typeof candidate.data.sessionId === 'string' && isValidSessionID(candidate.data.sessionId)) {
      return candidate.data.sessionId;
    }
  }

  if (candidate.properties) {
    if (typeof candidate.properties.sessionID === 'string' && isValidSessionID(candidate.properties.sessionID)) {
      return candidate.properties.sessionID;
    }
    if (candidate.properties.info?.id && typeof candidate.properties.info.id === 'string' && isValidSessionID(candidate.properties.info.id)) {
      return candidate.properties.info.id;
    }
  }

  if (
    candidate.session &&
    typeof candidate.session.id === 'string' &&
    isValidSessionID(candidate.session.id)
  ) {
    return candidate.session.id;
  }

  return undefined;
}

function extractSessionIDFromListResult(listResult: unknown): string | undefined {
  const sources: unknown[] = [];

  if (Array.isArray(listResult)) {
    sources.push(...listResult);
  } else if (listResult && typeof listResult === 'object') {
    const container = listResult as {
      sessions?: unknown;
      items?: unknown;
      data?: unknown;
    };

    if (Array.isArray(container.sessions)) {
      sources.push(...container.sessions);
    }
    if (Array.isArray(container.items)) {
      sources.push(...container.items);
    }
    if (Array.isArray(container.data)) {
      sources.push(...container.data);
    }
  }

  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    const session = source as SessionWithID;
    if (typeof session.id === 'string' && isValidSessionID(session.id)) {
      return session.id;
    }
  }

  return undefined;
}

export default Plugin.define({
  id: 'opencode-mission-control',
  setup(ctx) {
    // In V2 the plugin runs inside the shared OpenCode server, whose process cwd
    // is unrelated to the project. Run everything in the instance's location.
    const cwd = ctx.location?.directory;
    if (!cwd) {
      throw new Error('Mission Control needs the plugin location to know which project it serves.');
    }
    return runInProject(cwd, () => setupInProject(ctx, cwd));
  },
});

async function setupInProject(ctx: Plugin.Context, cwd: string): Promise<() => void> {
  const worktreeInfo = await isInManagedWorktree(cwd);
  const isJobAgent = worktreeInfo.isManaged;

  // Jobs are sessions on this server: the plugin context is the client used to
  // create, prompt, watch and stop them. Set it before the monitor starts and
  // before any tool can run.
  setRuntimeClient(ctx);
  const unregisterProject = isJobAgent ? undefined : registerProject();

  if (!isJobAgent) {
    // Remember the sessions of existing jobs (finished ones included) so their
    // events are never attributed to the user's own session after a reload.
    try {
      for (const job of (await loadJobState()).jobs) {
        if (job.sessionID) {
          registerJobSession(job.sessionID);
        }
      }
    } catch (error) {
      console.warn('[Mission Control] Could not load existing jobs:', error);
    }
  }

  const monitor = getSharedMonitor();
  let activeSessionID: string | undefined;

  const getActiveSessionID = async (): Promise<string | undefined> => {
    if (activeSessionID) {
      return activeSessionID;
    }

    try {
      // No session has been seen yet: fall back to the project's most
      // recently used top-level session.
      const listResult = await ctx.session.list({ directory: cwd, parentID: null, order: 'desc', limit: 1 });
      activeSessionID = extractSessionIDFromListResult(listResult);
      return activeSessionID;
    } catch (error) {
      console.warn('[Mission Control] Could not list sessions to find the active one:', error);
      return undefined;
    }
  };

  if (!isJobAgent) {
    setupNotifications({
      client: ctx,
      monitor,
      getActiveSessionID,
    });
  }

  if (!isJobAgent) {
    let notifyPending: Promise<void> = Promise.resolve();
    setSharedNotifyCallback((message: string, targetSessionID?: string) => {
      notifyPending = notifyPending.then(async () => {
        const sessionID = targetSessionID ?? await getActiveSessionID();
        if (!sessionID || !isValidSessionID(sessionID)) return;
        await ctx.session.synthetic({ sessionID, text: message, resume: false });
      }).catch((error: unknown) => {
        // The session may be gone. One lost message must not stop later ones.
        console.warn('[Mission Control] Could not deliver a notification to its session:', error);
      });
    });
  }

  // Job agents get read-only handlers: jobs are managed from the command center.
  const rpcRegistration = await ctx.rpc.register(
    missionControlRpc,
    isJobAgent ? createJobAgentRpcHandlers() : createRpcHandlers(),
  );
  setToastEmitter(async (options) => {
    await rpcRegistration.events.emit('toast', {
      title: options.title ?? 'Mission Control',
      message: options.message,
      variant: options.variant ?? 'info',
      duration: options.duration ?? 5000,
    });
  });

  setRpcEventEmitter({
    changed: (data) => rpcRegistration.events.emit('changed', data),
    attention: (data) => rpcRegistration.events.emit('attention', data),
    open: (data) => rpcRegistration.events.emit('open', data),
    output: (data) => rpcRegistration.events.emit('output', data),
  });

  if (!isJobAgent) {
    // Every job event changes what a client shows for that job.
    for (const event of MONITOR_EVENTS) {
      monitor.on(event, () => emitChanged(event));
    }
    monitor.start();
  }

  if (!isJobAgent) {
    ctx.model.default().then((result) => {
      const model = result.data;
      if (model?.providerID && model?.modelID) {
        setConfigFallbackModel(`${model.providerID}/${model.modelID}`);
      }
    }).catch((error: unknown) => {
      // Only a fallback for jobs launched before any session reported its model.
      console.debug('[Mission Control] Could not read the default model:', error);
    });

    loadPlan().then(async (plan) => {
      // Terminal plans have nothing to resume, and a copilot plan that is
      // still pending waits for mc_plan_approve.
      const finished = !plan || plan.status === 'completed' || plan.status === 'failed' || plan.status === 'canceled';
      if (plan && !finished && !(plan.status === 'pending' && plan.mode === 'copilot')) {
        const config = await loadConfig();
        const orchestrator = await replaceSharedOrchestrator(config);
        await orchestrator.resumePlan();
      }
    }).catch((error: unknown) => {
      console.error('[Mission Control] Could not resume the active plan; run mc_plan_status to inspect it:', error);
    });
  }

  // Register slash commands
  if (!isJobAgent) {
    await registerCommands(ctx);
  }

  // Bind the plugin's location into mc_report. V2 tool execution does not
  // expose the session directory, and `opencode run` executes plugins in the
  // shared background service whose process.cwd() is not the job worktree.
  const reportTool = {
    ...mc_report,
    execute: (input: Parameters<typeof mc_report.execute>[0]) =>
      mc_report.execute(input, cwd),
  };

  // Register tools. The host replays this transform from its own context, so
  // bind each tool to the directory captured here rather than the ambient one.
  const bindTool = <T extends { execute: (...args: never[]) => unknown }>(tool: T): T =>
    ({ ...tool, execute: bindToDirectory(cwd, tool.execute) }) as T;

  // Tools that change job or plan state tell connected clients to refetch.
  const bindMutatingTool = <T extends { name: string; execute: (...args: never[]) => Promise<unknown> }>(tool: T): T => {
    const execute = tool.execute as (...args: unknown[]) => Promise<unknown>;
    const notifying = async (...args: unknown[]) => {
      try {
        return await execute(...args);
      } finally {
        emitChanged(tool.name);
      }
    };
    return { ...tool, execute: bindToDirectory(cwd, notifying) } as T;
  };

  await ctx.tool.transform((editor) => {
    if (isJobAgent) {
      editor.add(bindTool(reportTool));
      editor.add(bindTool(mc_status));
    } else {
      editor.add(bindMutatingTool(mc_launch));
      editor.add(bindTool(mc_jobs));
      editor.add(bindTool(mc_status));
      editor.add(bindTool(mc_diff));
      editor.add(bindTool(mc_pr));
      editor.add(bindMutatingTool(mc_merge));
      editor.add(bindMutatingTool(mc_sync));
      editor.add(bindMutatingTool(mc_cleanup));
      editor.add(bindMutatingTool(mc_kill));
      editor.add(bindTool(mc_attach));
      editor.add(bindTool(mc_capture));
      editor.add(bindMutatingTool(mc_plan));
      editor.add(bindTool(mc_plan_status));
      editor.add(bindMutatingTool(mc_plan_cancel));
      editor.add(bindMutatingTool(mc_plan_approve));
      editor.add(bindMutatingTool(reportTool));
      editor.add(bindTool(mc_overview));
      editor.add(bindMutatingTool(mc_answer));
    }
  });

  // Track session and reset annotated titles before tool execution
  await ctx.tool.hook('execute.before', bindToProject(async (hook) => {
    if (hook.sessionID && isValidSessionID(hook.sessionID)) {
      activeSessionID = hook.sessionID;
      if (hasAnnotation(hook.sessionID) && !isTitleResetSuppressed(hook.sessionID)) {
        // Title updates never reject (see notifications.ts).
        void resetSessionTitle(ctx, hook.sessionID);
      }
    }
    if (hook.tool?.startsWith('mc_')) {
      const sessionID = hook.sessionID ?? await getActiveSessionID();
      void ensureMCPrefix(ctx, sessionID);
    }
  }));

  // Track session and reset annotated titles on prompt
  await ctx.session.hook('prompt', bindToProject(async (input) => {
    if (input.sessionID && isValidSessionID(input.sessionID)) {
      activeSessionID = input.sessionID;
      if (hasAnnotation(input.sessionID) && !isTitleResetSuppressed(input.sessionID)) {
        void resetSessionTitle(ctx, input.sessionID);
      }
    }
  }));

  // Track the exact model used for each session (covers sessions where no
  // model-selected event was observed, e.g. the first request after load).
  await ctx.session.hook('context', bindToProject((event) => {
    if (isJobAgent) {
      // Jobs run unattended: an interactive question form would block the job
      // until someone opens its session. Jobs ask through mc_report instead.
      // A job's model is not tracked either: it must not become the default
      // for jobs launched later.
      delete event.tools.question;
      return;
    }
    setCurrentModelFromSDK(event.model, event.sessionID);
  }));

  if (isJobAgent) {
    // A session can go idle while a shell or subagent it started is still
    // running; that work wakes it again when it finishes. Tell the monitor,
    // so the idle turn is not taken for the end of the job.
    await ctx.session.hook('experimental.idle', bindToProject((event) => {
      const own = event.background.filter((work) => work.sessionID === event.sessionID);
      recordBackgroundWork(event.sessionID, own.length);
    }));
  }

  // The job's permission policy can only be applied from inside the job's own
  // location: see installPermissionGate.
  const disposePermissionGate = isJobAgent ? await installPermissionGate(ctx, cwd) : undefined;

  // Track the active session and model, and show auto-status, via events.
  // Job agents need none of that: jobs are watched from the command center.
  const abortController = new AbortController();
  if (!isJobAgent) {
    const location = canonicalPath(cwd);
    // Events are frequent and come from a handful of directories: resolve each once.
    const resolved = new Map<string, string>();
    const resolveDirectory = (directory: string): string => {
      let real = resolved.get(directory);
      if (real === undefined) {
        if (resolved.size >= 200) {
          resolved.clear();
        }
        real = canonicalPath(directory);
        resolved.set(directory, real);
      }
      return real;
    };
    const handleSessionEvent = async (event: unknown): Promise<void> => {
      // The stream carries every project's events. Sessions elsewhere (other
      // projects, job worktrees and the subagents jobs start there) are not
      // the session the user is working in here.
      const eventDirectory = (event as { location?: { directory?: string } }).location?.directory;
      if (eventDirectory && resolveDirectory(eventDirectory) !== location) {
        return;
      }

      const sessionID = extractSessionIDFromEvent(event);
      // Job sessions run on this same server and share its event stream. They
      // are watched by the monitor; here they must not be mistaken for the
      // session the user is working in (active session, model, auto-status).
      if (sessionID && isJobSession(sessionID)) {
        return;
      }
      if (sessionID) {
        activeSessionID = sessionID;
      }

      const type = (event as { type?: string }).type;

      if (type === 'session.model.selected') {
        const data = (event as { data?: { sessionID?: string; model?: { id: string; providerID: string } } }).data;
        if (data?.model) {
          setCurrentModelFromSDK(data.model, data.sessionID);
        }
      }

      // V2 emits `session.execution.succeeded` when a turn finishes; the
      // V1 `session.idle` event is not emitted by current V2 servers.
      if (type === 'session.idle' || type === 'session.execution.succeeded') {
        const shouldShow = await shouldShowAutoStatus(cwd);
        if (shouldShow) {
          const message = await getAutoStatusMessage();
          if (message) {
            await showToast({ title: 'Mission Control', message, variant: 'info', duration: 8000 });
          }
        }
      }
    };

    const subscription = (async () => {
      for await (const event of ctx.event.subscribe({ signal: abortController.signal })) {
        await runInProject(cwd, () => handleSessionEvent(event));
      }
    })();
    subscription.catch((error: unknown) => {
      if (!abortController.signal.aborted) {
        // Only conveniences depend on this stream (the session notifications
        // fall back to, the launching model, auto-status); jobs are watched
        // by the monitor's own subscription.
        console.warn('[Mission Control] The session event stream stopped:', error);
      }
    });
  }

  // Inject job context into compaction
  await ctx.session.hook('compaction', bindToProject(async (event) => {
    const context = await (isJobAgent
      ? getJobCompactionContext(cwd)
      : getCompactionContext());
    event.system.push({ type: 'text' as const, text: context });
  }));

  return bindToProject(() => {
    abortController.abort();
    disposePermissionGate?.();
    setToastEmitter(null);
    setRpcEventEmitter(null);
    disposeSharedState();
    clearProjectModels();
    setRuntimeClient(null);
    unregisterProject?.();
  });
}
