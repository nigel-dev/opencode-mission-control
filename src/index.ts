import { Plugin } from '@opencode/plugin';
import { getSharedMonitor, setSharedNotifyCallback, getSharedNotifyCallback, setSharedOrchestrator } from './lib/orchestrator-singleton';
import { getCompactionContext, getJobCompactionContext } from './hooks/compaction';
import { shouldShowAutoStatus, getAutoStatusMessage } from './hooks/auto-status';
import { setupNotifications, hasAnnotation, resetSessionTitle, isTitleResetSuppressed, ensureMCPrefix } from './hooks/notifications';
import { registerCommands } from './commands';
import { isTmuxAvailable } from './lib/tmux';
import { loadPlan } from './lib/plan-state';
import { Orchestrator } from './lib/orchestrator';
import { loadConfig } from './lib/config';
import { setCurrentModelFromSDK, setConfigFallbackModel } from './lib/model-tracker';
import { isInManagedWorktree } from './lib/worktree';
import { missionControlRpc, setToastEmitter, showToast } from './rpc';
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
  async setup(ctx) {
    // In V2 the plugin runs inside the OpenCode server, whose process cwd is not
    // guaranteed to match the project. Use the plugin instance location instead.
    const cwd = ctx.location?.directory ?? process.cwd();
    const worktreeInfo = await isInManagedWorktree(cwd);
    const isJobAgent = worktreeInfo.isManaged;

    const tmuxAvailable = await isTmuxAvailable();
    if (!tmuxAvailable) {
      console.warn('[Mission Control] tmux is not installed or not in PATH. Job launching will be unavailable.');
    }

    const monitor = getSharedMonitor();
    let activeSessionID: string | undefined;

    const getActiveSessionID = async (): Promise<string | undefined> => {
      if (activeSessionID) {
        return activeSessionID;
      }

      try {
        const listResult = await ctx.session.list(
          ctx.location?.directory ? { directory: ctx.location.directory } : undefined,
        );
        activeSessionID = extractSessionIDFromListResult(listResult);
        return activeSessionID;
      } catch {
        return undefined;
      }
    };

    // Detect if we're a subagent spawned by another OpenCode session
    let isSubagentCached: boolean | null = null;
    const isSubagent = async (): Promise<boolean> => {
      if (isSubagentCached !== null) return isSubagentCached;
      try {
        const sessionID = await getActiveSessionID();
        if (!sessionID) {
          isSubagentCached = false;
          return false;
        }
        const session = await ctx.session.get({ sessionID });
        isSubagentCached = !!session?.parentID;
        return isSubagentCached;
      } catch {
        isSubagentCached = false;
        return false;
      }
    };

    if (!isJobAgent) {
      setupNotifications({
        client: ctx,
        monitor,
        getActiveSessionID,
        isSubagent,
      });
    }

    if (!isJobAgent) {
      let notifyPending: Promise<void> = Promise.resolve();
      setSharedNotifyCallback((message: string, targetSessionID?: string) => {
        notifyPending = notifyPending.then(async () => {
          const sessionID = targetSessionID ?? await getActiveSessionID();
          if (!sessionID || !isValidSessionID(sessionID)) return;
          await ctx.session.synthetic({ sessionID, text: message, resume: false }).catch(() => {});
        }).catch(() => {});
      });
    }

    const rpcRegistration = await ctx.rpc.register(missionControlRpc, {});
    setToastEmitter(async (options) => {
      await rpcRegistration.events.emit('toast', {
        title: options.title ?? 'Mission Control',
        message: options.message,
        variant: options.variant ?? 'info',
        duration: options.duration ?? 5000,
      });
    });

    if (!isJobAgent) {
      monitor.start();
    }

    ctx.model.default().then((result) => {
      const model = result.data;
      if (model?.providerID && model?.modelID) {
        setConfigFallbackModel(`${model.providerID}/${model.modelID}`);
      }
    }).catch(() => {});

    if (!isJobAgent) {
      loadPlan().then(async (plan) => {
        if (plan && (plan.status === 'running' || plan.status === 'paused')) {
          const config = await loadConfig();
          const orchestrator = new Orchestrator(monitor, config, { notify: getSharedNotifyCallback() ?? undefined });
          setSharedOrchestrator(orchestrator);
          await orchestrator.resumePlan();
        }
      }).catch(() => {});
    }

    // Register slash commands
    if (!isJobAgent) {
      await registerCommands(ctx);
    }

    // Register tools
    await ctx.tool.transform((editor) => {
      if (isJobAgent) {
        editor.add(mc_report);
        editor.add(mc_status);
      } else {
        editor.add(mc_launch);
        editor.add(mc_jobs);
        editor.add(mc_status);
        editor.add(mc_diff);
        editor.add(mc_pr);
        editor.add(mc_merge);
        editor.add(mc_sync);
        editor.add(mc_cleanup);
        editor.add(mc_kill);
        editor.add(mc_attach);
        editor.add(mc_capture);
        editor.add(mc_plan);
        editor.add(mc_plan_status);
        editor.add(mc_plan_cancel);
        editor.add(mc_plan_approve);
        editor.add(mc_report);
        editor.add(mc_overview);
        editor.add(mc_answer);
      }
    });

    // Track session and reset annotated titles before tool execution
    await ctx.tool.hook('execute.before', async (hook) => {
      if (hook.sessionID && isValidSessionID(hook.sessionID)) {
        activeSessionID = hook.sessionID;
        if (hasAnnotation(hook.sessionID) && !isTitleResetSuppressed(hook.sessionID)) {
          resetSessionTitle(ctx, hook.sessionID).catch(() => {});
        }
      }
      if (hook.tool?.startsWith('mc_')) {
        const sessionID = hook.sessionID ?? await getActiveSessionID();
        ensureMCPrefix(ctx, sessionID).catch(() => {});
      }
    });

    // Track session and reset annotated titles on prompt
    await ctx.session.hook('prompt', async (input) => {
      if (input.sessionID && isValidSessionID(input.sessionID)) {
        activeSessionID = input.sessionID;
        if (hasAnnotation(input.sessionID) && !isTitleResetSuppressed(input.sessionID)) {
          resetSessionTitle(ctx, input.sessionID).catch(() => {});
        }
      }
    });

    // Track the exact model used for each session (covers sessions where no
    // model-selected event was observed, e.g. the first request after load).
    await ctx.session.hook('context', (event) => {
      setCurrentModelFromSDK(event.model, event.sessionID);
    });

    // Track model + show auto-status via events
    const abortController = new AbortController();
    const subscription = (async () => {
      for await (const event of ctx.event.subscribe({ signal: abortController.signal })) {
        const sessionID = extractSessionIDFromEvent(event);
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

        if (type === 'session.idle') {
          const shouldShow = await shouldShowAutoStatus(cwd);
          if (shouldShow) {
            const message = await getAutoStatusMessage();
            if (message) {
              await showToast({ title: 'Mission Control', message, variant: 'info', duration: 8000 });
            }
          }
        }
      }
    })();
    subscription.catch(() => {});

    // Inject job context into compaction
    await ctx.session.hook('compaction', async (event) => {
      const context = await (isJobAgent
        ? getJobCompactionContext(cwd)
        : getCompactionContext());
      event.system.push({ type: 'text' as const, text: context });
    });

    return () => {
      abortController.abort();
      setToastEmitter(null);
    };
  },
});
