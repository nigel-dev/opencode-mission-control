import type { Plugin } from '@opencode-ai/plugin';
import { getSharedMonitor, setSharedNotifyCallback, getSharedNotifyCallback, setSharedOrchestrator } from './lib/orchestrator-singleton';
import { getCompactionContext, getJobCompactionContext } from './hooks/compaction';
import { shouldShowAutoStatus, getAutoStatusMessage } from './hooks/auto-status';
import { setupNotifications } from './hooks/notifications';
import { registerCommands, createCommandHandler } from './commands';
import { isTmuxAvailable } from './lib/tmux';
import { loadPlan } from './lib/plan-state';
import { Orchestrator } from './lib/orchestrator';
import { loadConfig } from './lib/config';
import { setCurrentModel, setConfigFallbackModel } from './lib/model-tracker';
import { isInManagedWorktree } from './lib/worktree';
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

let tmuxAvailable = false;

export const MissionControl: Plugin = async ({ client }) => {
  const cwd = process.cwd();
  const worktreeInfo = await isInManagedWorktree(cwd);
  const isJobAgent = worktreeInfo.isManaged;

  tmuxAvailable = await isTmuxAvailable();
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
      const listResult = await client.session.list();
      activeSessionID = extractSessionIDFromListResult(listResult);
      return activeSessionID;
    } catch {
      return undefined;
    }
  };

  // Detect if we're a subagent spawned by another OpenCode session
  let _isSubagentCached: boolean | null = null;
  const isSubagent = async (): Promise<boolean> => {
    if (_isSubagentCached !== null) return _isSubagentCached;
    try {
      const sessionID = await getActiveSessionID();
      if (!sessionID) {
        _isSubagentCached = false;
        return false;
      }
      const session = await client.session.get({ path: { id: sessionID } });
      const data = (session as any)?.data ?? session;
      _isSubagentCached = !!(data?.parentID || data?.parentId);
      return _isSubagentCached;
    } catch {
      _isSubagentCached = false;
      return false;
    }
  };

  if (!isJobAgent) {
    setupNotifications({
      client,
      monitor,
      getActiveSessionID,
      isSubagent,
    });
  }

  let notifyPending: Promise<void> = Promise.resolve();
  if (!isJobAgent) {
    setSharedNotifyCallback((message: string) => {
      notifyPending = notifyPending.then(async () => {
        const sessionID = await getActiveSessionID();
        if (!sessionID || !sessionID.startsWith('ses')) return;
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [{ type: 'text' as const, text: message }],
          },
        }).catch(() => {});
      }).catch(() => {});
    });
  }

  if (!isJobAgent) {
    monitor.start();
  }

  client.config.get().then((result) => {
    const config = result.data;
    if (config?.model) {
      setConfigFallbackModel(config.model);
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

  return {
    config: async (configInput: any) => {
      if (!isJobAgent) {
        registerCommands(configInput);
      }
    },
    'command.execute.before': (input: { command: string; sessionID: string; arguments: string }, output: { parts: unknown[] }) => {
      if (isValidSessionID(input.sessionID)) {
        activeSessionID = input.sessionID;
      }
      return createCommandHandler(client)(input, output);
    },
    'tool.execute.before': async (input: { sessionID?: string; [key: string]: unknown }) => {
      if (input.sessionID && isValidSessionID(input.sessionID)) {
        activeSessionID = input.sessionID;
      }
    },
    'chat.message': async (input) => {
      if (input.sessionID && isValidSessionID(input.sessionID)) {
        activeSessionID = input.sessionID;
      }
      if (input.model) {
        setCurrentModel(input.model, input.sessionID);
      }
    },
    'chat.params': async (input) => {
      if (input.sessionID && isValidSessionID(input.sessionID)) {
        activeSessionID = input.sessionID;
      }
      // chat.params fires for background LLM calls too (title gen, summarization)
      // which use smaller models — do not track model here, chat.message is authoritative
    },
    tool: isJobAgent 
      ? { mc_report, mc_status } as any
      : { mc_launch, mc_jobs, mc_status, mc_diff, mc_pr, mc_merge, mc_sync, mc_cleanup, mc_kill, mc_attach, mc_capture, mc_plan, mc_plan_status, mc_plan_cancel, mc_plan_approve, mc_report, mc_overview },
    event: async ({ event }) => {
      const sessionID = extractSessionIDFromEvent(event);
      if (sessionID) {
        activeSessionID = sessionID;
      }

      if (event.type === 'message.updated') {
        const messageEvent = event as {
          properties?: {
            info?: {
              role?: string;
              model?: { providerID: string; modelID: string };
              providerID?: string;
              modelID?: string;
            };
          };
        };
        const info = messageEvent.properties?.info;
        if (info?.model) {
          setCurrentModel(info.model, sessionID);
        } else if (info?.providerID && info?.modelID) {
          setCurrentModel({ providerID: info.providerID, modelID: info.modelID }, sessionID);
        }
      }

      if (event.type === 'session.idle') {
        const shouldShow = await shouldShowAutoStatus();
        if (shouldShow) {
          const message = await getAutoStatusMessage();
          if (message) {
            await client.tui.showToast({
              body: {
                title: 'Mission Control',
                message,
                variant: 'info',
                duration: 8000,
              },
            }).catch(() => {});
          }
        }
      }
    },
    // SDK uses proxies on hook output objects — must use in-place mutation
    // (push/splice). Direct reassignment (e.g. output.context = [...]) is
    // silently ignored. See: opencode Plugin.trigger() proxy semantics.
    'experimental.session.compacting': async (_input, output) => {
      output.context.push(await (isJobAgent ? getJobCompactionContext() : getCompactionContext()));
    },
  };
};

export default MissionControl;
