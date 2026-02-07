import type { Plugin } from '@opencode-ai/plugin';
import { JobMonitor } from './lib/monitor';
import { getCompactionContext } from './hooks/compaction';
import { shouldShowAutoStatus, getAutoStatusMessage } from './hooks/auto-status';
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

export const MissionControl: Plugin = async (_input) => {
  const monitor = new JobMonitor();
  monitor.start();

  return {
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
    },
    event: async ({ event }) => {
      if (event.type === 'session.idle') {
        const shouldShow = await shouldShowAutoStatus();
        if (shouldShow) {
          const message = await getAutoStatusMessage();
          if (message) {
            console.log(message);
          }
        }
      }
    },
    'experimental.session.compacting': async (_input, output) => {
      output.context.push(await getCompactionContext());
    },
  };
};

export default MissionControl;
