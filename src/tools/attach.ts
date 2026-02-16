import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName } from '../lib/job-state';
import { isInsideTmux, createWindow, getCurrentSession } from '../lib/tmux';

export const mc_attach: ToolDefinition = tool({
  description: 'Get instructions for attaching to a job\'s terminal',
  args: {
    name: tool.schema.string().describe('Job name'),
  },
  async execute(args) {
    const job = await getJobByName(args.name);

    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    // Check if this is a serve-mode job (has port/serverUrl)
    const isServeMode = job.port !== undefined && job.serverUrl !== undefined;

    if (isServeMode) {
      // Serve-mode job: open TUI in new tmux window if inside tmux, otherwise return command
      if (isInsideTmux()) {
        // Create new tmux window with opencode attach command
        const windowName = `mc-${job.name}`;
        const sessionFlag = job.remoteSessionID ? ` --session ${job.remoteSessionID}` : '';
        const attachCommand = `opencode attach ${job.serverUrl} --dir ${job.worktreePath}${sessionFlag}`;
        const currentSession = getCurrentSession();

        if (!currentSession) {
          return `Run: opencode attach ${job.serverUrl}`;
        }

        await createWindow({
          session: currentSession,
          name: windowName,
          workdir: job.worktreePath,
          command: attachCommand,
        });

        return `Opened TUI for job '${job.name}' in new tmux window`;
      } else {
        // Not inside tmux, return the command to run
        return `Run: opencode attach ${job.serverUrl}`;
      }
    }

    // TUI-mode job: preserve existing behavior (return tmux attach/select command)
    const lines: string[] = [
      `To attach to job "${args.name}":`,
      '',
    ];

    if (job.placement === 'session') {
      lines.push(`# Session mode:`);
      lines.push(`tmux attach -t ${job.tmuxTarget}`);
    } else {
      lines.push(`# Window mode (select window in current session):`);
      lines.push(`tmux select-window -t ${job.tmuxTarget}`);
    }

    lines.push('');
    lines.push('# To detach: Ctrl+B, D');

    return lines.join('\n');
  },
});
