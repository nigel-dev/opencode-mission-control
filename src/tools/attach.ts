import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName } from '../lib/job-state';

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
