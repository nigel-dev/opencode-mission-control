import type { Plugin } from '@opencode-ai/plugin';
import { getSharedMonitor } from './lib/orchestrator-singleton';
import { getCompactionContext } from './hooks/compaction';
import { shouldShowAutoStatus, getAutoStatusMessage } from './hooks/auto-status';
import { setupNotifications } from './hooks/notifications';
import { registerCommands, createCommandHandler } from './commands';
import { isTmuxAvailable } from './lib/tmux';
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

function extractSessionIDFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') {
    return undefined;
  }

  const candidate = event as {
    sessionID?: string;
    sessionId?: string;
    session?: SessionWithID;
  };

  if (typeof candidate.sessionID === 'string' && candidate.sessionID.length > 0) {
    return candidate.sessionID;
  }

  if (typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0) {
    return candidate.sessionId;
  }

  if (
    candidate.session &&
    typeof candidate.session.id === 'string' &&
    candidate.session.id.length > 0
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
    if (typeof session.id === 'string' && session.id.length > 0) {
      return session.id;
    }
  }

  return undefined;
}

let tmuxAvailable = false;

export const MissionControl: Plugin = async ({ client }) => {
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

  setupNotifications({
    client,
    monitor,
    getActiveSessionID,
  });

  monitor.start();

  return {
    config: async (configInput: any) => {
      registerCommands(configInput);
    },
    'command.execute.before': createCommandHandler(client),
    tool: {
      mc_launch,
      mc_jobs,
      mc_status,
      mc_diff,
      mc_pr,
      mc_merge,
      mc_sync,
      mc_cleanup,
      mc_kill,
      mc_attach,
      mc_capture,
      mc_plan,
      mc_plan_status,
      mc_plan_cancel,
      mc_plan_approve,
      mc_report,
      mc_overview,
    },
    event: async ({ event }) => {
      const sessionID = extractSessionIDFromEvent(event);
      if (sessionID) {
        activeSessionID = sessionID;
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
      output.context.push(await getCompactionContext());
    },
  };
};

export default MissionControl;
